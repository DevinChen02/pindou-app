// 开始拼豆：把图纸数字化成拼豆板（可缩放，每 5 格一条引导线），选一个颜色只看这个颜色，
// 拼好一个颜色打一个勾；全部拼好后扣库存。中途可以结束：拼好的扣掉，没拼的放回库存。
import { h, clear, toast, sheet, confirmDialog, chip, fmtNum, stepper, pickCode, icon, optionSheet } from '../ui.js';
import * as store from '../store.js';
import { packCells, unpackCells, boardRecord, locksFor } from '../board.js';
import { runBoard } from '../boardasync.js';
import { boardReview, verifyIdentities, identityRisks } from '../cells.js';
import { createPanZoom } from '../panzoom.js';
import { rgbOf, isCode, codeCompare } from '../palette.js';
import { openImageViewer, entriesFromImages } from '../viewer.js';
import { makeCanvas, contentBounds, guessLegendRect } from '../image.js';
import { goPattern, finishAndShow, revertPending } from './patterns.js';
import { renderSetup, startSetup, setupActive } from './boardsetup.js';

const CELL = 20;          // 一格在拼豆板上的尺寸（内容坐标）
const M = 24;             // 左、上留给坐标数字
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
const rgbFor = code => (isCode(code) ? rgbOf(code) : [180, 180, 180]);

// ---------- 拼的顺序、板上怎么显示（设置里记住） ----------
export const BUILD_ORDERS = [
  { value: 'count', short: '多→少', label: '颗数多的先拼（推荐）', desc: '先把大面积的颜色拼上，剩下的小颜色有了参照更好找位置' },
  { value: 'countAsc', short: '少→多', label: '颗数少的先拼', desc: '零散的小颜色先拼完' },
  { value: 'code', short: '色号', label: '按色号', desc: 'A1、A2…，和色卡顺序一样' },
  { value: 'list', short: '清单', label: '按图纸清单的顺序', desc: '和图纸上清单写的顺序一样' },
];
export const BUILD_SHOWS = [
  { value: 'real', short: '像实物', label: '像实物（推荐）', desc: '正在拼的颜色是深色，已经拼好的是浅色，还没拼的先不画——和手上的拼豆板一模一样，最好对照' },
  { value: 'fade', short: '三种深浅', label: '三种深浅', desc: '正在拼的最深，已经拼好的浅一些，还没拼的最淡（能看到整幅图，但很浅的颜色不太分得清）' },
];
const orderOf = settings => (BUILD_ORDERS.some(o => o.value === settings.buildOrder) ? settings.buildOrder : 'count');
const showOf = settings => (settings.buildShow === 'fade' ? 'fade' : 'real');
const SPOT_OPTS = [
  { value: 'off', label: '不高亮', desc: '按上面选的显示方式画' },
  { value: 'on', label: '高亮当前颜色', desc: '板子变暗，正在拼的颜色亮起来、外面一圈白边；其他颜色变暗（已拼好的更暗）。也可以点拼豆板上的“✦ 高亮”随时开关' },
];
const spotOf = settings => !!settings.buildSpot;
/** 颜色按选好的顺序排 */
export function orderItems(items, order) {
  const list = items.map((it, i) => ({ ...it, i }));
  if (order === 'count') list.sort((a, b) => b.count - a.count || codeCompare(a.code, b.code));
  else if (order === 'countAsc') list.sort((a, b) => a.count - b.count || codeCompare(a.code, b.code));
  else if (order === 'code') list.sort((a, b) => codeCompare(a.code, b.code));
  return list;
}

