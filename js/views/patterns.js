// “图纸”标签：图纸库（搜索 / 按状态和分类筛选 / 多选算合计、多选删除）→ 图纸详情 → 开始拼豆。
import { h, clear, toast, sheet, confirmDialog, chip, fmtNum, fmtTime, copyText, inputSheet } from '../ui.js';
import * as store from '../store.js';
import { newId } from '../extract/index.js';
import { openImageViewer, entriesFromImages } from '../viewer.js';
import { renderRecognize } from './recognize.js';
import { renderBuild } from './build.js';

// q：搜索词；status：状态筛选；tags：选中的分类（同时满足）；select：多选模式下选中的图纸 id
const ui = { q: '', status: 'all', tags: new Set(), select: null, copies: new Map(), filter: 'all', open: null };
export const STATUS = { pending: ['待拼', 'accent'], building: ['拼豆中', 'warn'], done: ['已拼', 'ok'] };

/** 回到图纸列表（切换标签、再点一次“图纸”时） */
export function resetPatternsUI() {
  ui.select = null; ui.open = null;
}

export function goPattern(app, id, page = 'detail') {
  app.pat.page = page; app.pat.id = id;
  app.tab = 'patterns';
  return app.render();
}

export async function renderPatterns(app) {
  const P = app.pat;
  if (P.page === 'add') return renderRecognize(app);
  if (P.page === 'build') return renderBuild(app);
  if (P.page === 'detail') return renderDetail(app);
  if (P.page === 'done') return renderDone(app);
  if (P.page === 'totals' && ui.select?.size) return renderTotals(app);
  P.page = 'list';
  return renderList(app);
}

const patternTotal = p => p.items.reduce((a, i) => a + i.count, 0);
const doneN = p => (p.build?.done || []).filter(c => p.items.some(i => i.code === c)).length;

function viewPattern(p) {
  if (!p.images?.some(im => im.fullId)) {
    toast(p.thumbs?.length ? '这张图纸是旧版本存的，没有保存原图' : '这张图纸没有图片（手动录入或文字识别）');
    return;
  }
  openImageViewer(entriesFromImages(p.images), { view: 'full', focus: false });
}

function thumbButton(p, onclick) {
  const src = p.thumbs?.[0];
  return h('button.thumb', { 'aria-label': '查看图纸', onclick },
    src ? h('img', { src, alt: '' }) : h('div.noimg', '🧩'),
    p.images?.some(im => im.fullId) ? h('span.zi', '🔍') : null);
}

/** 一排可以左右滑动的色块 */
function colorStrip(items) {
  return h('div.hscroll.pc-colors', items.map(i => chip(i.code, { size: 'sm' })));
}

// ---------- 列表 ----------

function matches(p) {
  if (ui.status !== 'all' && p.status !== ui.status) return false;
  for (const t of ui.tags) if (!(p.tags || []).includes(t)) return false;
  const q = ui.q.trim().toLowerCase();
  if (q && !String(p.name || '').toLowerCase().includes(q)) return false;
  return true;
}

