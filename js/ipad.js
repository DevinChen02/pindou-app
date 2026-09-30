// iPad 看板：扫 iPhone 上的二维码，把拼豆板放在大屏幕上照着拼（选颜色、高亮、镜像、打勾都和 iPhone 上一样）。
// 库存、图纸只在 iPhone 上；这里只存收到的拼豆板和 iPad 上打的勾（在这台 iPad 的浏览器里）。
// 拼完：在 iPhone 上点“全拼好了”扣库存；中途结算：点“进度传回 iPhone”，用 iPhone 扫。
import { h, clear, toast, sheet, confirmDialog, chip, fmtTime } from './ui.js';
import { DEFAULT_ENTRIES, setPalette } from './palette.js';
import { orderItems, orderOf, showOf, spotOf, placeOf, viewSheet, boardStage, colorStrip, keepTrayScroll, selBar, cellCounts } from './boardview.js';
import { KIND, packPayload, unpackPayload, toFrames } from './transfer.js';
import { qrShow, scanQR, loadScanner, keepAwake } from './qr.js';
import { APP_VERSION } from './version.js';
import { status as licenseStatus, renderGate, readOnlyBanner, readOnlyToast, readOnlyText, watchRevocation } from './license.js';
window.__appVersion = APP_VERSION;

const KEY = 'pindou-ipad';
const MAX_BOARDS = 20;
const els = {
  view: document.getElementById('view'),
  title: document.getElementById('title'),
  actions: document.getElementById('top-actions'),
  back: document.getElementById('back-btn'),
};

// ---------- 存在 iPad 上的东西 ----------
// { boards: [{ id, name, at, got, touched, rows, cols, codes, hex, cells, place, items, done, sel, mirror }], cur, settings }
const state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && Array.isArray(s.boards)) return { cur: null, settings: {}, ...s };
  } catch { /* 读不出来就从空的开始 */ }
  return { boards: [], cur: null, settings: {} };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch {
    toast('iPad 上存不下了：删掉几张旧的拼豆板再试', 'error');
    return false;
  }
}
const cur = () => state.boards.find(b => b.id === state.cur) || null;
// 试用激活（iPad 看板也要自己的激活码）：到期 / 被停用时只能看已经收到的拼豆板，不能扫新的、不能打勾
let ro = null;
// 这一次打开期间的界面状态（缩放位置、颜色条滑到哪），不存
const ui = { onLeave: null, view: new Map(), info: new Map(), scroll: new Map() };

function unpack(str) {
  const a = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) - 48;
  return a;
}

/** 色卡：内置的，加上这张拼豆板带过来的颜色（iPhone 上自定义过的色号也对） */
function usePalette(b) {
  const m = new Map(DEFAULT_ENTRIES.map(e => [e.code, e.hex]));
  if (b) {
    (b.codes || []).forEach((c, i) => { if (b.hex?.[i]) m.set(c, b.hex[i]); });
    for (const [c, , , hx] of b.items || []) if (hx) m.set(c, hx);
  }
  setPalette([...m].map(([code, hex]) => ({ code, hex })));
}

// ---------- 页面 ----------

function render() {
  try { ui.onLeave?.(); } catch { /* 忽略 */ }
  ui.onLeave = null;
  clear(els.actions);
  document.body.classList.remove('mode-build', 'mode-board');
  els.view.className = '';
  clear(els.view);
  const b = cur();
  if (b) renderBoard(b); else renderHome();
  if (ro) els.view.prepend(readOnlyBanner(ro, relicense));
}
async function relicense() {
  const st = await licenseStatus();
  if (!st.ok && !st.readOnly) { location.reload(); return; }
  ro = st.readOnly ? st : null;
  render();
}
function setTitle(t) { els.title.textContent = t; document.title = t === '拼豆看板' ? t : `${t} · 拼豆看板`; }
function setBack(fn) { els.back.hidden = !fn; els.back.onclick = fn; }