function viewSheet(app) {
  const save = key => async v => { app.settings[key] = v; await store.saveSettings(app.settings); app.rerender(); };
  optionSheet('拼的顺序和显示', [
    { title: '先拼哪个颜色（底部颜色的排列、拼好后自动跳到的下一个）', value: orderOf(app.settings), options: BUILD_ORDERS, onPick: save('buildOrder') },
    { title: '选了一个颜色时，板上怎么显示', value: showOf(app.settings), options: BUILD_SHOWS, onPick: save('buildShow') },
    { title: '高亮当前颜色（其他颜色变暗）', value: spotOf(app.settings) ? 'on' : 'off', options: SPOT_OPTS, onPick: async v => { app.settings.buildSpot = v === 'on'; await store.saveSettings(app.settings); app.rerender(); } },
  ]);
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
function reviewCount(board) {
  const rv = board?.review;
  if (!rv) return 0;
  return (rv.risks?.filter(r => r.probe?.length).length || 0) + (rv.uncertain?.length || 0);
}

// ---------- 页面 ----------

export async function renderBuild(app) {
  const p = await store.getPattern(app.pat.id);
  if (!p) { app.pat.page = 'list'; return app.render(); }
  if (bs.pid !== p.id) Object.assign(bs, { pid: p.id, sel: null, edit: false, trayScroll: 0 });
  document.body.classList.add('mode-build');
  app.setTitle(p.name || '拼豆');
  app.setBack(() => { bs.edit = false; goPattern(app, p.id); });
  app.actions.append(h('button.btn.sm.soft', { 'aria-label': '更多', onclick: () => menu(app, p) }, '⋯'));
  const view = clear(app.view);

  const hasImg = p.images?.some(im => im.fullId);
  // 第一次进来（或者还没选拼豆板尺寸）：先框拼豆板 → 识别网格 → 选拼豆板尺寸 → 摆放
  if (hasImg && ((!p.board?.place && !p.boardSkip) || setupActive(p))) return renderSetup(app, p);
  view.classList.add('build-view');
  document.body.classList.add('mode-board'); // 拼豆板铺满一屏：页面本身不滚（设置拼豆板的前几步照常能上下滑）

  const items = orderItems(merged(p), orderOf(app.settings));
  const show = showOf(app.settings), spot = spotOf(app.settings);
  const done = new Set(p.build?.done || []);
  if (bs.sel && !items.some(i => i.code === bs.sel)) bs.sel = null;

  const board = p.board ? { ...p.board, cells: unpackCells(p.board.cells) } : null;
  const boardCount = new Map();
  if (board) for (const v of board.cells) if (v) boardCount.set(board.codes[v - 1], (boardCount.get(board.codes[v - 1]) || 0) + 1);

  // ---- 拼豆板 ----
  const stage = h('div.bd-stage');
  if (board) {
    const layer = h('div.bd-layer');
    const canvas = h('canvas');
    layer.append(canvas);
    const info = h('div.bd-info', { hidden: true });
    const place = placeOf(board);
    const zoomBar = h('div.bd-zoom',
      h('button.wide.bd-mirror' + (place.mirror ? '.on' : ''), { 'aria-label': '镜像', 'aria-pressed': String(!!place.mirror), onclick: () => toggleMirror(app, p) }, '⇋', h('span.t', ' 镜像')),
      h('button.wide.bd-spot' + (spot ? '.on' : ''), { 'aria-label': '高亮当前颜色', 'aria-pressed': String(spot), onclick: () => toggleSpot(app) }, '✦', h('span.t', ' 高亮')),
      h('button', { 'aria-label': '缩小', onclick: () => pz.zoomBy(1 / 1.6) }, '−'),
      h('button.wide', { onclick: () => pz.fit() }, '适合'),
      h('button', { 'aria-label': '放大', onclick: () => pz.zoomBy(1.6) }, '＋'));
    if (place.mirror) stage.append(h('div.bd-mirror-tag', '镜像中（左右翻转）'));
    // 放大后行号、列号固定在左边、上边
    const rulers = makeRulers(stage, place);
    stage.append(layer, ...rulers.els, info, zoomBar);
    if (bs.edit) stage.append(h('div.bd-editbar', h('span', '✏️ 修正模式：点格子改颜色'), h('button.btn.sm', { onclick: () => { bs.edit = false; app.rerender(); } }, '完成')));
    else if (reviewCount(board) && !board.reviewedAt && !bs.hideReview) {
      const rv = board.review;
      const nr = rv.risks.filter(r => r.probe?.length).length, nu = rv.uncertain.length;
      stage.append(h('div.bd-review',
        h('div.grow', h('b', '🔍 建议核对一下'),
          h('div.tiny', [nr ? `${nr} 种颜色很接近` : '', nu ? `${nu} 个格子没把握` : ''].filter(Boolean).join('，') + '，确认几格就能把整板纠正过来')),
        h('button.btn.sm.primary', { onclick: () => reviewFlow(app, p) }, '核对'),
        h('button.icon-btn', { 'aria-label': '先不核对', onclick: () => { bs.hideReview = true; app.rerender(); } }, '✕')));
    }
    const { W, H } = boardSize(place);
    const q = Math.max(1, Math.min(2.5, Math.sqrt(9e6 / (W * H))));
    canvas.width = Math.round(W * q); canvas.height = Math.round(H * q);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    drawBoard(canvas.getContext('2d'), q, board, { sel: bs.sel, done, place, show, spot });
    let infoTimer = null;
    // 点格子会切换选中颜色、整页重画：提示条跟着带过去，别一闪就没了
    const showInfo = (text, until) => {
      info.hidden = false; info.textContent = text;
      bs.info = { pid: p.id, text, until };
      clearTimeout(infoTimer); infoTimer = setTimeout(() => { info.hidden = true; }, Math.max(0, until - Date.now()));
    };
    if (bs.info?.pid === p.id && bs.info.until > Date.now()) showInfo(bs.info.text, bs.info.until);
    const pz = createPanZoom(stage, layer, {
      maxFit: 14,
      onChange: st => rulers.update(st),
      onTap: ({ x, y }) => {
        // 点的是拼豆板上第几行第几列（镜像时左右反过来），再换回图纸网格里的那一格
        const px = Math.floor((x - M) / CELL), py = Math.floor((y - M) / CELL);
        if (px < 0 || py < 0 || px >= place.W || py >= place.H) return;
        const pc = place.mirror ? place.W - 1 - px : px;
        const c = pc - place.ox, r = py - place.oy;
        const inGrid = c >= 0 && r >= 0 && c < board.cols && r < board.rows;
        const v = inGrid ? board.cells[r * board.cols + c] : 0;
        const code = v ? board.codes[v - 1] : null;
        const where = `第 ${py + 1} 行 · 第 ${px + 1} 列`;
        if (bs.edit) { if (inGrid) editCell(app, p, board, r, c, where); else toast('这里在图纸外面，是拼豆板的空位'); return; }
        showInfo(`${where} · ${code || '空'}`, Date.now() + 2200);
        if (code && code !== bs.sel && items.some(i => i.code === code)) { bs.sel = code; app.rerender(); }
      },
    });
    app.onLeave = () => pz.destroy();
    requestAnimationFrame(() => {
      pz.setContent(W, H);
      // 换颜色、打勾后重画：保持原来的缩放位置
      if (bs.view && bs.view.pid === p.id) { Object.assign(pz.state, bs.view.st); pz.zoomAt(pz.state.s, 0, 0); }
    });
    // 记住缩放位置（换颜色重画时不跳回去）
    const saveView = () => { bs.view = { pid: p.id, st: { s: pz.state.s, tx: pz.state.tx, ty: pz.state.ty } }; };
    stage.addEventListener('pointerup', saveView);
    stage.addEventListener('wheel', saveView);
    zoomBar.addEventListener('click', saveView);
  } else {
    stage.classList.add('noboard');
    stage.append(h('div.bd-noboard',
      h('div.big-ico', '📋'),
      h('p', h('b', hasImg ? '现在只按颜色打勾（没用拼豆板）' : '这张图纸没有原图，没法生成拼豆板')),
      p.boardError ? h('p.small.muted', `原因：${p.boardError}`) : null,
      h('p.small.muted', '下面按颜色打勾也能记录进度。'),
      hasImg ? h('button.btn.soft', { onclick: async () => { startSetup(p, 'frame'); await store.patchPattern(p.id, { boardSkip: false }); app.rerender(); } }, '🔲 框出拼豆板，生成拼豆板') : null));
  }

  // ---- 底部：颜色列表 + 操作 ----
  const nDone = items.filter(i => done.has(i.code)).length;
  const allDone = nDone === items.length;
  const colors = h('div.hscroll.bd-colors',
    h('button.bd-sortb', { 'aria-label': '拼的顺序和显示方式', onclick: () => viewSheet(app) }, icon('sort'), h('span.lab', BUILD_ORDERS.find(o => o.value === orderOf(app.settings)).short)),
    h('button.bd-color.all' + (!bs.sel ? '.on' : ''), { onclick: () => { bs.sel = null; app.rerender(); } }, h('span.lab', '全部'), h('span.n', `${items.length} 色`)),
    items.map(it => h('button.bd-color' + (bs.sel === it.code ? '.on' : '') + (done.has(it.code) ? '.done' : ''), {
      'data-code': it.code,
      onclick: () => { bs.sel = bs.sel === it.code ? null : it.code; app.rerender(); },
    }, chip(it.code, { size: 'sm' }), h('span.n', fmtNum(it.count)), done.has(it.code) ? h('span.ck', '✓') : null)));
  // 点颜色会整页重画：颜色条停在原来滑到的位置，不跳回最左边
  colors.addEventListener('scroll', () => { bs.trayScroll = colors.scrollLeft; }, { passive: true });
  const tray = h('div.bd-tray', colors);
  if (bs.sel) {
    const it = items.find(i => i.code === bs.sel);
    const bc = boardCount.get(it.code) || 0;
    const isDone = done.has(it.code);
    tray.append(h('div.bd-selbar',
      chip(it.code, { size: 'md' }),
      h('div.grow',
        h('b', `${it.code} · ${fmtNum(it.count)} 颗`),
        board ? h('div.tiny.muted', (bc === it.count ? '' : `板上 ${bc} / 清单 ${it.count} · `) + (spot ? `亮的 = 正在拼，暗的 = 已拼好，${show === 'real' ? '没拼的先不画' : '最暗 = 还没拼'}` : show === 'real' ? '浅色 = 已拼好，没拼的先不画' : '浅色 = 已拼好，最淡 = 还没拼')) : null),
      h('button.btn' + (isDone ? '.ghost' : '.ok'), {
        onclick: async () => {
          await store.setColorDone(p.id, it.code, !isDone);
          if (!isDone) {
            toast(`${it.code} 拼好了 ✓`, 'ok');
            const next = items.find(x => x.code !== it.code && !done.has(x.code));
            bs.sel = next ? next.code : null;
          }
          app.rerender();
        },
      }, isDone ? '↺ 还没拼好' : '✓ 这个颜色拼好了')));
  }
  tray.append(h('div.bd-foot',
    h('div.grow.small', h('b', `已拼好 ${nDone}/${items.length} 色`), h('div.progress', h('i', { style: { width: (nDone / items.length * 100) + '%' } }))),
    allDone
      ? h('button.btn.primary', { onclick: () => finishAll(app, p) }, '🎉 全图已拼好')
      : h('button.btn.soft', { onclick: () => endSheet(app, p) }, '先拼到这里…')));
  view.append(stage, tray);
  keepTrayScroll(colors);
  requestAnimationFrame(() => keepTrayScroll(colors));
}

/** 颜色条放回上次的位置；选中的颜色（比如拼好后自动跳到的下一个）不在屏幕里时，才挪到刚好露出来 */
function keepTrayScroll(colors) {
  if (!colors.isConnected) return;
  let x = bs.trayScroll || 0;
  const on = bs.sel && colors.querySelector('.bd-color.on');
  if (on) {
    const base = colors.getBoundingClientRect().left;
    const l = on.getBoundingClientRect().left - base + colors.scrollLeft, r = l + on.offsetWidth, w = colors.clientWidth;
    if (l < x) x = Math.max(0, l - 12);
    else if (r > x + w) x = r - w + 12;
  }
  colors.scrollLeft = x;
  bs.trayScroll = colors.scrollLeft;
}

/** 拼豆板怎么摆：拼豆板 W×H 格，图纸网格 (r,c) 放在拼豆板 (r+oy, c+ox)；mirror = 左右翻转着看 */
export function placeOf(board) {
  const P = board.place;
  if (P && P.W > 0 && P.H > 0) return { W: P.W, H: P.H, ox: P.ox || 0, oy: P.oy || 0, mirror: !!P.mirror };
  return { W: board.cols, H: board.rows, ox: 0, oy: 0, mirror: false };
}
export const boardSize = P => ({ W: M + P.W * CELL + 8, H: M + P.H * CELL + 8 });

async function toggleMirror(app, p) {
  const on = !p.board.place?.mirror;
  await store.patchPattern(p.id, pp => ({ ...pp, board: { ...pp.board, place: { ...placeOf(pp.board), mirror: on } } }));
  toast(on ? '已镜像：拼豆板左右翻转显示' : '已取消镜像', 'ok');
  app.rerender();
}

/**
 * 画拼豆板：每格一颗豆子（有孔的圆），空格是小钉；每 5 格一条粗线，边上标坐标。
 * 选了一个颜色时豆子分三种：正在拼（深色）、已拼好（浅色）、还没拼——
 *   show='real'：还没拼的不画（和手上的拼豆板一样）；show='fade'：还没拼的画得最淡。
 * 没选颜色（看全部）时：已拼好的浅色，其余正常。
 * spot=true（高亮当前颜色）且选了颜色：板子变暗，正在拼的原色 + 白圈，其他颜色变暗（已拼好的比没拼的更暗）。
 */
export function drawBoard(g, q, board, { sel, done, place = null, show = 'real', spot = false }) {
  const P = place || placeOf(board);
  const { cells, codes } = board;
  const rows = P.H, cols = P.W;
  g.setTransform(q, 0, 0, q, 0, 0);
  const { W, H } = boardSize(P);
  g.fillStyle = '#f7f6f3'; g.fillRect(0, 0, W, H);
  const selIdx = sel ? codes.indexOf(sel) + 1 : 0;
  const dark = spot && selIdx > 0;
  g.fillStyle = dark ? '#2f2f33' : '#ffffff'; g.fillRect(M, M, cols * CELL, rows * CELL);
  // 细格线
  g.strokeStyle = dark ? '#3e3e43' : '#ebe9e4'; g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= cols; c++) { g.moveTo(M + c * CELL + 0.5, M); g.lineTo(M + c * CELL + 0.5, M + rows * CELL); }
  for (let r = 0; r <= rows; r++) { g.moveTo(M, M + r * CELL + 0.5); g.lineTo(M + cols * CELL, M + r * CELL + 0.5); }
  g.stroke();
  // 豆子
  const peg = dark ? '#55555b' : '#dedbd4';
  const colorOf = codes.map(c => rgbFor(c));
  const rad = CELL * 0.43, hole = CELL * 0.13;
  // 图纸网格以外的拼豆板位置：浅灰底（摆放时看得出图纸占哪一块）
  const gx0 = P.ox, gy0 = P.oy, gx1 = P.ox + board.cols, gy1 = P.oy + board.rows;
  if (gx0 > 0 || gy0 > 0 || gx1 < cols || gy1 < rows) {
    g.fillStyle = dark ? '#28282b' : '#f1efea';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (c >= gx0 && c < gx1 && r >= gy0 && r < gy1) continue;
      const x = P.mirror ? cols - 1 - c : c;
      g.fillRect(M + x * CELL, M + r * CELL, CELL, CELL);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const br = r - P.oy, bc = c - P.ox;
      const v = br >= 0 && bc >= 0 && br < board.rows && bc < board.cols ? cells[br * board.cols + bc] : 0;
      const x = P.mirror ? cols - 1 - c : c;
      const cx = M + x * CELL + CELL / 2, cy = M + r * CELL + CELL / 2;
      if (!v) {
        g.fillStyle = peg;
        g.beginPath(); g.arc(cx, cy, 1.4, 0, Math.PI * 2); g.fill();
        continue;
      }
      const code = codes[v - 1];
      // 这颗豆子现在是哪种：cur 正在拼 / done 已拼好 / todo 还没拼
      const stage = v === selIdx ? 'cur' : done.has(code) ? 'done' : selIdx ? 'todo' : 'cur';
      if (stage === 'todo' && show === 'real') {
        g.fillStyle = peg;
        g.beginPath(); g.arc(cx, cy, 1.4, 0, Math.PI * 2); g.fill();
        continue;
      }
      let [R, G, B] = colorOf[v - 1] || [180, 180, 180];
      if (dark) {
        // 高亮：正在拼的原色 + 白圈；其他颜色压暗（已拼好的 30%，没拼的 18%），在暗底上还认得出颜色
        if (stage !== 'cur') { const k = stage === 'done' ? 0.3 : 0.18; R = Math.round(R * k + 30); G = Math.round(G * k + 30); B = Math.round(B * k + 33); }
        g.fillStyle = `rgb(${R},${G},${B})`;
        g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
        if (stage === 'cur') {
          g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
          const lum = 0.299 * R + 0.587 * G + 0.114 * B;
          g.fillStyle = lum > 200 ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.55)';
          g.beginPath(); g.arc(cx, cy, hole, 0, Math.PI * 2); g.fill();
        }
        continue;
      }
      if (stage === 'done') {
        // 浅色：往白色掺 60%，描一圈淡边——白色、米色的豆子也看得出来
        R = Math.round(R + (255 - R) * 0.6); G = Math.round(G + (255 - G) * 0.6); B = Math.round(B + (255 - B) * 0.6);
      }
      g.globalAlpha = stage === 'todo' ? 0.1 : 1;
      g.fillStyle = `rgb(${R},${G},${B})`;
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
      g.lineWidth = 1; g.strokeStyle = stage === 'done' ? 'rgba(0,0,0,.2)' : 'rgba(0,0,0,.28)'; g.stroke();
      const lum = 0.299 * R + 0.587 * G + 0.114 * B;
      g.fillStyle = lum > 200 ? 'rgba(0,0,0,.14)' : 'rgba(255,255,255,.55)';
      g.beginPath(); g.arc(cx, cy, hole, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
  }
  // 每 5 格的引导线 + 外框
  g.strokeStyle = '#7d858f'; g.lineWidth = 1.6;
  g.beginPath();
  for (let c = 0; c <= cols; c++) if (c % 5 === 0 || c === cols) { g.moveTo(M + c * CELL, M); g.lineTo(M + c * CELL, M + rows * CELL); }
  for (let r = 0; r <= rows; r++) if (r % 5 === 0 || r === rows) { g.moveTo(M, M + r * CELL); g.lineTo(M + cols * CELL, M + r * CELL); }
  g.stroke();
  // 坐标：1、5、10、15…
  g.fillStyle = '#6b6f75'; g.font = `600 9px -apple-system, "PingFang SC", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let c = 1; c <= cols; c++) if (c === 1 || c % 5 === 0) g.fillText(String(c), M + (c - 0.5) * CELL, M / 2);
  g.textAlign = 'right';
  for (let r = 1; r <= rows; r++) if (r === 1 || r % 5 === 0) g.fillText(String(r), M - 4, M + (r - 0.5) * CELL);
}

// ---------- 固定在边上的行号、列号 ----------

/**
 * 放大后，画布上自带的行号（左边）、列号（上边）会移出屏幕：在舞台边上盖三条尺子，
 * 跟着缩放平移实时重画——左边行号、上边列号。
 * 画布自带的那排数字还在屏幕里时，对应的尺子不显示。
 */
function makeRulers(stage, P) {
  const TH = 20, LW = 28;
  const top = h('canvas.bd-ruler.top'), left = h('canvas.bd-ruler.left');
  for (const c of [top, left]) c.style.display = 'none';
  let raf = 0, last = null;
  const font = w => `${w} 10px -apple-system, "PingFang SC", sans-serif`;
  const prep = (cv, w, hh) => {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    cv.style.width = w + 'px'; cv.style.height = hh + 'px'; cv.style.display = '';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    g.fillStyle = 'rgba(247,246,243,.95)'; g.fillRect(0, 0, w, hh);
    return g;
  };
  // 格子在屏幕上多大决定隔几格标一个数（数字至少要 ~16 像素宽）
  const stepFor = px => (px >= 16 ? 1 : px * 5 >= 18 ? 5 : 10);
  function draw(st) {
    const sw = stage.clientWidth, sh = stage.clientHeight, cs = CELL * st.s;
    // 画布自带的数字（上边中线 M/2、左边右对齐到 M-4）移出屏幕了才盖尺子，不挡住没放大时的豆子
    const showTop = st.ty + (M / 2) * st.s < 4;
    const showLeft = st.tx + (M - 10) * st.s < 2;
    const x0 = showLeft ? LW : 0, y0 = showTop ? TH : 0, x1 = sw;
    if (showTop) {
      const g = prep(top, sw, TH), step = stepFor(cs);
      g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, TH - 0.5); g.lineTo(sw, TH - 0.5); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let c = 0; c < P.W; c++) {
        const n = c + 1;
        if (!(step === 1 || n % step === 0 || (n === 1 && step === 5))) continue;
        const x = st.tx + (M + (c + 0.5) * CELL) * st.s;
        if (x < x0 + 6 || x > x1 - 6) continue;
        g.font = font(n % 5 === 0 ? 700 : 500); g.fillStyle = n % 5 === 0 ? '#3a3d42' : '#80848a';
        g.fillText(String(n), x, TH / 2 + 1);
      }
    } else top.style.display = 'none';
    if (showLeft) {
      const g = prep(left, LW, sh), step = stepFor(cs);
      g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(LW - 0.5, 0); g.lineTo(LW - 0.5, sh); g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let r = 0; r < P.H; r++) {
        const n = r + 1;
        if (!(step === 1 || n % step === 0 || (n === 1 && step === 5))) continue;
        const y = st.ty + (M + (r + 0.5) * CELL) * st.s;
        if (y < y0 + 5 || y > sh - 5) continue;
        g.font = font(n % 5 === 0 ? 700 : 500); g.fillStyle = n % 5 === 0 ? '#3a3d42' : '#80848a';
        g.fillText(String(n), LW - 5, y);
      }
      if (showTop) { g.fillStyle = 'rgba(247,246,243,1)'; g.fillRect(0, 0, LW, TH); } // 左上角的空角
    } else left.style.display = 'none';
  }
  return {
    els: [top, left],
    update(st) { last = { s: st.s, tx: st.tx, ty: st.ty }; if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (stage.isConnected) draw(last); }); },
  };
}

// ---------- 修正格子 ----------

let saveTimer = null;
function editCell(app, p, board, r, c, where = null) {
  const i = r * board.cols + c;
  const cur = board.cells[i];
  const items = merged(p);
  const set = async code => {
    s.close();
    let idx = code ? board.codes.indexOf(code) + 1 : 0;
    const codes = [...board.codes];
    if (code && !idx) { codes.push(code); idx = codes.length; }
    board.cells[i] = idx;
    board.codes = codes;
    clearTimeout(saveTimer);
    // 改过的格子记成“锁定”：以后重新生成、重新计算都按它来
    await store.patchPattern(p.id, pp => {
      const locks = (pp.board.locks || []).filter(([j]) => j !== i);
      locks.push([i, code || '']);
      return { ...pp, board: { ...pp.board, codes, cells: packCells(board.cells), edits: (pp.board.edits || 0) + 1, locks } };
    });
    app.rerender();
  };
  const s = sheet([
    h('p.small.muted', { style: { margin: '0 2px 10px' } }, `${where || `第 ${r + 1} 行 · 第 ${c + 1} 列`}，现在是 ${cur ? board.codes[cur - 1] : '空'}。改成：`),
    h('div.code-grid', items.map(it => h('button.code-cell' + (cur && board.codes[cur - 1] === it.code ? '.on' : ''), { onclick: () => set(it.code) }, chip(it.code, { size: 'sm' }))),
      h('button.code-cell' + (!cur ? '.on' : ''), { onclick: () => set(null) }, h('span.chip.sm.empty', '空'))),
  ], { title: '改这一格' });
}

// ---------- 菜单 ----------

function menu(app, p) {
  const hasImg = p.images?.some(im => im.fullId);
  const s = sheet(h('div.menu',
    hasImg ? h('button', { onclick: () => { s.close(); openImageViewer(entriesFromImages(p.images), { view: 'full', focus: false }); } }, '🖼 看原图') : null,
    p.board ? h('button', { onclick: () => { s.close(); bs.edit = !bs.edit; app.rerender(); } }, bs.edit ? '✏️ 退出修正模式' : '✏️ 修正格子颜色') : null,
    p.board && hasImg ? h('button', { onclick: () => { s.close(); reviewFlow(app, p); } }, '🔍 核对拼豆板（相近色、没把握的格子）') : null,
    p.board ? h('button', { onclick: () => { s.close(); compareSheet(p); } }, '📊 拼豆板和清单对一对') : null,
    p.board ? h('button', { onclick: () => { s.close(); toggleMirror(app, p); } }, p.board.place?.mirror ? '⇋ 取消镜像' : '⇋ 镜像（左右翻转）') : null,
    p.board ? h('button', { onclick: () => { s.close(); startSetup(p, 'peg'); app.rerender(); } }, '📏 换拼豆板尺寸 / 调整位置') : null,
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
    h('p.small', `拼豆板 ${board.cols} 列 × ${board.rows} 行，${bad.length ? `${bad.length} 种颜色的格子数和清单不一样：` : '每种颜色的格子数都和清单一致 ✓'}`),
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

async function reviewFlow(app, p) {
  const board = p.board;
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
  const run = async () => { res = await runBoard('classify', pix.data, { xs: geo.xs, ys: geo.ys, refs, opt: { locks, dewatermark: !!board.dewatermark } }); res.rows = board.rows; res.cols = cols; };
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
    const rec = boardRecord({ ...res, geom: geo }, board.imageId, { auto: board.auto, manual: board.manual, reviewedAt: Date.now(), edits: board.edits || 0, place: board.place || null, dewatermark: !!board.dewatermark }, locks);
    const before = unpackCells(board.cells);
    let diff = 0;
    for (let i = 0; i < res.cells.length; i++) {
      const a = before[i] ? board.codes[before[i] - 1] : '', b = res.cells[i] ? res.codes[res.cells[i] - 1] : '';
      if (a !== b) diff++;
    }
    await store.patchPattern(p.id, { board: rec });
    s.close();
    toast(diff ? `已按核对结果重新计算，${diff} 格改了颜色` : '核对完成，拼豆板没有变化', 'ok');
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
    if (rv.risks.length && at === 0) {
      const b = h('button.btn.sm.soft', { onclick: () => autoCheck(b) }, '🤖 先让识字模型自动核对相近色');
      body.append(h('div.rv-auto', b, h('div.tiny.muted', '读几格上印的色号来确认（第一次要下载约 19MB 的模型）')));
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
    detail: `全图已拼好：将扣减 ${left.length} 种颜色，共 ${fmtNum(total)} 颗${Number(app.settings.lossPercent) > 0 ? `（含损耗 ${app.settings.lossPercent}%）` : ''}。库存记录不够的颜色扣到 0 为止。之后可以在图纸里撤销。`,
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
  const s = sheet([
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