async function renderList(app) {
  const list = await store.listPatterns();
  const sel = ui.select;
  const view = clear(app.view);
  if (sel) {
    app.setTitle('选择图纸');
    app.setBack(() => { ui.select = null; app.render(); });
  } else {
    app.setTitle('图纸');
  }

  // 没核对完的识别
  const saved = await store.loadSession();
  if (!sel && saved?.items?.length && !saved.patternId) {
    const done = saved.items.filter(i => i.verified).length;
    view.append(h('div.banner.info', { style: { cursor: 'pointer' }, onclick: () => { app.pat.page = 'add'; app.rec.session = saved; app.rec.step = saved.step === 'preview' ? 'preview' : 'verify'; app.rec.method = saved.method; app.render(); } },
      h('span.ico', '📝'),
      h('div.grow', h('b', '有一张图纸还没核对完'), h('div.small.muted', `${saved.name || ''} · 已核对 ${done}/${saved.items.length} 项`)),
      h('span.link', '继续 ›')));
  }

  if (!list.length) {
    ui.select = null;
    view.append(h('div.empty',
      h('div.big-ico', '🧩'),
      h('p', '还没有图纸。添加一张图纸截图，自动读出要用的颜色和颗数。'),
      h('button.btn.primary.big', { onclick: () => startAdd(app) }, '＋ 添加第一张图纸')));
    return;
  }

  if (sel) {
    const ids = new Set(list.map(p => p.id));
    for (const id of [...sel]) if (!ids.has(id)) sel.delete(id);
    const shown = list.filter(matches);
    const allOn = shown.length && shown.every(p => sel.has(p.id));
    app.actions.append(h('button.btn.sm.soft', { onclick: () => { if (allOn) shown.forEach(p => sel.delete(p.id)); else shown.forEach(p => sel.add(p.id)); app.rerender(); } }, allOn ? '全不选' : '全选'));
  } else {
    app.actions.append(
      h('button.btn.sm.soft', { onclick: () => { ui.select = new Set(); app.render(); } }, '多选'),
      h('button.btn.sm.primary', { onclick: () => startAdd(app) }, '＋ 添加'));
  }

  // 搜索 + 筛选
  const search = h('input.input', { type: 'search', placeholder: '🔍 搜索图纸名字', value: ui.q, autocomplete: 'off' });
  const results = h('div.pat-list');
  search.addEventListener('input', () => { ui.q = search.value; drawResults(); });
  const counts = { all: list.length };
  for (const p of list) counts[p.status] = (counts[p.status] || 0) + 1;
  const tags = await store.allTags();
  // 点筛选会整页重画：记住这一排按钮滚到的位置，重画后放回去
  const keepScroll = fn => () => { ui.filtersScroll = filters.scrollLeft; fn(); app.rerender(); };
  const filters = h('div.filters',
    [['all', '全部'], ['pending', '待拼'], ['building', '拼豆中'], ['done', '已拼']].filter(([k]) => k === 'all' || counts[k])
      .map(([k, label]) => h('button' + (ui.status === k ? '.on' : ''), { onclick: keepScroll(() => { ui.status = k; }) }, `${label} ${counts[k] || 0}`)),
    tags.length ? h('span.fsep') : null,
    tags.map(({ tag, count }) => h('button.tagf' + (ui.tags.has(tag) ? '.on' : ''), {
      onclick: keepScroll(() => { if (ui.tags.has(tag)) ui.tags.delete(tag); else ui.tags.add(tag); }),
    }, `#${tag}`, h('span.n', count))));
  view.append(h('div.pat-tools', search, filters));
  filters.scrollLeft = ui.filtersScroll || 0;
  requestAnimationFrame(() => { filters.scrollLeft = ui.filtersScroll || 0; });
  if (sel) view.append(h('p.small.muted', { style: { margin: '2px 2px 6px' } }, '勾选打算拼的图纸，看一共要多少豆子、哪些颜色要先买。'));
  view.append(results);

  function drawResults() {
    clear(results);
    const shown = list.filter(matches);
    if (ui.tags.size || ui.q.trim() || ui.status !== 'all') {
      results.append(h('div.row.between.small.muted', { style: { margin: '2px 2px 6px' } },
        h('span', `找到 ${shown.length} 张` + (ui.tags.size > 1 ? `（同时有 ${[...ui.tags].map(t => '#' + t).join(' ')}）` : '')),
        h('button.link.small', { onclick: () => { ui.q = ''; ui.status = 'all'; ui.tags.clear(); app.rerender(); } }, '清除筛选')));
    }
    if (!shown.length) {
      results.append(h('div.empty', h('div.big-ico', '🔍'), h('p', '没有符合条件的图纸')));
      return;
    }
    for (const p of shown) results.append(card(app, p, sel));
  }
  drawResults();

  if (sel) {
    view.append(h('div.sticky-actions.sel-actions',
      h('button.btn.danger.big.sel-del', {
        disabled: !sel.size, 'aria-label': '删除选中的图纸',
        onclick: () => deleteSelected(app, list.filter(p => sel.has(p.id))),
      }, sel.size ? `🗑 删除 ${sel.size} 张` : '🗑 删除'),
      h('button.btn.primary.big.grow', {
        disabled: !sel.size,
        onclick: () => { app.pat.page = 'totals'; ui.open = null; app.render(); },
      }, sel.size ? `看合计用量（${sel.size} 张）` : '先选图纸')));
  }
}