function renderHome() {
  usePalette(null);
  setTitle('拼豆看板');
  setBack(null);
  els.view.classList.add('ipad-home');
  const list = [...state.boards].sort((a, b) => (b.touched || 0) - (a.touched || 0));
  els.view.append(...[
    // 只能查看：不能再扫新的拼豆板（上面的横幅说明了原因），只看已经收到的
    ro ? null : h('div.card.ipad-scan-card',
      h('button.btn.primary.big.ipad-scan', { onclick: scanBoard }, '📷 扫码接收拼豆板'),
      h('p.small.muted', '在 iPhone 的拼豆计数器里：图纸 → 开始拼豆 → 右上角“📲 iPad”，然后把 iPad 的摄像头对准 iPhone 上的二维码。')),
    list.length ? h('div.section-title', '收到的拼豆板') : null,
    list.length ? h('div.list.ipad-boards', list.map(boardRow)) : h('p.small.muted.center', '还没有收到拼豆板'),
    h('p.tiny.muted.center.ipad-foot', `拼豆看板 v${APP_VERSION} · 库存和图纸都在 iPhone 上，这里只放收到的拼豆板和打的勾`),
  ].filter(Boolean));
}

function boardRow(b) {
  const P = placeOf(b);
  const n = b.items.filter(([c]) => b.done.includes(c)).length;
  return h('div.li.click.ipad-row', { 'data-id': String(b.id), onclick: () => openBoard(b.id) },
    thumb(b),
    h('div.grow',
      h('b', b.name),
      h('div.small.muted', `${P.H} 行 × ${P.W} 列 · 已拼好 ${n}/${b.items.length} 色`),
      h('div.tiny.muted', `收到于 ${fmtTime(b.got)}`)),
    ro ? null : h('button.btn.sm.ghost', { onclick: e => { e.stopPropagation(); removeBoard(b); } }, '删除'));
}

/** 列表里的小图：每格一个像素 */
function thumb(b) {
  const cv = h('canvas.ipad-thumb');
  cv.width = b.cols; cv.height = b.rows;
  const g = cv.getContext('2d');
  const img = g.createImageData(b.cols, b.rows);
  const rgb = (b.hex || []).map(x => (x ? [1, 3, 5].map(k => parseInt(x.slice(k, k + 2), 16)) : [180, 180, 180]));
  const cells = unpack(b.cells);
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i], o = i * 4;
    if (!v) { img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = 255; continue; }
    const [r, gg, bb] = rgb[v - 1] || [180, 180, 180];
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

function openBoard(id) {
  const b = state.boards.find(x => x.id === id);
  if (!b) return;
  state.cur = id; b.touched = Date.now();
  save(); render();
}

async function removeBoard(b) {
  if (ro) { readOnlyToast(ro); return; }
  if (!(await confirmDialog(`删除「${b.name}」？`, { ok: '删除', danger: true, detail: '只删 iPad 上的这一份（和 iPad 上打的勾），iPhone 上的图纸和库存不受影响。以后可以在 iPhone 上再扫一次。' }))) return;
  state.boards = state.boards.filter(x => x.id !== b.id);
  if (state.cur === b.id) state.cur = null;
  save(); render();
}

// ---------- 拼的时候 ----------

