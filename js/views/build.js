// 开始拼豆：把图纸数字化成拼豆板（可缩放，每 5 格一条引导线），选一个颜色只看这个颜色，
// 拼好一个颜色打一个勾；全部拼好后扣库存。中途可以结束：拼好的扣掉，没拼的放回库存。
// 拼豆板怎么画、这一屏的拼豆板和颜色条在 ../boardview.js（iPad 看板也用）。
import { h, clear, toast, sheet, confirmDialog, chip, fmtNum, stepper } from '../ui.js';
import * as store from '../store.js';
import { packCells, unpackCells, boardRecord, locksFor } from '../board.js';
import { runBoard } from '../boardasync.js';
import { boardReview, verifyIdentities, identityRisks } from '../cells.js';
import { ocrOpt } from '../ocrcells.js';
import { openImageViewer, entriesFromImages } from '../viewer.js';
import { makeCanvas, contentBounds, guessLegendRect } from '../image.js';
import { orderItems, orderOf, showOf, spotOf, placeOf, viewSheet as viewOptions, boardStage, colorStrip, keepTrayScroll, selBar, cellCounts, cellWhere } from '../boardview.js';
import { goPattern, finishAndShow, revertPending } from './patterns.js';
import { renderSetup, startSetup, setupActive } from './boardsetup.js';
import { ipadSheet, sentToIpad, scanProgress } from './ipad-send.js';
import { readOnlyText } from '../license.js';

// 别的页面（准备拼豆板、测试）从这里拿画拼豆板的函数
export { placeOf, guideStart, guideLines, cellNum, cellWhere, boardSize, drawBoard, orderItems, BUILD_ORDERS, BUILD_SHOWS } from '../boardview.js';

const bs = { pid: null, sel: null, edit: false, busy: false };

/** 图纸的颜色清单（同一色号合并）；带上清单色块在图上的颜色（swatch），拼豆板归类时当参考色 */
export const merged = p => {
  const m = new Map(), sw = new Map(), sure = new Set();
  for (const it of p.items) {
    m.set(it.code, (m.get(it.code) || 0) + it.count);
    if (!sw.has(it.code) && it.swatch?.length) sw.set(it.code, it.swatch);
    if (it.swatchSure) sure.add(it.code);
  }
  return [...m].map(([code, count]) => ({ code, count, swatch: sw.get(code) || null, ...(sure.has(code) ? { swatchSure: true } : {}) }));
};

/** 拼的时候底部的颜色：每种颜色的颗数用拼豆板上的（排序、显示、扣库存都一致）；listCount = 清单上写的 */
export function buildItems(p, settings) {
  const counts = store.beadCounts(p);
  return orderItems(merged(p).map(it => ({ ...it, listCount: it.count, count: counts.get(it.code) ?? it.count })), orderOf(settings));
}

function viewSheet(app) {
  viewOptions(app.settings, async (key, v) => { app.settings[key] = v; await store.saveSettings(app.settings); app.rerender(); });
}

async function toggleSpot(app) {
  app.settings.buildSpot = !spotOf(app.settings);
  await store.saveSettings(app.settings);
  if (app.settings.buildSpot && !bs.sel) toast('选一个颜色，它会亮起来，其他颜色变暗');
  app.rerender();
}

// ---------- 拼豆板生成 ----------

export async function loadPixels(im) {
  const rec = await store.getImage(im.fullId);
  if (!rec) throw new Error('原图已经不在了');
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('原图打不开')); i.src = rec.dataUrl; });
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return { canvas: c, data: g.getImageData(0, 0, c.width, c.height) };
}

/** 网格所在区域：清单上面（清单在上面时取清单下面） */
export function gridRegion(im, canvas) {
  const W = canvas.width, H = canvas.height;
  let leg = im.legend;
  if (!leg) { try { leg = guessLegendRect(canvas, contentBounds(canvas)); } catch { leg = null; } }
  if (!leg) return { x: 0, y: 0, w: W, h: H };
  const above = leg.y, below = H - (leg.y + leg.h);
  // 自动框出的清单通常从网格最下面那条线开始，所以多留几像素，别把网格的底边切掉
  return above >= below ? { x: 0, y: 0, w: W, h: Math.min(H, leg.y + 24) } : { x: 0, y: Math.max(0, leg.y + leg.h - 24), w: W, h: Math.max(10, below + 24) };
}

/** 拼豆板在原图上的格线（旧记录只存了四角：按等分补出来） */
function geomOf(board) {
  const g = board.geom || {};
  if (g.xs?.length === board.cols + 1 && g.ys?.length === board.rows + 1) return { xs: g.xs, ys: g.ys };
  return {
    xs: Array.from({ length: board.cols + 1 }, (_, i) => Math.round(g.x0 + (g.x1 - g.x0) * i / board.cols)),
    ys: Array.from({ length: board.rows + 1 }, (_, i) => Math.round(g.y0 + (g.y1 - g.y0) * i / board.rows)),
  };
}

