// 业务逻辑：设置、库存增减（带流水，可撤销）、图纸、备份。
import * as db from './db.js';
import { PALETTE, isCode, codeCompare, setPalette, paletteEntries, DEFAULT_ENTRIES, DEFAULT_HEX, CODE_RE } from './palette.js';

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.5',
  gemini: 'gemini-3.8-flash',
};

export const DEFAULT_SETTINGS = {
  methods: {
    vlm: {
      enabled: false,
      provider: 'anthropic',        // anthropic | openai | gemini
      mode: 'direct',               // direct（手机直连）| proxy（Cloudflare Worker 代理）
      apiKeys: { anthropic: '', openai: '', gemini: '' },
      models: { ...DEFAULT_MODELS },
      workerUrl: '',
      workerToken: '',
      twoPass: true,                // 先定位清单、再放大读取
    },
    ocr: { enabled: false, engine: 'ppocr', basePath: './vendor/tesseract/' },
    text: { enabled: true },
  },
  defaultMethod: 'text',
  defaultThreshold: 100,
  lossPercent: 0,
  restockPresets: [100, 500, 1000],
  invSort: 'code',                  // 库存排序：code（色号）| asc（数量少→多）| desc（数量多→少）
  buildOrder: 'count',              // 拼的顺序：count（颗数多的先拼）| countAsc | code | list（清单顺序）
  buildShow: 'real',                // 选了颜色时板上：real（没拼的不画，像实物）| fade（三种深浅）
  buildSpot: false,                 // 高亮当前颜色（板子变暗，其他颜色变暗）
  dewatermark: true,                // 生成拼豆板时去水印（识别时不受水印影响）
  pegboards: [[52, 52], [78, 78], [104, 104]], // 常用拼豆板尺寸（列 × 行）
  cellModel: 'v6s',                 // 读拼豆板格子上的色号用的识字模型：v6s（高精度，PP-OCRv6 small）| v5m（标准，PP-OCRv5 mobile）
};

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined ? base : over;
}

let settingsCache = null;
export async function getSettings() {
  if (settingsCache) return settingsCache;
  const rec = await db.get('kv', 'settings');
  settingsCache = merge(structuredClone(DEFAULT_SETTINGS), rec?.value || {});
  return settingsCache;
}
export async function saveSettings(s) {
  settingsCache = s;
  await db.put('kv', { key: 'settings', value: s });
}

export const METHOD_NAMES = { vlm: '云端大模型', ocr: '离线 OCR', text: '实况文本 / 快捷指令' };

export function enabledMethods(s) {
  return ['vlm', 'ocr', 'text'].filter(m => s.methods[m].enabled);
}

// ---------- 库存 ----------

export async function getInventory() {
  const all = await db.getAll('colors');
  return new Map(all.map(r => [r.code, r]));
}

export function stockOf(inv, code) { return inv.get(code)?.stock ?? 0; }

export function thresholdOf(inv, code, settings) {
  const t = inv.get(code)?.threshold;
  return t == null || t === '' ? settings.defaultThreshold : t;
}

/** 需要颗数 = 图纸数量 ×（1 + 损耗%），向上取整 */
export function needOf(count, settings) {
  return Math.ceil(count * (1 + (Number(settings.lossPercent) || 0) / 100));
}

/**
 * 预览：每个色号 需要 / 现有 / 拼后剩余 / 状态
 * status: 'short'（不够）| 'low'（够，但拼完低于阈值）| 'ok'
 */
export function previewRows(items, inv, settings) {
  const merged = new Map();
  for (const it of items) merged.set(it.code, (merged.get(it.code) || 0) + it.count);
  const rows = [...merged].map(([code, count]) => {
    const need = needOf(count, settings);
    const stock = stockOf(inv, code);
    const after = stock - need;
    const threshold = thresholdOf(inv, code, settings);
    const status = after < 0 ? 'short' : after < threshold ? 'low' : 'ok';
    return { code, count, need, stock, after, threshold, status };
  });
  const order = { short: 0, low: 1, ok: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || codeCompare(a.code, b.code));
  return rows;
}