function renderBoard(b) {
  usePalette(b);
  setTitle(b.name);
  setBack(() => { state.cur = null; save(); render(); });
  els.actions.append(h('button.btn.sm.soft', { 'aria-label': '更多', onclick: () => menu(b) }, '⋯'));
  document.body.classList.add('mode-build', 'mode-board');
  els.view.classList.add('build-view');

  const board = { rows: b.rows, cols: b.cols, codes: b.codes, cells: unpack(b.cells), place: { ...b.place, mirror: b.mirror ?? b.place.mirror } };
  const place = placeOf(board);
  const settings = state.settings;
  const items = orderItems(b.items.map(([code, count, listCount]) => ({ code, count, listCount })), orderOf(settings));
  const done = new Set(b.done);
  if (b.sel && !items.some(i => i.code === b.sel)) b.sel = null;
  const show = showOf(settings), spot = spotOf(settings);
  const counts = cellCounts(board);
  const keep = (m, k = b.id) => ({ get: () => m.get(k) || null, set: v => m.set(k, v) });
  const pick = code => { b.sel = code; save(); render(); };

  const st = boardStage({
    board, place, sel: b.sel, done, show, spot,
    onMirror: () => { b.mirror = !place.mirror; save(); toast(b.mirror ? '已镜像：拼豆板左右翻转显示' : '已取消镜像', 'ok'); render(); },
    onSpot: () => {
      settings.buildSpot = !spot; save();
      if (settings.buildSpot && !b.sel) toast('选一个颜色，它会亮起来，其他颜色变暗');
      render();
    },
    onTap: (cell, showInfo) => {
      showInfo(`${cell.where} · ${cell.code || '空'}`, Date.now() + 2200);
      if (cell.code && cell.code !== b.sel && items.some(i => i.code === cell.code)) pick(cell.code);
    },
    view: keep(ui.view), info: keep(ui.info),
  });
  ui.onLeave = () => st.pz.destroy();

  const scroll = keep(ui.scroll);
  const colors = colorStrip({
    items, sel: b.sel, done, settings, scroll,
    onSort: () => viewSheet(settings, (k, v) => { settings[k] = v; save(); render(); }),
    onPick: pick,
  });
  const tray = h('div.bd-tray', colors);
  if (b.sel) {
    const it = items.find(i => i.code === b.sel);
    const isDone = done.has(it.code);
    tray.append(selBar({
      it, boardCount: counts.get(it.code) || 0, isDone, hasBoard: true, show, spot, readOnly: !!ro,
      onToggle: () => {
        if (ro) { readOnlyToast(ro); return; }
        if (isDone) b.done = b.done.filter(c => c !== it.code);
        else {
          b.done = [...b.done, it.code];
          toast(`${it.code} 拼好了 ✓`, 'ok');
          const next = items.find(x => x.code !== it.code && !done.has(x.code));
          b.sel = next ? next.code : null;
        }
        b.touched = Date.now();
        save(); render();
      },
    }));
  }
  const nDone = items.filter(i => done.has(i.code)).length;
  const allDone = nDone === items.length;
  tray.append(h('div.bd-foot',
    h('div.grow.small',
      h('b', allDone ? '🎉 全部拼好了' : `已拼好 ${nDone}/${items.length} 色`),
      h('div.progress', h('i', { style: { width: (nDone / items.length * 100) + '%' } })),
      h('div.tiny.muted', allDone ? '在 iPhone 上点“🎉 全拼好了”扣库存' : '库存在 iPhone 上扣：拼完点 iPhone 上的“全拼好了”')),
    h('button.btn' + (allDone ? '.primary' : '.soft') + '.ipad-prog', { onclick: () => progressSheet(b) }, '📤 进度传回 iPhone')));
  els.view.append(st.stage, tray);
  keepTrayScroll(colors, b.sel, scroll);
}

function menu(b) {
  const s = sheet(h('div.menu',
    h('button', { onclick: () => { s.close(); progressSheet(b); } }, '📤 进度传回 iPhone（中途结算用）'),
    h('button', { onclick: () => { s.close(); scanBoard(); } }, '📷 重新扫码（iPhone 上改过拼豆板时）'),
    h('button', { onclick: () => { s.close(); viewSheet(state.settings, (k, v) => { state.settings[k] = v; save(); render(); }); } }, '🎨 拼的顺序和显示方式'),
    h('button', { onclick: () => { s.close(); removeBoard(b); } }, '🗑 从 iPad 上删掉这张拼豆板'),
  ), { title: b.name });
}

/** 进度码：iPhone 扫了，就知道 iPad 上哪些颜色拼好了 */
async function progressSheet(b) {
  const payload = await packPayload({ t: 'progress', v: 1, id: b.id, name: b.name, at: Date.now(), done: b.done });
  const show = qrShow(toFrames(KIND.progress, payload));
  const release = await keepAwake();
  const doneItems = b.items.filter(([c]) => b.done.includes(c));
  sheet(h('div.ipad-send',
    show.el,
    h('p.small.center', h('b', '用 iPhone 扫这个二维码')),
    h('p.tiny.muted.center', 'iPhone 上打开这张图纸的拼豆页面 → 右上角“📲 iPad” → “📷 扫 iPad 上的进度码”（“先拼到这里”里也有）'),
    h('div.small', `iPad 上已拼好 ${doneItems.length}/${b.items.length} 色`),
    doneItems.length ? h('div.row.wrap.gap-s', doneItems.map(([c]) => chip(c, { size: 'sm' }))) : null,
  ), { title: '进度传回 iPhone', onClose: () => { show.stop(); release(); } });
}