/** 有多少处建议核对（相近色 + 没把握的格子） */
export function reviewCount(board) {
  const rv = board?.review;
  if (!rv) return 0;
  return (rv.risks?.filter(r => r.probe?.length).length || 0) + (rv.uncertain?.length || 0);
}

// ---------- 页面 ----------

export async function renderBuild(app) {
  const p = await store.getPattern(app.pat.id);
  if (!p) { app.pat.page = 'list'; return app.render(); }
  if (bs.pid !== p.id) Object.assign(bs, { pid: p.id, sel: null, edit: false, editCell: null, trayScroll: null, view: null, info: null, roMirror: null });
  document.body.classList.add('mode-build');
  app.setTitle(p.name || '拼豆');
  app.setBack(() => { bs.edit = false; goPattern(app, p.id); });
  const view = clear(app.view);

  const hasImg = p.images?.some(im => im.fullId);
  // 第一次进来（或者还没选拼豆板尺寸）：先准备拼豆板（框选 → 网格 → 颜色 → 尺寸 → 摆放）
  const ro = app.readOnly;
  if (hasImg && ((!p.board?.place && !p.boardSkip) || setupActive(p))) {
    if (!ro) return renderSetup(app, p);
    view.append(h('div.card', h('p', h('b', '这张图纸还没有准备好拼豆板')), h('p.small.muted', readOnlyText(ro))));
    return;
  }
  // 选了“不用拼豆板”：只按颜色打勾（识别时顺手算出的拼豆板也不画）
  const board = p.board && !p.boardSkip ? { ...p.board, cells: unpackCells(p.board.cells) } : null;
  const items = buildItems(p, app.settings);
  if (board) app.actions.append(h('button.btn.sm.soft.ipad-btn', { 'aria-label': '在 iPad 上拼', onclick: () => ipadSheet(app, p, items) }, '📲 iPad'));
  app.actions.append(h('button.btn.sm.soft', { 'aria-label': '更多', onclick: () => menu(app, p) }, '⋯'));
  view.classList.add('build-view');
  document.body.classList.add('mode-board'); // 拼豆板铺满一屏：页面本身不滚（设置拼豆板的前几步照常能上下滑）

  const show = showOf(app.settings), spot = spotOf(app.settings);
  const done = new Set(p.build?.done || []);
  if (bs.sel && !items.some(i => i.code === bs.sel)) bs.sel = null;
  const boardCount = board ? cellCounts(board) : new Map();

  // ---- 拼豆板 ----
  let stage, editBar = null;
  const editing = !!board && bs.edit;
  if (!editing) bs.editCell = null;
  if (board) {
    // 修正模式的提示条放在拼豆板上面（不盖住格子，放大了第一行也点得到）
    if (editing) editBar = h('div.bd-editbar', h('span', '✏️ 修正模式：点格子，在下面选颜色'), h('button.btn.sm', { onclick: () => { bs.edit = false; bs.editCell = null; app.rerender(); } }, '完成'));
    // （核对没把握的格子在“准备拼豆板 → 颜色”那一步做；拼的时候想再核对：⋯ → 核对拼豆板）
    const st = boardStage({
      board, place: ro && bs.roMirror != null ? { ...placeOf(board), mirror: bs.roMirror } : placeOf(board), sel: bs.sel, done, show, spot,
      mark: editing && bs.editCell ? bs.editCell : null,
      onMirror: () => toggleMirror(app, p),
      onSpot: () => toggleSpot(app),
      onTap: (cell, showInfo) => {
        if (bs.edit) {
          if (!cell.inGrid) { toast('这里在图纸外面，是拼豆板的空位'); return; }
          bs.editCell = { r: cell.r, c: cell.c, px: cell.px, py: cell.py };
          app.rerender();
          return;
        }
        showInfo(`${cell.where} · ${cell.code || '空'}`, Date.now() + 2200);
        if (cell.code && cell.code !== bs.sel && items.some(i => i.code === cell.code)) { bs.sel = cell.code; app.rerender(); }
      },
      view: { get: () => (bs.view?.pid === p.id ? bs.view.st : null), set: st => { bs.view = { pid: p.id, st }; } },
      info: { get: () => (bs.info?.pid === p.id ? bs.info : null), set: v => { bs.info = { pid: p.id, ...v }; } },
    });
    stage = st.stage;
    app.onLeave = () => st.pz.destroy();
  } else {
    stage = h('div.bd-stage.noboard', h('div.bd-noboard',
      h('div.big-ico', '📋'),
      h('p', h('b', hasImg ? '现在只按颜色打勾（没用拼豆板）' : '这张图纸没有原图，没法生成拼豆板')),
      p.boardError ? h('p.small.muted', `原因：${p.boardError}`) : null,
      h('p.small.muted', '下面按颜色打勾也能记录进度。'),
      hasImg ? h('button.btn.soft', { onclick: async () => { startSetup(p, 'frame'); await store.patchPattern(p.id, { boardSkip: false }); app.rerender(); } }, '🔲 框出拼豆板，生成拼豆板') : null));
  }

  if (editing) {
    view.append(editBar, stage, editPanel(app, p, board));
    return;
  }

  // ---- 底部：颜色列表 + 操作 ----
  const nDone = items.filter(i => done.has(i.code)).length;
  const allDone = nDone === items.length;
  const scroll = { get: () => bs.trayScroll, set: v => { bs.trayScroll = v; } };
  const colors = colorStrip({
    items, sel: bs.sel, done, settings: app.settings, scroll,
    onSort: () => viewSheet(app),
    onPick: code => { bs.sel = code; app.rerender(); },
  });
  const tray = h('div.bd-tray', colors);
  if (bs.sel) {
    const it = items.find(i => i.code === bs.sel);
    const isDone = done.has(it.code);
    tray.append(selBar({
      it, boardCount: boardCount.get(it.code) || 0, isDone, hasBoard: !!board, show, spot, readOnly: !!ro,
      onToggle: async () => {
        await store.setColorDone(p.id, it.code, !isDone);
        if (!isDone) {
          toast(`${it.code} 拼好了 ✓`, 'ok');
          const next = items.find(x => x.code !== it.code && !done.has(x.code));
          bs.sel = next ? next.code : null;
        }
        app.rerender();
      },
    }));
  }
  // 在 iPad 上拼的：这里的勾可能没打，全拼好了也能直接结算
  const onIpad = !!board && sentToIpad(p);
  tray.append(h('div.bd-foot',
    h('div.grow.small', h('b', `已拼好 ${nDone}/${items.length} 色`), h('div.progress', h('i', { style: { width: (nDone / items.length * 100) + '%' } }))),
    ro ? h('span.small.muted', '🔒 只能查看')
    : allDone
      ? h('button.btn.primary', { onclick: () => finishAll(app, p) }, '🎉 全图已拼好')
      : onIpad
        ? h('div.row.gap-s', h('button.btn.soft', { onclick: () => endSheet(app, p) }, '先拼到这里…'), h('button.btn.primary.bd-alldone', { onclick: () => finishAll(app, p) }, '🎉 全拼好了'))
        : h('button.btn.soft', { onclick: () => endSheet(app, p) }, '先拼到这里…')));
  view.append(stage, tray);
  keepTrayScroll(colors, bs.sel, scroll);
}