/** 低于阈值的颜色（用于“待补货”） */
export function lowStockList(inv, settings, onlyOwned = false) {
  const out = [];
  for (const code of PALETTE.keys()) {
    const rec = inv.get(code);
    if (onlyOwned && !rec) continue;
    if (!rec) continue; // 从没录入过的颜色不算“待补货”
    const stock = rec.stock ?? 0;
    const threshold = thresholdOf(inv, code, settings);
    if (stock < threshold) out.push({ code, stock, threshold });
  }
  return out;
}

/**
 * 原子地改库存并记一条流水。
 * changes: [{ code, delta }]（加减）或 [{ code, set }]（设为）
 * 如果 forbidNegative 且有颜色会变成负数，整笔操作取消并抛错（err.shortages 列出缺口）。
 */
export async function applyChanges(changesIn, { type, note = '', patternId = null, forbidNegative = false, clampZero = false, patternPatch = null, extra = {} } = {}) {
  const time = Date.now();
  // 同一色号出现多次时合并
  const byCode = new Map();
  for (const ch of changesIn) {
    const prev = byCode.get(ch.code);
    if (ch.set != null) byCode.set(ch.code, { code: ch.code, set: ch.set });
    else if (prev && prev.set != null) prev.set += ch.delta;
    else byCode.set(ch.code, { code: ch.code, delta: (prev?.delta || 0) + ch.delta });
  }
  const changes = [...byCode.values()];
  return db.transaction(['colors', 'transactions', 'patterns'], (t, done, abort) => {
    const cs = t.objectStore('colors');
    const deltas = [];
    let pending = changes.length;
    const shortages = [];
    if (!pending) { abort(new Error('没有要修改的颜色')); return; }
    const finish = () => {
      if (shortages.length && forbidNegative) {
        const e = new Error('库存不足：' + shortages.map(s => `${s.code} 缺 ${-s.after}`).join('，'));
        e.shortages = shortages;
        abort(e);
        return;
      }
      for (const d of deltas) {
        cs.put({ ...d.rec, code: d.code, stock: d.after, updatedAt: time });
      }
      const txRec = {
        time, type, note, patternId,
        deltas: deltas.map(d => ({ code: d.code, delta: d.after - d.before, before: d.before, after: d.after })),
        ...extra,
      };
      const r = t.objectStore('transactions').add(txRec);
      r.onsuccess = () => {
        done(r.result);
        if (patternId != null && (patternPatch || type === 'consume')) {
          const ps = t.objectStore('patterns');
          const g = ps.get(patternId);
          g.onsuccess = () => {
            if (!g.result) return;
            const txDeltas = deltas.map(d => ({ code: d.code, delta: d.after - d.before }));
            ps.put(patternPatch ? patternPatch(g.result, r.result, time, txDeltas) : { ...g.result, status: 'done', txId: r.result, doneAt: time });
          };
        }
      };
    };
    for (const ch of changes) {
      if (!isCode(ch.code)) { abort(new Error(`未知色号 ${ch.code}`)); return; }
      const g = cs.get(ch.code);
      g.onsuccess = () => {
        const rec = g.result || { code: ch.code, stock: 0, threshold: null };
        const before = rec.stock ?? 0;
        let after = ch.set != null ? Math.max(0, Math.round(ch.set)) : before + Math.round(ch.delta);
        if (clampZero && after < 0 && before >= 0) after = 0; // 库存记录比实际少：扣到 0 为止
        if (after < 0) shortages.push({ code: ch.code, before, after });
        deltas.push({ code: ch.code, rec, before, after });
        if (--pending === 0) finish();
      };
    }
  });
}

/** 确认拼豆：按图纸扣库存。不够就整笔取消。 */
export async function commitPattern(patternId, rows) {
  return applyChanges(rows.map(r => ({ code: r.code, delta: -r.need })), {
    type: 'consume', patternId, forbidNegative: true,
  });
}