// ---------- 扫码收拼豆板 ----------

export function acceptBoard(obj) {
  if (ro) throw new Error(readOnlyText(ro));
  if (obj?.t !== 'board' || !(obj.rows > 0) || !(obj.cols > 0) || typeof obj.cells !== 'string' || obj.cells.length !== obj.rows * obj.cols
    || !Array.isArray(obj.codes) || !Array.isArray(obj.items) || !obj.place) throw new Error('拼豆板的内容不完整，再扫一次');
  const old = state.boards.find(x => x.id === obj.id);
  const has = new Set(obj.items.map(i => i[0]));
  const b = {
    id: obj.id, name: obj.name || '拼豆', at: obj.at || Date.now(), got: Date.now(), touched: Date.now(),
    rows: obj.rows, cols: obj.cols, codes: obj.codes, hex: obj.hex || [], cells: obj.cells, place: obj.place, items: obj.items,
    // 再扫一次同一张（iPhone 上改过拼豆板）：iPad 上打的勾保留，iPhone 上打的勾也算上
    done: [...new Set([...(old?.done || []), ...(obj.done || [])])].filter(c => has.has(c)),
    sel: old?.sel ?? null, mirror: old?.mirror ?? null,
  };
  state.boards = [b, ...state.boards.filter(x => x.id !== obj.id)].slice(0, MAX_BOARDS);
  state.cur = b.id;
  save();
  return { b, updated: !!old };
}

async function scanBoard() {
  if (ro) { readOnlyToast(ro); return; }
  const bytes = await scanQR({
    kind: KIND.board,
    title: '扫 iPhone 上的二维码',
    hint: 'iPhone 上：开始拼豆 → 右上角“📲 iPad”',
    wrongKind: k => (k === KIND.progress ? '这是 iPad 的进度码，要用 iPhone 扫' : '这个二维码不是拼豆板'),
  });
  if (!bytes) return;
  try {
    const { b, updated } = acceptBoard(await unpackPayload(bytes));
    toast(updated ? `已更新「${b.name}」（iPad 上打的勾保留）` : `收到「${b.name}」`, 'ok');
  } catch (e) { toast(e.message, 'error'); return; }
  render();
}

// ---------- 更新到新版本（和 iPhone 上一样：不在拼的时候就自动刷新） ----------

const busy = () => !!(document.querySelector('.backdrop, .qrscan') || cur());
let updateReady = false;
function onUpdateReady() {
  updateReady = true;
  if (!busy()) { location.reload(); return; }
  if (document.querySelector('.update-bar')) return;
  const bar = h('div.update-bar',
    h('span.grow', '新版本已经下载好'),
    h('button.btn.sm.primary.update-go', { onclick: () => location.reload() }, '立即更新'),
    h('button.icon-btn', { 'aria-label': '稍后', onclick: () => bar.remove() }, '✕'));
  document.body.appendChild(bar);
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) onUpdateReady(); });
  let reg = null;
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(r => { reg = r; }).catch(e => console.warn('SW 注册失败', e));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (updateReady && !busy()) { location.reload(); return; }
    reg?.update().catch(() => {});
  });
}

window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  if (e.reason?.name !== 'AbortError') toast('出错了：' + (e.reason?.message || e.reason), 'error');
});

window.__ipad = { state, acceptBoard, render }; // 测试用
try { navigator.storage?.persist?.().catch(() => {}); } catch { /* 部分浏览器不支持 */ }

let watching = false;
async function boot() {
  const st = await licenseStatus().catch(e => { console.warn(e); return { ok: true }; });
  if (!st.ok && !st.readOnly) { renderGate(st, () => boot(), { title: '拼豆看板', what: 'iPad 看板' }); return; }
  ro = st.readOnly ? st : null;
  if (!watching && !st.dev && !st.insecure) {
    watching = true;
    watchRevocation(st, nst => { if (!nst.ok && !nst.readOnly) { location.reload(); return; } ro = nst.readOnly ? nst : null; render(); });
  }
  render();
  // 扫码是这里最常用的：先在后台把扫码引擎下好
  if (!ro) setTimeout(() => loadScanner().catch(() => {}), 1500);
}
boot();