async function toggleMirror(app, p) {
  if (app.readOnly) { bs.roMirror = !(bs.roMirror ?? !!p.board.place?.mirror); app.rerender(); return; }
  const on = !p.board.place?.mirror;
  await store.patchPattern(p.id, pp => ({ ...pp, board: { ...pp.board, place: { ...placeOf(pp.board), mirror: on } } }));
  toast(on ? '已镜像：拼豆板左右翻转显示' : '已取消镜像', 'ok');
  app.rerender();
}

// ---------- 修正格子 ----------

/** 原图上这一格的放大图（找原图、裁图要一点时间：原图读一次就留着） */
async function cellCropOf(p, board, i) {
  const im = (p.images || []).find(x => x.fullId === board.imageId);
  if (!im || !board.geom) return null;
  if (bs.pix?.pid !== p.id || bs.pix.imageId !== board.imageId) bs.pix = { pid: p.id, imageId: board.imageId, canvas: (await loadPixels(im)).canvas };
  return cellCrop(bs.pix.canvas, geomOf(board), board.cols, i, 76);
}

/** 修正模式底部的面板：点中的是哪一格（原图放大、现在的颜色），下面直接选要改成的颜色 */
function editPanel(app, p, board) {
  const ec = bs.editCell;
  const panel = h('div.bd-tray.bd-editpanel');
  if (!ec) {
    panel.append(h('div.bd-edit-hint', h('b', '点拼豆板上要改的那一格'), h('div.small.muted', '可以先放大再点；点中的格子会有红框')));
    return panel;
  }
  const i = ec.r * board.cols + ec.c;
  const cur = board.cells[i];
  const curCode = cur ? board.codes[cur - 1] : null;
  const where = cellWhere(ec.px, ec.py, placeOf(board));
  const crop = h('div.bd-edit-crop');
  cellCropOf(p, board, i).then(cv => { if (cv) crop.append(cv); else crop.remove(); }).catch(() => crop.remove());
  const codes = merged(p).map(it => it.code);
  if (curCode && !codes.includes(curCode)) codes.push(curCode);
  panel.append(
    h('div.bd-edit-head', crop,
      h('div.grow',
        h('div', h('b', where)),
        h('div.small.muted.bd-edit-now', '现在是 ', curCode ? chip(curCode, { size: 'sm' }) : h('span.chip.sm.empty', '空'), ' 改成：'))),
    h('div.code-grid.bd-edit-codes',
      codes.map(code => h('button.code-cell' + (code === curCode ? '.on' : ''), { 'data-code': code, onclick: () => setCell(app, p, board, i, code, where) }, chip(code, { size: 'sm' }))),
      h('button.code-cell' + (!cur ? '.on' : ''), { 'data-code': '', onclick: () => setCell(app, p, board, i, null, where) }, h('span.chip.sm.empty', '空'))));
  return panel;
}