/** 撤销一笔流水（把它的变化反向加回去） */
export async function undoTransaction(txId) {
  const tx = await db.get('transactions', txId);
  if (!tx) throw new Error('找不到这笔记录');
  if (tx.undone) throw new Error('这笔记录已经撤销过了');
  const id = await applyChanges(tx.deltas.map(d => ({ code: d.code, delta: -d.delta })), {
    type: 'undo', note: `撤销：${txLabel(tx)}`, extra: { undoOf: txId },
  });
  await db.put('transactions', { ...tx, undone: true, undoneBy: id });
  if (tx.patternId != null) {
    const p = await db.get('patterns', tx.patternId);
    if (p) await db.put('patterns', patternAfterUndo(p, tx));
  }
  return id;
}

export async function setThreshold(code, threshold) {
  const rec = (await db.get('colors', code)) || { code, stock: 0 };
  await db.put('colors', { ...rec, threshold: threshold === '' || threshold == null ? null : Math.max(0, Math.round(threshold)), updatedAt: Date.now() });
}

export const TX_TYPES = { consume: '拼豆扣减', restock: '补货', adjust: '手动调整', undo: '撤销', import: '批量录入' };

export function txLabel(tx) {
  const n = tx.deltas.reduce((s, d) => s + d.delta, 0);
  return `${TX_TYPES[tx.type] || tx.type}${tx.note ? ' · ' + tx.note : ''}（${tx.deltas.length} 色，${n > 0 ? '+' : ''}${n} 颗）`;
}

export async function listTransactions() {
  const all = await db.getAll('transactions');
  return all.sort((a, b) => b.time - a.time);
}

// ---------- 图纸 ----------
// 图纸：{ id, name, tags:[], status:'pending'|'building'|'done', items:[{code,count}], images, imageIds, thumbs,
//         board?:{ rows, cols, codes, cells, stats, ... }  拼豆板（数字化的网格）
//         build?:{ startedAt, done:[色号], deducted:{色号:已扣颗数}, txIds:[], finishedAt, partial } 拼豆进度,
//         history?:[{ startedAt, endedAt, done, deducted, txIds }] 中途放弃的几次（图纸已放回待拼） }

/** 撤销某笔扣减后，图纸回到什么状态 */
function patternAfterUndo(p, tx) {
  const b = p.build;
  if (b && (b.txIds || []).includes(tx.id)) {
    const deducted = { ...(b.deducted || {}) };
    for (const d of tx.deltas) deducted[d.code] = Math.max(0, (deducted[d.code] || 0) + d.delta); // delta 是负数
    const txIds = b.txIds.filter(x => x !== tx.id);
    // 打勾保留（多半是误点了“拼好”想撤回），只是库存加回来、图纸回到“拼豆中”
    return { ...p, status: 'building', txId: null, doneAt: null, build: { ...b, deducted, txIds, finishedAt: null, partial: false } };
  }
  return { ...p, status: p.build ? 'building' : 'pending', txId: null, doneAt: null };
}

/** 是不是用拼豆板拼的：生成了拼豆板、摆好了位置（没选“不用拼豆板”） */
export function usesBoard(p) {
  return !!(p?.board?.place && typeof p.board.cells === 'string' && !p.boardSkip);
}

/** 拼豆板上每种颜色几颗（cells 是压成字符串的，见 board.js packCells） */
export function boardBeadCounts(board) {
  const m = new Map(), s = board.cells;
  for (let i = 0; i < s.length; i++) {
    const v = s.charCodeAt(i) - 48;
    if (v > 0) { const c = board.codes[v - 1]; m.set(c, (m.get(c) || 0) + 1); }
  }
  return m;
}

/**
 * 这幅图每种颜色用多少颗（Map 色号 → 颗数）：
 *   用拼豆板拼的 → 拼豆板上的颗数（和清单不一样时以拼豆板为准：照着拼豆板拼，用掉的就是板上的豆子）；
 *   没用拼豆板（或者 byList）→ 清单上的数量。
 */
export function beadCounts(p, { byList = false } = {}) {
  const list = new Map();
  for (const it of p.items) list.set(it.code, (list.get(it.code) || 0) + it.count);
  if (byList || !usesBoard(p)) return list;
  const onBoard = boardBeadCounts(p.board), out = new Map();
  for (const c of list.keys()) out.set(c, onBoard.get(c) || 0);
  for (const [c, n] of onBoard) if (!out.has(c)) out.set(c, n);
  return out;
}