/** 多选后一起删除（确认时列出名字；扣过库存的提醒不会加回来） */
async function deleteSelected(app, chosen) {
  if (!chosen.length) return;
  const deducted = chosen.filter(p => p.status === 'done' || Object.values(p.build?.deducted || {}).some(n => n > 0));
  const names = chosen.map(p => `“${p.name || '未命名'}”`);
  const detail = [
    names.length > 8 ? `${names.slice(0, 8).join('、')} 等 ${names.length} 张` : names.join('、'),
    deducted.length
      ? `其中 ${deducted.length} 张已经扣过库存，删除后不会加回来（要加回来请先在图纸里“撤销扣减”或“撤回为待拼”）。`
      : '库存不受影响。',
    '原图一起删除，删除后不能恢复。',
  ].join('\n');
  if (!(await confirmDialog(`删除选中的 ${chosen.length} 张图纸？`, { ok: `删除 ${chosen.length} 张`, danger: true, detail }))) return;
  try {
    for (const p of chosen) await store.deletePattern(p.id);
    toast(`已删除 ${chosen.length} 张图纸`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
  ui.select = null;
  app.render();
}

function card(app, p, sel) {
  const total = patternTotal(p);
  const [label, cls] = STATUS[p.status] || ['—', ''];
  const on = sel?.has(p.id);
  const toggle = () => { if (on) sel.delete(p.id); else sel.add(p.id); app.rerender(); };
  const open = () => (sel ? toggle() : goPattern(app, p.id));
  const building = p.status === 'building';
  return h('div.card.pcard2' + (sel ? '.pick' : '') + (on ? '.on' : ''), { onclick: open, role: sel ? 'checkbox' : 'button', 'aria-checked': sel ? String(!!on) : null },
    h('div.pcard',
      sel ? h('span.check.sel' + (on ? '.v' : '.p'), { style: { alignSelf: 'center' } }, on ? '✓' : '') : null,
      thumbButton(p, e => { e.stopPropagation(); if (sel) toggle(); else viewPattern(p); }),
      h('div.grow',
        h('div.row.between.gap-s', h('div.t', p.name || '未命名'), h('span.tag.' + cls, label)),
        h('div.small.muted', `${p.items.length} 色 · ${fmtNum(total)} 颗 · ${fmtTime(p.createdAt)}`),
        p.tags?.length ? h('div.pc-tags', p.tags.map(t => h('span.tagchip', '#' + t))) : null,
        building ? h('div.pc-prog', h('div.progress', h('i', { style: { width: (doneN(p) / p.items.length * 100) + '%' } })), h('span.tiny.muted', `已拼好 ${doneN(p)}/${p.items.length} 色`)) : null)),
    colorStrip(p.items));
}

function startAdd(app) {
  app.pat.page = 'add';
  if (!app.rec.session) app.rec.step = 'pick';
  app.render();
}

// ---------- 详情 ----------

async function renderDetail(app) {
  const p = await store.getPattern(app.pat.id);
  if (!p) { app.pat.page = 'list'; return app.render(); }
  const settings = app.settings;
  app.setTitle('图纸详情');
  app.setBack(() => { app.pat.page = 'list'; app.render(); });
  app.actions.append(h('button.btn.sm.soft', { 'aria-label': '更多', onclick: () => moreSheet(app, p) }, '⋯'));
  const view = clear(app.view);
  const [label, cls] = STATUS[p.status] || ['—', ''];
  const total = patternTotal(p);
  const hasImg = p.images?.some(im => im.fullId);

  // 头部：缩略图 + 名字 + 分类
  view.append(h('div.card.pd-head',
    h('div.pd-top',
      h('button.pd-thumb', { onclick: () => viewPattern(p), 'aria-label': '看原图' },
        p.thumbs?.[0] ? h('img', { src: p.thumbs[0], alt: '' }) : h('div.noimg', '🧩'),
        hasImg ? h('span.zi', '🔍 看原图') : null),
      h('div.grow',
        h('div.pd-name', h('b', p.name || '未命名'), h('button.icon-btn.sm', { 'aria-label': '改名', onclick: () => renameSheet(app, p) }, '✎')),
        h('div.row.gap-s.wrap', { style: { marginTop: '4px' } }, h('span.tag.' + cls, label), h('span.small.muted', `${p.items.length} 色 · ${fmtNum(total)} 颗`)),
        h('div.small.muted', { style: { marginTop: '2px' } }, `添加于 ${fmtTime(p.createdAt)}`))),
    h('div.pd-tags',
      (p.tags || []).map(t => h('span.tagchip.big', '#' + t)),
      h('button.tagadd', { onclick: () => tagSheet(app, p) }, p.tags?.length ? '✎ 分类' : '＋ 加分类'))));

  // 拼豆进度 + 主按钮
  const nDone = doneN(p);
  if (p.status === 'building') {
    view.append(h('div.card.pd-build',
      h('div.row.between', h('b', '拼豆中'), h('span.small.muted', `已拼好 ${nDone}/${p.items.length} 色`)),
      h('div.progress', { style: { marginTop: '8px' } }, h('i', { style: { width: (nDone / p.items.length * 100) + '%' } })),
      Object.keys(p.build?.deducted || {}).length ? h('div.tiny.muted', { style: { marginTop: '6px' } }, `已经从库存扣过：${Object.entries(p.build.deducted).filter(([, n]) => n > 0).map(([c, n]) => `${c}×${n}`).join('、')}`) : null,
      h('div.row.end', { style: { marginTop: '6px' } }, h('button.link.small.pd-revert', { onclick: () => revertPending(app, p) }, '↩ 撤回为待拼'))));
  }
  if (p.status === 'done') {
    view.append(h('div.banner.ok', h('span.ico', '✅'), h('div',
      h('b', p.build?.partial ? '已结束（拼了一部分）' : '已拼完'),
      h('div.small', `库存已扣减${p.doneAt ? ' · ' + fmtTime(p.doneAt) : ''}`))));
  }
  const lastH = p.status === 'pending' ? (p.history || []).slice(-1)[0] : null;
  if (lastH) {
    const ded = Object.entries(lastH.deducted || {}).filter(([, n]) => n > 0);
    view.append(h('div.banner.info', h('span.ico', '↩️'), h('div',
      h('b', '上次拼到一半没继续'),
      h('div.small', `${fmtTime(lastH.endedAt)} 结束${ded.length ? `，当时已从库存扣掉：${ded.map(([c, n]) => `${c}×${n}`).join('、')}` : '，没有扣库存'}。这张图纸已放回“待拼”，再拼是全新的一次。`))));
  }
  view.append(h('div.pd-cta',
    p.status === 'done'
      ? h('button.btn.primary.big.block', { onclick: () => again(app, p) }, '🔁 再拼一次')
      : h('button.btn.primary.big.block', { onclick: () => startBuild(app, p) }, p.status === 'building' ? `🧩 继续拼豆（${nDone}/${p.items.length} 色）` : '🧩 开始拼豆')));

  // 库存对照（还要扣的部分）
  if (p.status !== 'done') {
    const inv = await store.getInventory();
    const left = store.remainingNeed(p, settings).filter(r => r.left > 0);
    const rows = left.map(r => {
      const stock = store.stockOf(inv, r.code), threshold = store.thresholdOf(inv, r.code, settings);
      const after = stock - r.left;
      return { ...r, stock, threshold, after, status: after < 0 ? 'short' : after < threshold ? 'low' : 'ok' };
    }).sort((a, b) => ({ short: 0, low: 1, ok: 2 })[a.status] - ({ short: 0, low: 1, ok: 2 })[b.status]);
    const short = rows.filter(r => r.status === 'short'), low = rows.filter(r => r.status === 'low');
    view.append(h('div.section-title', '库存对照'));
    if (short.length) view.append(h('div.banner.bad', h('span.ico', '⛔️'), h('div', h('b', `${short.length} 种颜色不够，共缺 ${fmtNum(short.reduce((a, r) => a - r.after, 0))} 颗`), h('div.small', '可以先拼够的颜色，缺的补货后再拼。'))));
    else if (low.length) view.append(h('div.banner.warn', h('span.ico', '⚠️'), h('div', h('b', '全部够用'), h('div.small', `但拼完后有 ${low.length} 种颜色会低于补货线。`))));
    else view.append(h('div.banner.ok', h('span.ico', '✅'), h('div', h('b', '全部够用'), h('div.small', '拼完后所有颜色都还在补货线以上。'))));
    view.append(h('div.table-wrap', h('table.ptable',
      h('thead', h('tr', h('th', '颜色'), h('th', '需要'), h('th', '现有'), h('th', '拼后'))),
      h('tbody', rows.map(r => h('tr.' + r.status,
        h('td', chip(r.code, { size: 'sm' })),
        h('td', fmtNum(r.left)),
        h('td', fmtNum(r.stock)),
        h('td.after' + (r.after < 0 ? '.neg' : r.status === 'low' ? '.low' : ''), r.after < 0 ? `缺 ${fmtNum(-r.after)}` : fmtNum(r.after))))))));
    view.append(h('p.small.muted', Number(settings.lossPercent) > 0 ? `“需要”已按损耗 ${settings.lossPercent}% 向上取整。` : '', p.build?.deducted && Object.keys(p.build.deducted).length ? '已经扣过的部分不再算。' : ''));
    if (short.length || low.length) {
      view.append(h('button.btn.block', { onclick: () => copyText([
        ...short.map(r => `${r.code}：缺 ${-r.after} 颗（需要 ${r.left}，现有 ${r.stock}）`),
        ...low.map(r => `${r.code}：拼完剩 ${r.after} 颗（补货线 ${r.threshold}）`)].join('\n')) }, '复制补货清单'));
    }
    view.append(h('div.pd-more',
      h('button.link', { onclick: () => directFinish(app, p) }, '不用拼豆板，已经拼完了 → 直接扣减库存 ›')));
  } else {
    view.append(h('div.section-title', '用到的颜色'));
    view.append(h('div.pd-colors', p.items.map(i => h('div.pd-color', chip(i.code, { size: 'sm' }), h('span', `×${fmtNum(i.count)}`)))));
    const txs = [...(p.build?.txIds || []), ...(p.txId && !(p.build?.txIds || []).includes(p.txId) ? [p.txId] : [])];
    if (txs.length) {
      view.append(h('div.pd-more', h('button.link', { onclick: () => undoPattern(app, p, txs) }, '撤销扣减（库存加回来，图纸回到“拼豆中”）')));
    }
  }
}

function moreSheet(app, p) {
  const s = sheet(h('div.menu',
    h('button', { onclick: () => { s.close(); renameSheet(app, p); } }, '✎ 改名'),
    h('button', { onclick: () => { s.close(); tagSheet(app, p); } }, '🏷 分类'),
    h('button', { onclick: () => { s.close(); editItems(app, p); } }, '🎨 修改颜色和数量'),
    p.images?.some(im => im.fullId) ? h('button', { onclick: () => { s.close(); viewPattern(p); } }, '🖼 看原图') : null,
    h('button', { onclick: () => { s.close(); again(app, p); } }, '🔁 复制一份（再拼一次）'),
    h('button.danger', {
      onclick: async () => {
        s.close();
        if (!(await confirmDialog(`删除“${p.name}”？`, { ok: '删除', danger: true, detail: p.status === 'done' ? '已经扣掉的库存不会加回来（要加回来请先“撤销扣减”）。' : '库存不受影响。' }))) return;
        await store.deletePattern(p.id);
        toast('已删除');
        app.pat.page = 'list'; app.render();
      },
    }, '🗑 删除图纸')), { title: p.name });
}

async function renameSheet(app, p) {
  const name = await inputSheet('图纸名字', p.name || '', { placeholder: '图纸名字' });
  if (!name || name === p.name) return;
  await store.patchPattern(p.id, { name });
  toast('已改名', 'ok'); app.rerender();
}

/**
 * 选分类：点一下加上/去掉；可以新建；“管理”里能改名、删除分类。
 * 用于图纸详情（传 p），也用于保存前的预览页（传 { tags } 和 onSave）。
 */
export async function tagSheet(app, p, { onSave } = {}) {
  let chosen = new Set(p.tags || []);
  const all = await store.allTags();
  const names = [...new Set([...all.map(t => t.tag), ...chosen])];
  const box = h('div.tag-pick');
  const draw = () => {
    clear(box);
    if (!names.length) box.append(h('p.small.muted', '还没有分类。在下面输入一个，比如“动物”“小件”“送人”。'));
    for (const t of names) {
      box.append(h('button.tagopt' + (chosen.has(t) ? '.on' : ''), { onclick: () => { if (chosen.has(t)) chosen.delete(t); else chosen.add(t); draw(); } },
        chosen.has(t) ? '✓ ' : '', '#' + t));
    }
  };
  const input = h('input.input', { placeholder: '新分类，如：动物', maxlength: 20 });
  const add = async () => {
    const t = input.value.trim().replace(/^#/, '');
    if (!t) return;
    if (!names.includes(t)) names.push(t);
    chosen.add(t); input.value = '';
    await store.addTag(t);
    draw();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  const save = async () => {
    const tags = names.filter(t => chosen.has(t));
    if (onSave) onSave(tags);
    else { await store.patchPattern(p.id, { tags }); toast('分类已保存', 'ok'); }
    s.close(); app.rerender();
  };
  draw();
  const s = sheet([
    h('p.small.muted', { style: { margin: '0 2px 8px' } }, '一张图纸可以有多个分类，在图纸列表里可以按分类筛选。'),
    box,
    h('div.row.gap', { style: { marginTop: '12px' } }, input, h('button.btn.soft', { onclick: add }, '添加')),
    h('div.row.between', { style: { marginTop: '14px' } },
      names.length ? h('button.link.small', { onclick: () => { s.close(); manageTags(app); } }, '管理分类（改名/删除）') : h('span'),
      h('div.row.gap', h('button.btn.ghost', { onclick: () => s.close() }, '取消'), h('button.btn.primary', { onclick: save }, '保存'))),
  ], { title: '分类', tall: true });
}

async function manageTags(app) {
  const all = await store.allTags();
  const s = sheet(h('div.list', all.map(({ tag, count }) => h('div.li',
    h('div.grow', h('b', '#' + tag), h('div.tiny.muted', `${count} 张图纸`)),
    h('button.btn.sm.soft', {
      onclick: async () => {
        const name = await inputSheet('分类改名', tag);
        if (!name || name === tag) return;
        await store.renameTag(tag, name.trim().replace(/^#/, ''));
        if (ui.tags.delete(tag)) ui.tags.add(name.trim());
        s.close(); toast('已改名', 'ok'); app.rerender();
      },
    }, '改名'),
    h('button.btn.sm.ghost', {
      onclick: async () => {
        if (!(await confirmDialog(`删除分类“${tag}”？`, { ok: '删除', danger: true, detail: '图纸本身不会被删除，只是去掉这个分类。' }))) return;
        await store.deleteTag(tag); ui.tags.delete(tag);
        s.close(); toast('已删除'); app.rerender();
      },
    }, '删除')))), { title: '管理分类', tall: true });
}

/** 拼豆中 → 撤回为待拼（打的勾清空，扣过的库存加回来） */
export async function revertPending(app, p) {
  const ticks = (p.build?.done || []).length;
  const ded = Object.entries(p.build?.deducted || {}).filter(([, n]) => n > 0);
  const detail = [
    ticks ? `已打的勾（${ticks} 色）会清空。` : '还没有打勾的颜色。',
    ded.length ? `这次已经从库存扣掉的 ${ded.map(([c, n]) => `${c}×${n}`).join('、')} 会加回库存。` : '没有扣过库存。',
    '拼豆板、拼豆板尺寸和摆放位置都保留，以后点“开始拼豆”直接从头拼。',
  ].join('\n');
  if (!(await confirmDialog(`把“${p.name}”撤回为待拼？`, { ok: '撤回为待拼', detail }))) return false;
  try {
    await store.revertToPending(p.id);
    toast('已撤回为待拼', 'ok');
    goPattern(app, p.id);
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}

async function startBuild(app, p) {
  await store.startBuild(p.id);
  return goPattern(app, p.id, 'build');
}

async function again(app, p) {
  const id = await store.duplicatePattern(p.id);
  toast('已复制一份，可以从头再拼', 'ok');
  return goPattern(app, id);
}

/** 不用拼豆板：直接把剩下的全部扣掉 */
async function directFinish(app, p) {
  const left = store.remainingNeed(p, app.settings).filter(r => r.left > 0);
  const total = left.reduce((a, r) => a + r.left, 0);
  if (!(await confirmDialog('确定后将确定减少拼豆库存，是否继续？', {
    ok: '确定，扣减库存',
    detail: `将扣减 ${left.length} 种颜色，共 ${fmtNum(total)} 颗。库存记录不够的颜色扣到 0 为止。之后可以在图纸里“撤销扣减”。`,
  }))) return;
  await finishAndShow(app, p, Object.fromEntries(left.map(r => [r.code, r.left])), { finish: true });
}

/** 结算后跳到完成页（补货提醒） */
export async function finishAndShow(app, p, amounts, opts) {
  try {
    const txId = await store.settleBuild(p.id, amounts, opts);
    app.pat.result = { txId, patternId: p.id, codes: Object.keys(amounts).filter(c => amounts[c] > 0), name: p.name, finished: !!opts.finish, partial: !!opts.partial, abandon: !!opts.abandon };
    return goPattern(app, p.id, 'done');
  } catch (e) { toast(e.message, 'error'); }
}

async function undoPattern(app, p, txIds) {
  if (!(await confirmDialog(`撤销“${p.name}”的扣减？`, { ok: '撤销', danger: true, detail: '扣掉的豆子会加回库存，图纸回到“拼豆中”，已打的勾保留。' }))) return;
  try {
    const all = await store.listTransactions();
    for (const id of [...txIds].reverse()) {
      const tx = all.find(t => t.id === id);
      if (tx && !tx.undone) await store.undoTransaction(id);
    }
    toast('已撤销，库存已恢复', 'ok');
    app.rerender();
  } catch (e) { toast(e.message, 'error'); }
}

/** 修改颜色和数量：借用核对页（列表模式），保存后回到详情 */
function editItems(app, p) {
  app.rec.session = {
    id: newId(), createdAt: Date.now(), method: 'saved', name: p.name, patternId: p.id, tags: p.tags || [],
    images: (p.images || []).map(im => ({ ...im })),
    statedTotal: p.statedTotal || null, statedColors: null, cursor: 0, mode: 'list',
    items: p.items.map(i => ({ id: newId(), img: null, code: i.code, rawCode: i.code, count: i.count, box: null, rgb: null, swatch: i.swatch || null, uncertain: false, verified: true, orig: { code: i.code, count: i.count } })),
  };
  app.rec.step = 'verify';
  app.saveSession();
  app.pat.page = 'add';
  app.render();
}

// ---------- 结算完成 ----------

async function renderDone(app) {
  const res = app.pat.result;
  const tx = res?.txId != null ? (await store.listTransactions()).find(t => t.id === res.txId) : null;
  if (!res || (res.txId != null && (!tx || tx.undone))) { app.pat.result = null; app.pat.page = 'detail'; return app.render(); }
  app.setTitle(res.finished && !res.partial ? '拼完啦' : '已扣减库存');
  const settings = app.settings;
  const view = clear(app.view);
  const inv = await store.getInventory();
  const used = res.codes;
  const need = used.map(code => ({ code, stock: store.stockOf(inv, code), threshold: store.thresholdOf(inv, code, settings) })).filter(x => x.stock < x.threshold);
  const others = store.lowStockList(inv, settings).filter(x => !used.includes(x.code));
  const total = tx ? -tx.deltas.reduce((a, d) => a + d.delta, 0) : 0;

  view.append(h('div.banner.ok', h('span.ico', res.finished && !res.partial ? '🎉' : '✅'), h('div',
    h('b', res.finished && !res.partial ? `“${res.name}”拼完了，库存已扣减` : `“${res.name}”已扣减库存`),
    h('div.small', (tx ? `${tx.deltas.length} 种颜色，共 ${fmtNum(total)} 颗。` : '没有需要扣的颜色。') + (res.abandon ? '图纸已放回“待拼”，以后再拼是全新的一次。' : '')))));
  if (need.length) {
    view.append(h('div.card',
      h('h2', `🛒 这些颜色该补货了（${need.length}）`),
      h('p.small.muted', '扣减后剩余已低于补货线：'),
      h('div.list', need.map(x => h('div.li', chip(x.code, { size: 'md' }), h('div.grow', h('b.mono', `剩 ${fmtNum(x.stock)} 颗`), h('div.tiny.muted', `补货线 ${x.threshold}`)), h('span.tag.warn', '需补货')))),
      h('div.spacer'),
      h('button.btn.block', { onclick: () => copyText(need.map(x => `${x.code}：剩 ${x.stock} 颗`).join('\n')) }, '复制补货清单')));
  } else if (used.length) {
    view.append(h('div.card', h('h2', '👍 用到的颜色都还充足'), h('p.small.muted', '扣减后都在补货线以上。')));
  }
  if (others.length) view.append(h('p.small.muted', `另外还有 ${others.length} 种颜色之前就低于补货线，可在“库存 → 待补货”查看。`));
  view.append(h('div.col', { style: { marginTop: '12px' } },
    h('button.btn.primary.big.block', { onclick: () => { app.pat.result = null; goPattern(app, res.patternId); } }, '完成'),
    tx ? h('button.btn.block', {
      onclick: async () => {
        if (!(await confirmDialog('撤销这次扣减？', { ok: '撤销', danger: true, detail: '库存会恢复，图纸回到“拼豆中”，已打的勾保留。' }))) return;
        try { await store.undoTransaction(res.txId); toast('已撤销', 'ok'); app.pat.result = null; goPattern(app, res.patternId); } catch (e) { toast(e.message, 'error'); }
      },
    }, '撤销这次扣减') : null,
    h('button.btn.ghost.block', { onclick: () => { app.pat.result = null; app.go('inventory'); } }, '查看库存')));
}

// ---------- 多选合计 ----------

async function renderTotals(app) {
  const settings = app.settings;
  app.setTitle('合计用量');
  app.setBack(() => { app.pat.page = 'list'; app.render(); });
  const view = clear(app.view);
  const all = await store.listPatterns();
  const chosen = all.filter(p => ui.select.has(p.id));
  if (!chosen.length) { app.pat.page = 'list'; return app.render(); }
  const copiesOf = p => ui.copies.get(p.id) || 1;

  const items = [], by = new Map();
  for (const p of chosen) {
    const n = copiesOf(p);
    for (const it of p.items) {
      items.push({ code: it.code, count: it.count * n });
      if (!by.has(it.code)) by.set(it.code, []);
      by.get(it.code).push({ name: p.name || '未命名', count: it.count * n });
    }
  }
  const inv = await store.getInventory();
  const rows = store.previewRows(items, inv, settings).map(r => ({ ...r, buy: Math.max(0, r.threshold - r.after) }));
  const short = rows.filter(r => r.status === 'short');
  const low = rows.filter(r => r.status === 'low');
  const totalNeed = rows.reduce((a, r) => a + r.need, 0);
  const totalBuy = rows.reduce((a, r) => a + r.buy, 0);
  const doneCount = chosen.filter(p => p.status === 'done').length;

  view.append(h('div.list.tot-pats', chosen.map(p => {
    const n = copiesOf(p);
    const set = v => { ui.copies.set(p.id, Math.max(1, Math.min(99, v))); app.rerender(); };
    return h('div.li',
      h('div.grow',
        h('div', h('b', p.name || '未命名'), p.status === 'done' ? h('span.tag.ok', { style: { marginLeft: '6px' } }, '已拼') : null),
        h('div.tiny.muted', `${p.items.length} 色 · ${fmtNum(patternTotal(p))} 颗${n > 1 ? ` × ${n} 份` : ''}`)),
      h('div.mini-step',
        h('button', { 'aria-label': '少拼一份', disabled: n <= 1, onclick: () => set(n - 1) }, '−'),
        h('span', `${n} 份`),
        h('button', { 'aria-label': '多拼一份', onclick: () => set(n + 1) }, '+')));
  })));

  view.append(h('div.totals', { style: { marginTop: '12px' } },
    h('div.stat', h('div.k', '一共需要'), h('div.v', fmtNum(totalNeed)), h('div.s.muted', `${rows.length} 种颜色`)),
    h('div.stat', h('div.k', '建议买'), h('div.v', { style: { color: totalBuy ? 'var(--bad)' : 'var(--ok)' } }, fmtNum(totalBuy)),
      h('div.s.muted', totalBuy ? `${short.length + low.length} 种颜色` : '都不用买'))));

  if (short.length) {
    const lack = short.reduce((a, r) => a - r.after, 0);
    view.append(h('div.banner.bad', h('span.ico', '⛔️'), h('div',
      h('b', `${short.length} 种颜色不够，拼完这些图还缺 ${fmtNum(lack)} 颗`),
      low.length ? h('div.small', `另有 ${low.length} 种颜色够用，但拼完会低于补货线。`) : null)));
  } else if (low.length) {
    view.append(h('div.banner.warn', h('span.ico', '⚠️'), h('div',
      h('b', '全部够用'), h('div.small', `但拼完后有 ${low.length} 种颜色会低于补货线，建议提前买。`))));
  } else {
    view.append(h('div.banner.ok', h('span.ico', '✅'), h('div', h('b', '全部够用'), h('div.small', '拼完这些图，所有颜色都还在补货线以上。'))));
  }
  if (doneCount) view.append(h('p.small.muted', `其中 ${doneCount} 张已经拼过（库存扣过了），这里按“再拼一次”计算。`));

  const toBuy = rows.filter(r => r.buy > 0);
  if (ui.filter === 'buy' && !toBuy.length) ui.filter = 'all';
  view.append(h('div.seg', { style: { margin: '10px 0' } },
    h('button' + (ui.filter === 'all' ? '.on' : ''), { onclick: () => { ui.filter = 'all'; app.rerender(); } }, `全部颜色（${rows.length}）`),
    h('button' + (ui.filter === 'buy' ? '.on' : ''), { disabled: !toBuy.length, onclick: () => { ui.filter = 'buy'; app.rerender(); } }, `要买的（${toBuy.length}）`)));

  const shown = ui.filter === 'buy' ? toBuy : rows;
  const tbody = h('tbody');
  for (const r of shown) {
    const open = ui.open === r.code;
    const parts = by.get(r.code) || [];
    tbody.append(h('tr.' + r.status + '.click', { onclick: () => { ui.open = open ? null : r.code; app.rerender(); } },
      h('td', chip(r.code, { size: 'sm' })),
      h('td', fmtNum(r.need)),
      h('td', fmtNum(r.stock)),
      h('td.after' + (r.after < 0 ? '.neg' : r.status === 'low' ? '.low' : ''), r.after < 0 ? `缺 ${fmtNum(-r.after)}` : fmtNum(r.after)),
      h('td.buy', r.buy ? fmtNum(r.buy) : h('span.muted', '—'))));
    if (open) {
      tbody.append(h('tr.detail', h('td', { colspan: 5 },
        h('div.small', parts.map(x => h('div.row.between', h('span', x.name), h('span.mono', `${fmtNum(x.count)} 颗`)))),
        h('div.tiny.muted', { style: { marginTop: '4px' } },
          `补货线 ${r.threshold} 颗${Number(settings.lossPercent) > 0 ? ` · 需要已含损耗 ${settings.lossPercent}%` : ''}`))));
    }
  }
  view.append(h('div.table-wrap', h('table.ptable.tot',
    h('thead', h('tr', h('th', '颜色'), h('th', '需要'), h('th', '现有'), h('th', '拼完剩'), h('th', '建议买'))),
    tbody)));
  view.append(h('p.small.muted',
    `“建议买”= 拼完后补回到补货线（默认 ${settings.defaultThreshold} 颗）要买的数量；红色是不够拼，黄色是拼完会低于补货线。点一行可以看每张图纸各用多少。`,
    Number(settings.lossPercent) > 0 ? `“需要”已按损耗 ${settings.lossPercent}% 向上取整。` : ''));

  view.append(h('div.sticky-actions',
    h('button.btn.big.block' + (toBuy.length ? '.primary' : ''), {
      disabled: !toBuy.length,
      onclick: () => copyText(buyList(chosen, copiesOf, short, low)),
    }, toBuy.length ? `复制采购清单（${toBuy.length} 色，${fmtNum(totalBuy)} 颗）` : '不用买豆子 👍')));
}

function buyList(chosen, copiesOf, short, low) {
  const names = chosen.map(p => (p.name || '未命名') + (copiesOf(p) > 1 ? `×${copiesOf(p)}` : '')).join('、');
  const lines = [`拼豆采购清单（${chosen.length} 张图纸：${names}）`];
  if (short.length) lines.push('', '【不够拼，必须买】', ...short.map(r => `${r.code}：缺 ${-r.after} 颗，建议买 ${r.buy} 颗`));
  if (low.length) lines.push('', '【拼完会低于补货线】', ...low.map(r => `${r.code}：拼完剩 ${r.after} 颗，建议买 ${r.buy} 颗`));
  lines.push('', `合计建议买 ${[...short, ...low].reduce((a, r) => a + r.buy, 0)} 颗`);
  return lines.join('\n');
}