/** 把一格改成 code（null = 空）；改过的格子记成“锁定”：以后重新生成、重新计算都按它来 */
async function setCell(app, p, board, i, code, where) {
  const cur = board.cells[i];
  if ((cur ? board.codes[cur - 1] : null) === code) return;
  let idx = code ? board.codes.indexOf(code) + 1 : 0;
  const codes = [...board.codes];
  if (code && !idx) { codes.push(code); idx = codes.length; }
  board.cells[i] = idx;
  board.codes = codes;
  await store.patchPattern(p.id, pp => {
    const locks = (pp.board.locks || []).filter(([j]) => j !== i);
    locks.push([i, code || '']);
    return { ...pp, board: { ...pp.board, codes, cells: packCells(board.cells), edits: (pp.board.edits || 0) + 1, locks } };
  });
  toast(`${where} 改成 ${code || '空'}`, 'ok');
  app.rerender();
}

// ---------- 菜单 ----------

function menu(app, p) {
  const hasImg = p.images?.some(im => im.fullId);
  const hasBoard = !!(p.board && !p.boardSkip); // 选了“不用拼豆板”时没有拼豆板的那些功能
  if (app.readOnly) {
    // 只能查看：看原图、发到 iPad 看、对一对、镜像、显示方式
    const r = sheet(h('div.menu',
      hasImg ? h('button', { onclick: () => { r.close(); openImageViewer(entriesFromImages(p.images), { view: 'full', focus: false }); } }, '🖼 看原图') : null,
      hasBoard ? h('button', { onclick: () => { r.close(); ipadSheet(app, p, buildItems(p, app.settings)); } }, '📲 在 iPad 上看（扫码）') : null,
      hasBoard ? h('button', { onclick: () => { r.close(); compareSheet(p); } }, '📊 拼豆板和清单对一对') : null,
      hasBoard ? h('button', { onclick: () => { r.close(); toggleMirror(app, p); } }, '⇋ 镜像（左右翻转）') : null,
      h('button', { onclick: () => { r.close(); viewSheet(app); } }, '🎨 拼的顺序和显示方式'),
      h('p.small.muted', { style: { padding: '8px 4px 0' } }, readOnlyText(app.readOnly))), { title: '拼豆' });
    return;
  }
  const s = sheet(h('div.menu',
    hasImg ? h('button', { onclick: () => { s.close(); openImageViewer(entriesFromImages(p.images), { view: 'full', focus: false }); } }, '🖼 看原图') : null,
    hasBoard ? h('button', { onclick: () => { s.close(); ipadSheet(app, p, buildItems(p, app.settings)); } }, '📲 在 iPad 上拼（扫码）') : null,
    hasBoard ? h('button', { onclick: () => { s.close(); bs.edit = !bs.edit; bs.editCell = null; app.rerender(); } }, bs.edit ? '✏️ 退出修正模式' : '✏️ 修正格子颜色') : null,
    hasBoard && hasImg ? h('button', { onclick: () => { s.close(); reviewFlow(app, p); } }, '🔍 核对拼豆板（相近色、没把握的格子）') : null,
    hasBoard ? h('button', { onclick: () => { s.close(); compareSheet(p); } }, '📊 拼豆板和清单对一对') : null,
    hasBoard ? h('button', { onclick: () => { s.close(); toggleMirror(app, p); } }, p.board.place?.mirror ? '⇋ 取消镜像' : '⇋ 镜像（左右翻转）') : null,
    hasBoard ? h('button', { onclick: () => { s.close(); startSetup(p, 'peg'); app.rerender(); } }, '📏 换拼豆板尺寸 / 调整位置') : null,
    hasImg ? h('button', {
      onclick: async () => {
        s.close();
        // 重新框选、重新识别；核对/修正过的格子保留（锁定）
        startSetup(p, 'frame', true);
        if (p.boardSkip) await store.patchPattern(p.id, { boardSkip: false });
        app.rerender();
      },
    }, '🔲 重新框选拼豆板 / 重新识别') : null,
    h('button', { onclick: () => { s.close(); viewSheet(app); } }, '🎨 拼的顺序和显示方式'),
    h('button', { onclick: () => { s.close(); endSheet(app, p); } }, '⏸ 先拼到这里（结算库存）'),
    p.status === 'building' ? h('button', { onclick: () => { s.close(); revertPending(app, p); } }, '↩ 撤回为待拼（还没开始拼 / 以后再拼）') : null,
  ), { title: '拼豆' });
}