/** 这幅图每种颜色还要扣多少（需要 − 已扣）。需要 = beadCounts（拼豆板 / 清单）× 损耗 */
export function remainingNeed(p, settings, { byList = false } = {}) {
  const ded = p.build?.deducted || {};
  return [...beadCounts(p, { byList })].map(([code, count]) => ({ code, count, need: needOf(count, settings), deducted: ded[code] || 0 }))
    .map(r => ({ ...r, left: Math.max(0, r.need - r.deducted) }));
}

/** 拼豆板上和清单颗数不一样的颜色：[{ code, list, board }]（没用拼豆板时为空） */
export function boardListDiff(p) {
  if (!usesBoard(p)) return [];
  const list = beadCounts(p, { byList: true }), onBoard = beadCounts(p);
  return [...onBoard].filter(([c, n]) => (list.get(c) || 0) !== n).map(([code, n]) => ({ code, list: list.get(code) || 0, board: n }));
}

export async function patchPattern(id, patch) {
  const p = await db.get('patterns', id);
  if (!p) throw new Error('图纸不存在了');
  const np = typeof patch === 'function' ? patch(p) : { ...p, ...patch };
  await db.put('patterns', np);
  return np;
}

/** 所有分类（按使用次数、名字排序） */
export async function allTags() {
  const n = new Map();
  for (const p of await db.getAll('patterns')) for (const t of p.tags || []) n.set(t, (n.get(t) || 0) + 1);
  const extra = (await db.get('kv', 'tags'))?.value || [];
  for (const t of extra) if (!n.has(t)) n.set(t, 0);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([t, c]) => ({ tag: t, count: c }));
}
/** 新建一个分类（还没有图纸用它时也要记住） */
export async function addTag(tag) {
  const cur = (await db.get('kv', 'tags'))?.value || [];
  if (!cur.includes(tag)) await db.put('kv', { key: 'tags', value: [...cur, tag] });
}
export async function renameTag(oldTag, newTag) {
  newTag = newTag.trim();
  if (!newTag || newTag === oldTag) return;
  for (const p of await db.getAll('patterns')) {
    if ((p.tags || []).includes(oldTag)) await db.put('patterns', { ...p, tags: [...new Set(p.tags.map(t => (t === oldTag ? newTag : t)))] });
  }
  const cur = (await db.get('kv', 'tags'))?.value || [];
  await db.put('kv', { key: 'tags', value: [...new Set(cur.map(t => (t === oldTag ? newTag : t)))] });
}
export async function deleteTag(tag) {
  for (const p of await db.getAll('patterns')) {
    if ((p.tags || []).includes(tag)) await db.put('patterns', { ...p, tags: p.tags.filter(t => t !== tag) });
  }
  const cur = (await db.get('kv', 'tags'))?.value || [];
  await db.put('kv', { key: 'tags', value: cur.filter(t => t !== tag) });
}

/** 复制一份图纸（再拼一次）：颜色、原图、拼豆板、分类都带上，进度清空 */
export async function duplicatePattern(id, name) {
  const p = await db.get('patterns', id);
  if (!p) throw new Error('图纸不存在了');
  const { id: _, txId, doneAt, build, ...rest } = p;
  return savePattern({ ...rest, name: name || `${p.name}（再拼）`, status: 'pending', createdAt: Date.now() });
}

// ---------- 拼豆 ----------

export async function startBuild(id) {
  return patchPattern(id, p => ({
    ...p, status: p.status === 'done' ? p.status : 'building',
    build: p.build || { startedAt: Date.now(), done: [], deducted: {}, txIds: [] },
  }));
}

export async function setColorDone(id, code, done) {
  return patchPattern(id, p => {
    const b = p.build || { startedAt: Date.now(), done: [], deducted: {}, txIds: [] };
    const set = new Set(b.done);
    if (done) set.add(code); else set.delete(code);
    return { ...p, status: p.status === 'done' ? p.status : 'building', build: { ...b, done: [...set] } };
  });
}

/** 还算不算“开始拼了”：打过勾，或者扣过库存（没撤销） */
export function buildTouched(p) {
  return !!(p.build && ((p.build.done || []).length || Object.values(p.build.deducted || {}).some(n => n > 0)));
}