function compareSheet(p) {
  const board = { ...p.board, cells: unpackCells(p.board.cells) };
  const cnt = new Map();
  for (const v of board.cells) if (v) cnt.set(board.codes[v - 1], (cnt.get(board.codes[v - 1]) || 0) + 1);
  const rows = merged(p).map(it => ({ ...it, got: cnt.get(it.code) || 0 }));
  const bad = rows.filter(r => r.got !== r.count);
  sheet([
    h('p.small', `拼豆板 ${board.rows} 行 × ${board.cols} 列，${bad.length ? `${bad.length} 种颜色的格子数和清单不一样：` : '每种颜色的格子数都和清单一致 ✓'}`),
    h('div.table-wrap', h('table.ptable',
      h('thead', h('tr', h('th', '颜色'), h('th', '清单'), h('th', '拼豆板'))),
      h('tbody', rows.map(r => h('tr' + (r.got !== r.count ? '.low' : ''), h('td', chip(r.code, { size: 'sm' })), h('td', fmtNum(r.count)), h('td', fmtNum(r.got))))))),
    h('p.small.muted', '差几格一般是颜色很接近的两种豆子认混了（比如几种米白色）。拼的时候以原图为准；也可以在“修正格子颜色”里点格子改。'),
  ], { title: '拼豆板和清单对一对', tall: true });
}

// ---------- 核对拼豆板（主动学习：确认几格 → 锁定 → 整板重算） ----------

/** 原图上一格的放大图（带周围一圈，当前格描红框） */
function cellCrop(src, geo, cols, i, size = 132) {
  const r = Math.floor(i / cols), c = i % cols;
  const x0 = geo.xs[c], x1 = geo.xs[c + 1], y0 = geo.ys[r], y1 = geo.ys[r + 1];
  const w = x1 - x0, hh = y1 - y0, pad = Math.max(w, hh) * 0.9;
  const sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad);
  const sw = Math.min(src.width - sx, w + pad * 2), sh = Math.min(src.height - sy, hh + pad * 2);
  const cv = h('canvas.rv-crop');
  const k = size / Math.max(sw, sh);
  cv.width = Math.round(sw * k * 2); cv.height = Math.round(sh * k * 2);
  cv.style.width = Math.round(sw * k) + 'px'; cv.style.height = Math.round(sh * k) + 'px';
  const g = cv.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  g.strokeStyle = '#ff2d55'; g.lineWidth = 3;
  g.strokeRect((x0 - sx) * k * 2, (y0 - sy) * k * 2, w * k * 2, hh * k * 2);
  return cv;
}

/**
 * 核对拼豆板：只问几格（相近色每种一格、没把握的格子逐个问），确认的格子锁定，整板重新计算。
 * board：要核对的拼豆板（默认图纸上存的）；onDone(rec)：给了就把新的拼豆板交给它（准备拼豆板时还没存），否则存进图纸
 */