/**
 * 撤回为“待拼”（点错了开始拼豆 / 想以后再拼）：像没开始过一样——打的勾清空；
 * 这次拼豆扣过的库存全部加回来（每笔扣减记一笔“撤销”流水）。拼豆板和摆放位置保留。
 */
export async function revertToPending(id) {
  const p = await db.get('patterns', id);
  if (!p) throw new Error('图纸不存在了');
  if (p.status !== 'building') throw new Error('只有“拼豆中”的图纸可以撤回');
  for (const txId of [...(p.build?.txIds || [])].reverse()) {
    const tx = await db.get('transactions', txId);
    if (tx && !tx.undone) await undoTransaction(txId);
  }
  return patchPattern(id, q => ({ ...q, build: null, status: 'pending', txId: null, doneAt: null }));
}

/**
 * 结算：把这些颗数从库存扣掉，记一笔流水，更新拼豆进度。
 * amounts: { 色号: 颗数 }；finish=true 表示这幅图结束了（全部拼好，或不拼了）
 */
export async function settleBuild(id, amounts, { finish = false, partial = false, abandon = false, note = '' } = {}) {
  const changes = Object.entries(amounts).filter(([, n]) => n > 0).map(([code, n]) => ({ code, delta: -n }));
  const patch = (p, txId, time, txDeltas) => {
    const b = p.build || { startedAt: time, done: [], deducted: {}, txIds: [] };
    const deducted = { ...(b.deducted || {}) };
    for (const d of txDeltas) deducted[d.code] = (deducted[d.code] || 0) - d.delta;
    const nb = { ...b, deducted, txIds: txId != null ? [...(b.txIds || []), txId] : (b.txIds || []) };
    if (abandon) {
      // 这次不拼了：扣掉的就扣掉了（记在历史里），图纸放回“待拼”，下次开始拼豆是全新的一次
      const hist = { startedAt: nb.startedAt, endedAt: time, done: nb.done || [], deducted, txIds: nb.txIds };
      return { ...p, build: null, status: 'pending', txId: null, doneAt: null, history: [...(p.history || []), hist] };
    }
    if (finish) Object.assign(nb, { finishedAt: time, partial });
    return { ...p, build: nb, status: finish ? 'done' : 'building', txId, doneAt: finish ? time : p.doneAt || null };
  };
  if (!changes.length) {
    // 什么都不用扣（比如全都已经扣过了）：只改状态
    return patchPattern(id, p => patch(p, null, Date.now(), [])).then(() => null);
  }
  return applyChanges(changes, { type: 'consume', patternId: id, clampZero: true, patternPatch: patch, note });
}