export async function reviewFlow(app, p, { board = p.board, onDone = null } = {}) {
  const im = (p.images || []).find(x => x.fullId === board.imageId);
  if (!im) { toast('原图已经不在了', 'error'); return; }
  const body = h('div.rv', h('div.bd-wait', h('div.spinner'), h('p.small.muted', '正在准备…')));
  const s = sheet(body, { title: '核对拼豆板', tall: true });
  let pix, res;
  const refs = merged(p);
  const geo = geomOf(board);
  const cols = board.cols;
  // 已有的锁定（以前核对/修正过的）
  const locks = new Map(locksFor(board, refs) || []);
  const ocr = ocrOpt(board, refs); // 以前读过的色号（逐格读色号）照样算进去
  const run = async () => { res = await runBoard('classify', pix.data, { xs: geo.xs, ys: geo.ys, refs, opt: { locks, dewatermark: !!board.dewatermark, ocr } }); res.rows = board.rows; res.cols = cols; };
  try {
    pix = await loadPixels(im); await run();
    // 去水印模式：核对时看的放大图也用去掉水印的（格子里的字更好认）
    if (board.dewatermark) {
      const out = await runBoard('clean', pix.data, { xs: geo.xs, ys: geo.ys, cells: res.cells });
      const cv = makeCanvas(out.width, out.height);
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
      pix = { ...pix, canvas: cv };
    }
  } catch (e) { s.close(); toast(e.message, 'error'); return; }
  const kOf = code => (code ? refs.findIndex(r => r.code === code) + 1 : 0);
  const codeOf = k => (k ? refs[k - 1].code : '');
  const changed = new Set();
  const setLock = (i, code) => { locks.set(i, kOf(code)); changed.add(i); };

  let rv = boardReview(res, { cols, locks });
  let steps = [];
  const buildSteps = () => {
    steps = [];
    for (const r of rv.risks) if (r.probe.length) steps.push({ type: 'risk', r });
    for (const u of rv.uncertain) steps.push({ type: 'cell', u });
  };
  buildSteps();
  let at = 0;

  // 上一题：每答一题（包括跳过）之前记下当时的状态，点“上一题”就原样退回去（防手滑）
  let hist = [];
  const snap = (view = { type: 'q' }) => hist.push({ at, view, locks: new Map(locks), changed: new Set(changed) });
  const back = () => {
    const h0 = hist.pop();
    if (!h0) return;
    at = h0.at;
    locks.clear(); for (const [i, k] of h0.locks) locks.set(i, k);
    changed.clear(); for (const i of h0.changed) changed.add(i);
    if (h0.view.type === 'hunt') huntPage(h0.view.r, h0.view.picked); else render();
  };
  const backBtn = () => h('button.btn.ghost.rv-back', { disabled: !hist.length, onclick: back }, '← 上一题');

  // “其他颜色”：这张图纸清单里的所有颜色 + 空
  const otherSheet = (title, current) => new Promise(resolve => {
    let done = false;
    const pick = v => { done = true; sh.close(); resolve(v); };
    const sh = sheet([
      h('p.small.muted', { style: { margin: '0 2px 10px' } }, '选这一格真正的颜色。清单里没有的颜色，要先在图纸详情“修改颜色和数量”里加上。'),
      h('div.code-grid.rv-other', refs.map(r => h('button.code-cell' + (r.code === current ? '.on' : ''), { 'data-code': r.code, onclick: () => pick(r.code) }, chip(r.code, { size: 'sm' }))),
        h('button.code-cell' + (current === '' ? '.on' : ''), { 'data-code': '', onclick: () => pick('') }, h('span.chip.sm.empty', '空'))),
    ], { title, onClose: () => { if (!done) resolve(null); } });
  });

  const codeBtn = (code, on, onclick) => h('button.code-cell' + (on ? '.on' : ''), { onclick }, code ? chip(code, { size: 'sm' }) : h('span.chip.sm.empty', '空'));
  const finish = async () => {
    clear(body).append(h('div.bd-wait', h('div.spinner'), h('p.small.muted', '按你确认的格子重新计算整板…')));
    await run();
    const rec = boardRecord({ ...res, geom: geo }, board.imageId, { auto: board.auto, manual: board.manual, reviewedAt: Date.now(), edits: board.edits || 0, place: board.place || null, dewatermark: !!board.dewatermark, ocrRead: board.ocrRead || 0, ocr: board.ocr || null }, locks);
    const before = unpackCells(board.cells);
    let diff = 0;
    for (let i = 0; i < res.cells.length; i++) {
      const a = before[i] ? board.codes[before[i] - 1] : '', b = res.cells[i] ? res.codes[res.cells[i] - 1] : '';
      if (a !== b) diff++;
    }
    s.close();
    toast(diff ? `已按核对结果重新计算，${diff} 格改了颜色` : '核对完成，拼豆板没有变化', 'ok');
    if (onDone) return onDone(rec);
    await store.patchPattern(p.id, { board: rec });
    app.rerender();
  };

  // 识字模型自动核对（相近色）：读几格上印的色号，读得准的就锁定
  const autoCheck = async btn => {
    btn.disabled = true;
    const old = btn.textContent;
    try {
      const { getPP, cellModelOf } = await import('../extract/ocr.js');
      const pp = await getPP(pr => { btn.textContent = `下载识字模型 ${Math.round((pr.progress || 0) * 100)}%`; }, cellModelOf(app.settings));
      btn.textContent = '识字中…';
      const img = pix.data;
      const reader = async (box, lex) => {
        const rec = await pp.recognize(img, box, { allow: [...new Set(lex.join('') + ' ')], keepLogits: true });
        const sc = [...lex, ''].map(c => [c, pp.lexiconScore(rec, c)]).sort((a, b) => b[1] - a[1]);
        return { text: sc[0][0], margin: sc[0][1] - sc[1][1] };
      };
      const { locks: got, report } = await verifyIdentities(res, geo.xs, geo.ys, reader, { risks: identityRisks(res) });
      for (const [i, k] of got) { locks.set(i, k); changed.add(i); }
      const fixed = report.filter(x => x.verdict !== 'ok' && x.verdict !== 'unsure');
      toast(fixed.length ? `识字发现 ${fixed.map(x => `${x.code}→${x.verdict}`).join('、')}，已锁定 ${got.size} 格` : `识字核对了 ${report.length} 种颜色${got.size ? `，锁定 ${got.size} 格` : ''}`, 'ok');
      if (got.size) { await run(); rv = boardReview(res, { cols, locks }); buildSteps(); at = 0; hist = []; }
    } catch (e) {
      toast('识字模型加载失败：' + (e.message || e), 'error');
    }
    btn.disabled = false; btn.textContent = old;
    render();
  };

  // 身份认错时：在相近色号里挑“字最不像”的一批格子，让用户点出真正的那种
  const huntPage = (r, pre = []) => {
    const picked = new Set(pre);
    const cells = r.hunt.filter(i => !locks.has(i) || pre.includes(i));
    clear(body).append(
      h('p', h('b', `请点出所有写着 ${r.code} 的格子`)),
      h('p.small.muted', '这些格子颜色和它很像；点一下选中，再点取消。一个都没有就直接“下一步”。'),
      h('div.rv-grid', cells.map(i => {
        const b = h('button.rv-pick' + (picked.has(i) ? '.on' : ''), { onclick: () => { if (picked.has(i)) picked.delete(i); else picked.add(i); b.classList.toggle('on'); } }, cellCrop(pix.canvas, geo, cols, i, 92));
        return b;
      })),
      h('div.row.between.rv-foot', backBtn(),
        h('button.btn.primary', { onclick: () => { snap({ type: 'hunt', r, picked: [...picked] }); for (const i of picked) setLock(i, r.code); at++; render(); } }, '下一步')));
  };

  function render() {
    clear(body);
    const head = h('div.row.between.rv-head',
      h('span.small.muted', steps.length ? `${Math.min(at + 1, steps.length)} / ${steps.length}` : ''),
      h('span.small', changed.size ? `已确认 ${changed.size} 格` : ''));
    body.append(head);
    if (rv.risks.some(r => r.probe.length) && at === 0 && !board.ocrRead) {
      const b = h('button.btn.sm.soft', { onclick: () => autoCheck(b) }, '🤖 先让识字模型自动核对相近色');
      const note = h('div.tiny.muted', '读几格上印的色号来确认');
      import('../extract/ocr.js').then(o => o.downloadMB(o.cellModelOf(app.settings))).then(mb => { if (mb > 0) note.textContent = `读几格上印的色号来确认（第一次要下载约 ${Math.round(mb)} MB 的模型）`; }).catch(() => {});
      body.append(h('div.rv-auto', b, note));
    }
    if (at >= steps.length) {
      body.append(h('div.rv-done',
        h('p', h('b', changed.size ? `确认了 ${changed.size} 格` : '没有要确认的了')),
        h('p.small.muted', '点“重新计算”：确认过的格子会锁定，整板按它们重新认一遍（颜色认反了的会一起纠正）。'),
        h('div.row.gap.end', hist.length ? backBtn() : null, h('button.btn.ghost', { onclick: () => s.close() }, '取消'),
          h('button.btn.primary', { onclick: finish }, changed.size ? '重新计算' : '完成'))));
      return;
    }
    const st = steps[at];
    const foot = () => h('div.row.between.rv-foot', backBtn(),
      h('div.row.gap', h('button.btn.ghost', { onclick: () => { snap(); at++; render(); } }, '跳过'), h('button.btn.ghost', { onclick: () => { snap(); at = steps.length; render(); } }, '结束核对')));
    if (st.type === 'risk') {
      const r = st.r, i = r.probe[0];
      const why = r.reason === 'close' ? `${r.code} 和 ${r.partners.join('、')} 颜色很接近` : `图上 ${r.code} 的颜色和色卡差得比较多`;
      // 不是 r.code：锁成用户选的颜色；r.code 真正的格子多半混在相近色号里，让用户找出来
      const notIt = c => {
        if (c === r.code) { snap(); setLock(i, r.code); at++; render(); return; }
        snap(); setLock(i, c);
        if (r.hunt.length) huntPage(r); else { at++; render(); }
      };
      body.append(
        h('div.rv-card', cellCrop(pix.canvas, geo, cols, i),
          h('div.grow', h('div.small.muted', why), h('p', h('b', `红框里这一格是 ${r.code} 吗？`)), h('div.tiny.muted', '放大看格子里印的色号'))),
        h('div.rv-opts',
          h('button.btn.ok', { onclick: () => { snap(); setLock(i, r.code); at++; render(); } }, `✓ 是 ${r.code}`),
          h('div.small.muted', { style: { marginTop: '10px' } }, '不是的话，它是：'),
          h('div.code-grid', [...new Set([...r.partners, ...refs.map(x => x.code)])].filter(c => c !== r.code).slice(0, 11).map(c => codeBtn(c, false, () => notIt(c))),
            codeBtn('', false, () => notIt('')),
            h('button.code-cell.rv-more', { onclick: async () => { const c = await otherSheet('这一格是哪个颜色？', null); if (c != null) notIt(c); } }, h('span.chip.sm.empty', '其他颜色')))),
        foot());
    } else {
      const u = st.u;
      const cur = res.cells[u.i] ? res.codes[res.cells[u.i] - 1] : '';
      body.append(
        h('div.rv-card', cellCrop(pix.canvas, geo, cols, u.i),
          h('div.grow', h('div.small.muted', `第 ${Math.floor(u.i / cols) + 1} 行 · 第 ${u.i % cols + 1} 列`), h('p', h('b', '红框里这一格是？')), h('div.tiny.muted', `现在认成 ${cur || '空'}`))),
        h('div.code-grid.rv-opts', u.cand.map(c => codeBtn(c, c === cur, () => { snap(); setLock(u.i, c); at++; render(); })),
          h('button.code-cell.rv-more', {
            onclick: async () => {
              const c = await otherSheet('这一格是哪个颜色？', cur);
              if (c == null) return;
              snap(); setLock(u.i, c); at++; render();
            },
          }, h('span.chip.sm.empty', '其他颜色'))),
        foot());
    }
  }
  render();
}

// ---------- 结束 / 全部拼好 ----------

async function finishAll(app, p) {
  const left = store.remainingNeed(p, app.settings).filter(r => r.left > 0);
  const total = left.reduce((a, r) => a + r.left, 0);
  if (!(await confirmDialog('确定后将确定减少拼豆库存，是否继续？', {
    ok: '确定，扣减库存',
    detail: `全图已拼好：${store.usesBoard(p) ? '按拼豆板上的豆子' : '按清单数量'}扣减 ${left.length} 种颜色，共 ${fmtNum(total)} 颗${Number(app.settings.lossPercent) > 0 ? `（含损耗 ${app.settings.lossPercent}%）` : ''}。库存记录不够的颜色扣到 0 为止。之后可以在图纸里撤销。`,
  }))) return;
  bs.sel = null;
  await finishAndShow(app, p, Object.fromEntries(left.map(r => [r.code, r.left])), { finish: true });
}

/** 先拼到这里：拼好的颜色扣库存（拼上去的豆子挑不下来），没拼好的放回库存；拼了一部分的可以填用掉几颗 */
function endSheet(app, p) {
  const rem = store.remainingNeed(p, app.settings);
  const done = new Set(p.build?.done || []);
  const doneRows = rem.filter(r => done.has(r.code) && r.left > 0);
  const openRows = rem.filter(r => !done.has(r.code) && r.left > 0);
  const partial = {};
  let keep = true;
  const partList = h('div.list.end-part', openRows.map(r => h('div.li',
    chip(r.code, { size: 'sm' }),
    h('div.grow', h('div.small', `还剩 ${fmtNum(r.left)} 颗没扣`), h('div.tiny.muted', '已经拼上去几颗？')),
    stepper(0, v => { partial[r.code] = Math.max(0, Math.min(r.left, v || 0)); }, { min: 0 }))));
  const seg = h('div.seg',
    h('button.on', { onclick: e => { keep = true; seg.children[0].classList.add('on'); seg.children[1].classList.remove('on'); } }, '以后接着拼'),
    h('button', { onclick: e => { keep = false; seg.children[1].classList.add('on'); seg.children[0].classList.remove('on'); } }, '这次不拼了'));
  const ipadRow = sentToIpad(p) && p.board && !p.boardSkip ? h('div.end-sec.end-ipad',
    h('div.small', h('b', '📲 在 iPad 上打的勾')),
    h('div.tiny.muted', '先把 iPad 的进度扫回来，下面才知道哪些颜色拼好了（已经扫过就不用了）'),
    h('button.btn.sm.soft', { style: { marginTop: '6px' }, onclick: async () => {
      s.close();
      if (await scanProgress(app, p, buildItems(p, app.settings))) endSheet(app, await store.getPattern(p.id));
    } }, '📷 扫 iPad 上的进度码')) : null;
  const s = sheet([
    ipadRow,
    h('div.end-sec',
      h('div.small', h('b', '✅ 已拼好的颜色：扣减库存'), h('span.muted', '（拼上去的豆子挑不下来）')),
      doneRows.length ? h('div.row.wrap.gap-s', { style: { marginTop: '6px' } }, doneRows.map(r => h('span.end-chip', chip(r.code, { size: 'sm' }), `×${fmtNum(r.left)}`)))
        : h('div.small.muted', { style: { marginTop: '4px' } }, '还没有打勾的颜色')),
    h('div.end-sec',
      h('div.small', h('b', '↩️ 没拼好的颜色：放回库存'), h('span.muted', '（不扣减）')),
      openRows.length ? h('div.row.wrap.gap-s', { style: { marginTop: '6px' } }, openRows.map(r => chip(r.code, { size: 'sm' }))) : h('div.small.muted', '没有'),
      openRows.length ? h('details.end-details', h('summary', '有颜色已经拼上去一部分？填一下用掉的颗数'), partList) : null),
    h('div.end-sec', h('div.small', h('b', '之后还接着拼这幅图吗？')), h('div', { style: { marginTop: '6px' } }, seg),
      h('div.tiny.muted', { style: { marginTop: '4px' } }, '接着拼：进度保留，以后拼完只扣剩下的颜色。这次不拼了：图纸放回“待拼”，以后再拼是全新的一次。')),
    h('div.row.gap.end', { style: { marginTop: '14px' } },
      h('button.btn.ghost', { onclick: () => s.close() }, '取消'),
      h('button.btn.primary', {
        onclick: async () => {
          const amounts = Object.fromEntries(doneRows.map(r => [r.code, r.left]));
          for (const [c, n] of Object.entries(partial)) if (n > 0) amounts[c] = (amounts[c] || 0) + n;
          const n = Object.values(amounts).reduce((a, b) => a + b, 0);
          if (n && !(await confirmDialog('确定后将确定减少拼豆库存，是否继续？', { ok: '确定', detail: `扣减 ${Object.keys(amounts).length} 种颜色，共 ${fmtNum(n)} 颗；其余放回库存。` }))) return;
          s.close();
          bs.sel = null;
          if (!n && keep) { toast('没有要扣的，进度已保存'); return goPattern(app, p.id); }
          await finishAndShow(app, p, amounts, keep ? { finish: false } : { abandon: true });
        },
      }, '确定')),
  ], { title: '先拼到这里', tall: true });
}