export async function savePattern(p) {
  const rec = { createdAt: Date.now(), status: 'pending', ...p };
  const id = await db.put('patterns', rec);
  return id;
}
export async function getPattern(id) { return db.get('patterns', id); }
export async function updatePattern(p) { return db.put('patterns', p); }
export async function listPatterns() {
  const all = await db.getAll('patterns');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function deletePattern(id) {
  const p = await db.get('patterns', id);
  await db.del('patterns', id);
  await deleteImagesIfUnused(p?.imageIds || []);
}

// ---------- 图纸原图 ----------

let imgSeq = 0;
// 本次打开 App 后新存的原图：识别还没结束、还没写进核对进度时，别被清理掉
const freshImages = new Set();

/** 保存一张原图，返回 id */
export async function putImage({ dataUrl, w, h, name = '' }) {
  const id = `img${Date.now().toString(36)}${(imgSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await db.put('images', { id, dataUrl, w, h, name, createdAt: Date.now() });
  freshImages.add(id);
  return id;
}
export async function getImage(id) { return id ? db.get('images', id) : null; }

/** 核对会话里用到的原图 id */
export function sessionImageIds(s) {
  return (s?.images || []).map(im => im.fullId).filter(Boolean);
}

async function usedImageIds() {
  const used = new Set();
  for (const p of await db.getAll('patterns')) for (const id of p.imageIds || []) used.add(id);
  for (const id of sessionImageIds(await loadSession())) used.add(id);
  return used;
}

/** 删掉这些原图（仍被某张图纸或未完成的核对用着的除外） */
export async function deleteImagesIfUnused(ids) {
  if (!ids?.length) return;
  try {
    const used = await usedImageIds();
    for (const id of ids) {
      freshImages.delete(id);
      if (!used.has(id)) await db.del('images', id);
    }
  } catch (e) { console.warn('删除原图失败', e); }
}

/** 原图占用：{ count, bytes } */
export async function imageStats() {
  let count = 0, bytes = 0;
  await db.forEach('images', im => { count++; bytes += Math.round((im.dataUrl?.length || 0) * 0.75); });
  return { count, bytes };
}

/** 启动时清理没人用的原图：既不属于任何图纸，也不属于未完成的核对 */
export async function gcImages() {
  try {
    const used = await usedImageIds();
    for (const id of await db.getAllKeys('images')) {
      if (!used.has(id) && !freshImages.has(id)) await db.del('images', id);
    }
  } catch (e) { console.warn('清理原图失败', e); }
}

// ---------- 未完成的核对（防止切到相册看原图时 App 被系统回收） ----------

export async function saveSession(s) { await db.put('kv', { key: 'session', value: s }); }
export async function loadSession() { return (await db.get('kv', 'session'))?.value || null; }
export async function clearSession() { await db.del('kv', 'session'); }

// ---------- 色卡（可自定义） ----------

/** 启动时载入自定义色卡（没有就用内置的） */
export async function loadPalette() {
  try {
    const rec = await db.get('kv', 'palette');
    setPalette(rec?.value?.entries?.length ? rec.value.entries : DEFAULT_ENTRIES);
  } catch { setPalette(DEFAULT_ENTRIES); }
}

async function persistPalette() {
  await db.put('kv', { key: 'palette', value: { entries: paletteEntries(), updatedAt: Date.now() } });
}

/** 和内置色卡相比：新增 / 改了颜色 / 删掉 的色号 */
export function paletteDiff() {
  const added = [], changed = [], removed = [];
  for (const [code, p] of PALETTE) {
    if (!DEFAULT_HEX.has(code)) added.push(code);
    else if (DEFAULT_HEX.get(code) !== p.hex) changed.push(code);
  }
  for (const code of DEFAULT_HEX.keys()) if (!PALETTE.has(code)) removed.push(code);
  return { added, changed, removed, custom: added.length + changed.length + removed.length > 0 };
}

/**
 * 新增或修改一个颜色。改色号时，库存记录会跟着搬到新色号。
 * { oldCode?, code, hex, name? }
 */
export async function upsertColor({ oldCode = null, code, hex, name = '' }) {
  code = String(code || '').trim().toUpperCase();
  hex = String(hex || '').trim().toUpperCase();
  if (!hex.startsWith('#')) hex = '#' + hex;
  if (!CODE_RE.test(code)) throw new Error('色号格式不对：应为 1–3 个字母 + 1–3 位数字，如 H7、P23、ZG1');
  if (!/^#[0-9A-F]{6}$/.test(hex)) throw new Error('颜色格式不对：应为 #RRGGBB，如 #FF8800');
  if (code !== oldCode && PALETTE.has(code)) throw new Error(`色号 ${code} 已经存在`);
  const entries = paletteEntries().filter(e => e.code !== oldCode && e.code !== code);
  entries.push({ code, hex, ...(name ? { name } : {}) });
  if (oldCode && oldCode !== code) {
    const rec = await db.get('colors', oldCode);
    if (rec) {
      const exist = await db.get('colors', code);
      await db.put('colors', { ...rec, code, stock: (rec.stock || 0) + (exist?.stock || 0), updatedAt: Date.now() });
      await db.del('colors', oldCode);
      await db.put('transactions', {
        time: Date.now(), type: 'adjust', note: `色号改名 ${oldCode} → ${code}`,
        deltas: [{ code: oldCode, delta: -(rec.stock || 0), before: rec.stock || 0, after: 0 }, { code, delta: rec.stock || 0, before: exist?.stock || 0, after: (rec.stock || 0) + (exist?.stock || 0) }],
      });
    }
  }
  setPalette(entries);
  await persistPalette();
  return code;
}

/** 删除颜色；库存里有这个色号的记录会一起删除（记一条流水） */
export async function deleteColor(code) {
  const rec = await db.get('colors', code);
  if (rec) {
    await db.del('colors', code);
    if (rec.stock) {
      await db.put('transactions', {
        time: Date.now(), type: 'adjust', note: `删除色号 ${code}`,
        deltas: [{ code, delta: -rec.stock, before: rec.stock, after: 0 }],
      });
    }
  }
  setPalette(paletteEntries().filter(e => e.code !== code));
  await persistPalette();
}

/**
 * 批量新增/修改：lines 形如 “ZG1 #DAABB3 名称”。
 * 返回 { added, updated, errors }
 */
export async function importPaletteText(text) {
  const map = new Map(paletteEntries().map(e => [e.code, e]));
  let added = 0, updated = 0;
  const errors = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#!')) continue;
    const m = line.match(/^([A-Za-z]{1,3}\d{1,3})[\s,，:：=]+#?([0-9A-Fa-f]{6})\b\s*(.*)$/);
    if (!m) { errors.push(line); continue; }
    const code = m[1].toUpperCase(), hex = '#' + m[2].toUpperCase(), name = m[3].trim();
    if (map.has(code)) { if (map.get(code).hex !== hex || (name && map.get(code).name !== name)) updated++; }
    else added++;
    map.set(code, { code, hex, ...(name ? { name } : map.get(code)?.name ? { name: map.get(code).name } : {}) });
  }
  if (added || updated) {
    setPalette([...map.values()]);
    await persistPalette();
  }
  return { added, updated, errors };
}

export function paletteText() {
  return paletteEntries().map(e => `${e.code} ${e.hex}${e.name ? ' ' + e.name : ''}`).join('\n');
}

/** 恢复内置色卡。自定义新增的色号若有库存，不会删除库存记录（只是色卡里看不到） */
export async function resetPalette() {
  await db.del('kv', 'palette');
  setPalette(DEFAULT_ENTRIES);
}

/** 某个色号当前的库存（用于删除/改名前提示） */
export async function stockRecord(code) { return db.get('colors', code); }

// ---------- 备份 ----------

export async function exportData({ includeSecrets = false, includeImages = false } = {}) {
  const settings = structuredClone(await getSettings());
  if (!includeSecrets) {
    settings.methods.vlm.apiKeys = { anthropic: '', openai: '', gemini: '' };
    settings.methods.vlm.workerToken = '';
  }
  return {
    app: 'pindou-counter', version: 1, exportedAt: new Date().toISOString(),
    colors: await db.getAll('colors'),
    palette: paletteDiff().custom ? paletteEntries() : null,
    patterns: await db.getAll('patterns'),
    transactions: await db.getAll('transactions'),
    images: includeImages ? await db.getAll('images') : [],
    settings,
  };
}

export async function importData(data) {
  if (!data || data.app !== 'pindou-counter') throw new Error('这不是拼豆计数器的备份文件');
  const current = await getSettings();
  await db.clearAll();
  if (Array.isArray(data.palette) && data.palette.length) {
    setPalette(data.palette);
    await persistPalette();
  } else setPalette(DEFAULT_ENTRIES);
  for (const c of data.colors || []) await db.put('colors', c);
  for (const p of data.patterns || []) await db.put('patterns', p);
  for (const t of data.transactions || []) await db.put('transactions', t);
  for (const im of data.images || []) await db.put('images', im);
  const s = merge(structuredClone(DEFAULT_SETTINGS), data.settings || {});
  // 备份里没带密钥时，保留当前手机上的密钥
  const v = s.methods.vlm, cv = current.methods.vlm;
  for (const k of Object.keys(v.apiKeys)) if (!v.apiKeys[k]) v.apiKeys[k] = cv.apiKeys[k] || '';
  if (!v.workerToken) v.workerToken = cv.workerToken || '';
  await saveSettings(s);
}

export async function resetAll() {
  await db.clearAll();
  settingsCache = null;
  setPalette(DEFAULT_ENTRIES);
}
