// 开始拼豆：把图纸数字化成拼豆板（可缩放，每 5 格一条引导线），选一个颜色只看这个颜色，
// 拼好一个颜色打一个勾；全部拼好后扣库存。中途可以结束：拼好的扣掉，没拼的放回库存。
import { h, clear, toast, sheet, confirmDialog, chip, fmtNum, stepper } from '../ui.js';
import * as store from '../store.js';
import { digitize, gridFromCorners, packCells, unpackCells } from '../board.js';
import { createPanZoom } from '../panzoom.js';
import { rgbOf, isCode } from '../palette.js';
import { openImageViewer, entriesFromImages } from '../viewer.js';
import { makeCanvas, contentBounds, guessLegendRect } from '../image.js';
import { goPattern, finishAndShow } from './patterns.js';

const CELL = 20;          // 一格在拼豆板上的尺寸（内容坐标）
const M = 24;             // 左、上留给坐标数字
const bs = { pid: null, sel: null, edit: false, busy: false };

const merged = p => {
  const m = new Map();
  for (const it of p.items) m.set(it.code, (m.get(it.code) || 0) + it.count);
  return [...m].map(([code, count]) => ({ code, count }));
};
const rgbFor = code => (isCode(code) ? rgbOf(code) : [180, 180, 180]);

// ---------- 拼豆板生成 ----------

async function loadPixels(im) {
  const rec = await store.getImage(im.fullId);
  if (!rec) throw new Error('原图已经不在了');
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('原图打不开')); i.src = rec.dataUrl; });
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return { canvas: c, data: g.getImageData(0, 0, c.width, c.height) };
}

/** 网格所在区域：清单上面（清单在上面时取清单下面） */
function gridRegion(im, canvas) {
  const W = canvas.width, H = canvas.height;
  let leg = im.legend;
  if (!leg) { try { leg = guessLegendRect(canvas, contentBounds(canvas)); } catch { leg = null; } }
  if (!leg) return { x: 0, y: 0, w: W, h: H };
  const above = leg.y, below = H - (leg.y + leg.h);
  // 自动框出的清单通常从网格最下面那条线开始，所以多留几像素，别把网格的底边切掉
  return above >= below ? { x: 0, y: 0, w: W, h: Math.min(H, leg.y + 24) } : { x: 0, y: Math.max(0, leg.y + leg.h - 24), w: W, h: Math.max(10, below + 24) };
}

function boardRecord(res, im, extra = {}) {
  return {
    v: 1, rows: res.rows, cols: res.cols, codes: res.codes, cells: packCells(res.cells),
    stats: res.stats, imageId: im.fullId, geom: { x0: res.geom.xs[0], y0: res.geom.ys[0], x1: res.geom.xs[res.geom.xs.length - 1], y1: res.geom.ys[res.geom.ys.length - 1] },
    createdAt: Date.now(), edits: 0, ...extra,
  };
}

async function autoBoard(p) {
  const refs = merged(p);
  let best = null, lastErr = '没有原图';
  for (const im of (p.images || []).filter(x => x.fullId)) {
    try {
      const { canvas, data } = await loadPixels(im);
      const res = digitize(data, { region: gridRegion(im, canvas), refs });
      if (res.error) { lastErr = res.error; continue; }
      const err = res.stats.diff.reduce((a, x) => a + Math.abs(x.want - x.got), 0);
      if (!best || err < best.err) best = { res, im, err };
    } catch (e) { lastErr = e.message; }
  }
  if (!best) return { error: lastErr };
  return { board: boardRecord(best.res, best.im, { auto: true }) };
}

// ---------- 页面 ----------

export async function renderBuild(app) {
  const p = await store.getPattern(app.pat.id);
  if (!p) { app.pat.page = 'list'; return app.render(); }
  if (bs.pid !== p.id) Object.assign(bs, { pid: p.id, sel: null, edit: false });
  document.body.classList.add('mode-build');
  app.setTitle(p.name || '拼豆');
  app.setBack(() => { bs.edit = false; goPattern(app, p.id); });
  app.actions.append(h('button.btn.sm.soft', { 'aria-label': '更多', onclick: () => menu(app, p) }, '⋯'));
  const view = clear(app.view);
  view.classList.add('build-view');

  const hasImg = p.images?.some(im => im.fullId);
  if (!p.board && hasImg && !p.boardError) {
    view.append(h('div.bd-wait', h('div.spinner'), h('p', h('b', '正在把图纸变成拼豆板…')), h('p.small.muted', '找网格、给每一格认颜色，几秒钟就好')));
    await new Promise(r => setTimeout(r, 30));
    const r = await autoBoard(p);
    if (r.board) await store.patchPattern(p.id, { board: r.board, boardError: null });
    else await store.patchPattern(p.id, { boardError: r.error });
    if (app.pat.page === 'build' && app.pat.id === p.id) return app.rerender();
    return;
  }

  const items = merged(p);
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
    const zoomBar = h('div.bd-zoom',
      h('button', { 'aria-label': '缩小', onclick: () => pz.zoomBy(1 / 1.6) }, '−'),
      h('button.wide', { onclick: () => pz.fit() }, '适合'),
      h('button', { 'aria-label': '放大', onclick: () => pz.zoomBy(1.6) }, '＋'));
    stage.append(layer, info, zoomBar);
    if (bs.edit) stage.append(h('div.bd-editbar', h('span', '✏️ 修正模式：点格子改颜色'), h('button.btn.sm', { onclick: () => { bs.edit = false; app.rerender(); } }, '完成')));
    const W = M + board.cols * CELL + 30, H = M + board.rows * CELL + 8;
    const q = Math.max(1, Math.min(2.5, Math.sqrt(9e6 / (W * H))));
    canvas.width = Math.round(W * q); canvas.height = Math.round(H * q);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    drawBoard(canvas.getContext('2d'), q, board, { sel: bs.sel, done });
    let infoTimer = null;
    const pz = createPanZoom(stage, layer, {
      maxFit: 14,
      onTap: ({ x, y }) => {
        const c = Math.floor((x - M) / CELL), r = Math.floor((y - M) / CELL);
        if (c < 0 || r < 0 || c >= board.cols || r >= board.rows) return;
        const v = board.cells[r * board.cols + c];
        const code = v ? board.codes[v - 1] : null;
        if (bs.edit) return editCell(app, p, board, r, c);
        info.hidden = false;
        info.textContent = `第 ${r + 1} 行 · 第 ${c + 1} 列 · ${code || '空'}`;
        clearTimeout(infoTimer); infoTimer = setTimeout(() => { info.hidden = true; }, 2200);
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
      h('p', h('b', hasImg ? '这张图纸没能自动生成拼豆板' : '这张图纸没有原图，没法生成拼豆板')),
      p.boardError ? h('p.small.muted', `原因：${p.boardError}`) : null,
      h('p.small.muted', '下面按颜色打勾也能记录进度。'),
      hasImg ? h('button.btn.soft', { onclick: () => calibrate(app, p) }, '📐 手动校准网格') : null));
  }

  // ---- 底部：颜色列表 + 操作 ----
  const nDone = items.filter(i => done.has(i.code)).length;
  const allDone = nDone === items.length;
  const colors = h('div.hscroll.bd-colors',
    h('button.bd-color.all' + (!bs.sel ? '.on' : ''), { onclick: () => { bs.sel = null; app.rerender(); } }, h('span.lab', '全部'), h('span.n', `${items.length} 色`)),
    items.map(it => h('button.bd-color' + (bs.sel === it.code ? '.on' : '') + (done.has(it.code) ? '.done' : ''), {
      'data-code': it.code,
      onclick: () => { bs.sel = bs.sel === it.code ? null : it.code; app.rerender(); },
    }, chip(it.code, { size: 'sm' }), h('span.n', fmtNum(it.count)), done.has(it.code) ? h('span.ck', '✓') : null)));
  const tray = h('div.bd-tray', colors);
  if (bs.sel) {
    const it = items.find(i => i.code === bs.sel);
    const bc = boardCount.get(it.code) || 0;
    const isDone = done.has(it.code);
    tray.append(h('div.bd-selbar',
      chip(it.code, { size: 'md' }),
      h('div.grow',
        h('b', `${it.code} · ${fmtNum(it.count)} 颗`),
        board ? h('div.tiny.muted', bc === it.count ? '板上只显示这个颜色，右边数字是每行几颗' : `板上 ${bc} / 清单 ${it.count}`) : null),
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
}

/** 画拼豆板：每格一颗豆子（有孔的圆），空格是小钉；每 5 格一条粗线，边上标坐标 */
function drawBoard(g, q, board, { sel, done }) {
  const { rows, cols, cells, codes } = board;
  g.setTransform(q, 0, 0, q, 0, 0);
  const W = M + cols * CELL + 30, H = M + rows * CELL + 8;
  g.fillStyle = '#f7f6f3'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff'; g.fillRect(M, M, cols * CELL, rows * CELL);
  // 细格线
  g.strokeStyle = '#ebe9e4'; g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= cols; c++) { g.moveTo(M + c * CELL + 0.5, M); g.lineTo(M + c * CELL + 0.5, M + rows * CELL); }
  for (let r = 0; r <= rows; r++) { g.moveTo(M, M + r * CELL + 0.5); g.lineTo(M + cols * CELL, M + r * CELL + 0.5); }
  g.stroke();
  // 豆子
  const selIdx = sel ? codes.indexOf(sel) + 1 : 0;
  const colorOf = codes.map(c => rgbFor(c));
  const rad = CELL * 0.43, hole = CELL * 0.13;
  const rowCount = new Array(rows).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = cells[r * cols + c];
      const cx = M + c * CELL + CELL / 2, cy = M + r * CELL + CELL / 2;
      if (!v) {
        g.fillStyle = '#dedbd4';
        g.beginPath(); g.arc(cx, cy, 1.4, 0, Math.PI * 2); g.fill();
        continue;
      }
      const code = codes[v - 1];
      let alpha = 1;
      if (selIdx) alpha = v === selIdx ? 1 : 0.1;
      else if (done.has(code)) alpha = 0.3;
      if (v === selIdx) rowCount[r]++;
      const [R, G, B] = colorOf[v - 1] || [180, 180, 180];
      g.globalAlpha = alpha;
      g.fillStyle = `rgb(${R},${G},${B})`;
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
      g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,.28)'; g.stroke();
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
  // 选中颜色时：右边标出每行有几颗
  if (selIdx) {
    g.textAlign = 'left'; g.fillStyle = '#e8604c'; g.font = `700 9px -apple-system, sans-serif`;
    rowCount.forEach((n, r) => { if (n) g.fillText(String(n), M + cols * CELL + 4, M + (r + 0.5) * CELL); });
  }
}

// ---------- 修正格子 ----------

let saveTimer = null;
function editCell(app, p, board, r, c) {
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
    await store.patchPattern(p.id, pp => ({ ...pp, board: { ...pp.board, codes, cells: packCells(board.cells), edits: (pp.board.edits || 0) + 1 } }));
    app.rerender();
  };
  const s = sheet([
    h('p.small.muted', { style: { margin: '0 2px 10px' } }, `第 ${r + 1} 行 · 第 ${c + 1} 列，现在是 ${cur ? board.codes[cur - 1] : '空'}。改成：`),
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
    p.board ? h('button', { onclick: () => { s.close(); compareSheet(p); } }, '🔍 拼豆板和清单对一对') : null,
    hasImg ? h('button', {
      onclick: async () => {
        s.close();
        if (p.board?.edits && !(await confirmDialog('重新生成拼豆板？', { ok: '重新生成', danger: true, detail: `你修正过 ${p.board.edits} 处格子，会被覆盖。` }))) return;
        await store.patchPattern(p.id, { board: null, boardError: null });
        app.rerender();
      },
    }, '🔄 重新自动生成拼豆板') : null,
    hasImg ? h('button', { onclick: () => { s.close(); calibrate(app, p); } }, '📐 手动校准网格') : null,
    h('button', { onclick: () => { s.close(); endSheet(app, p); } }, '⏸ 先拼到这里（结算库存）'),
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

// ---------- 手动校准 ----------

async function calibrate(app, p) {
  const im = (p.images || []).find(x => x.fullId === p.board?.imageId) || (p.images || []).find(x => x.fullId);
  if (!im) return;
  const colsIn = h('input.input.num', { type: 'number', inputmode: 'numeric', min: 2, value: p.board?.cols || '' , placeholder: '列数' });
  const rowsIn = h('input.input.num', { type: 'number', inputmode: 'numeric', min: 2, value: p.board?.rows || '', placeholder: '行数' });
  const s = sheet([
    h('p.small', '看图纸边上的数字，填网格一共有几列、几行（只算格子，不算写数字的边）。'),
    h('div.row.gap', h('label.grow', h('div.small.muted', '横向（列）'), colsIn), h('span', '×'), h('label.grow', h('div.small.muted', '竖向（行）'), rowsIn)),
    h('p.small.muted', { style: { marginTop: '10px' } }, '下一步会打开原图：先点网格左上角，再点右下角（可以双指放大点准一点）。'),
    h('div.row.gap.end', { style: { marginTop: '10px' } },
      h('button.btn.ghost', { onclick: () => s.close() }, '取消'),
      h('button.btn.primary', {
        onclick: () => {
          const cols = parseInt(colsIn.value, 10), rows = parseInt(rowsIn.value, 10);
          if (!(cols >= 2 && rows >= 2 && cols <= 300 && rows <= 300)) { toast('请填列数和行数', 'error'); return; }
          s.close();
          pickCorner(im, '点网格【左上角】那一格的左上角', c1 => {
            pickCorner(im, '再点网格【右下角】那一格的右下角', async c2 => {
              const x0 = Math.min(c1.x, c2.x), y0 = Math.min(c1.y, c2.y), x1 = Math.max(c1.x, c2.x), y1 = Math.max(c1.y, c2.y);
              if (x1 - x0 < cols * 3 || y1 - y0 < rows * 3) { toast('两个角离得太近了，再试一次', 'error'); return; }
              try {
                const { data } = await loadPixels(im);
                const res = gridFromCorners(data, { x0, y0, x1, y1, cols, rows, refs: merged(p) });
                await store.patchPattern(p.id, { board: boardRecord(res, im, { manual: true }), boardError: null });
                const err = res.stats.diff.reduce((a, x) => a + Math.abs(x.want - x.got), 0);
                toast(err ? `拼豆板已生成（和清单差 ${err} 颗，可在菜单里对一对）` : '拼豆板已生成，颗数和清单一致 ✓', 'ok');
                app.rerender();
              } catch (e) { toast(e.message, 'error'); }
            });
          });
        },
      }, '下一步')),
  ], { title: '手动校准网格' });
}

function pickCorner(im, hint, cb) {
  openImageViewer(entriesFromImages([im]), {
    view: 'full', focus: false, hint,
    onTap: ({ x, y, view, close }) => {
      if (view.key !== 'full') { toast('请在“整张图”上点'); return; }
      close(); cb({ x, y });
    },
  });
  toast(hint);
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
    h('button', { onclick: e => { keep = false; seg.children[1].classList.add('on'); seg.children[0].classList.remove('on'); } }, '这幅图不拼了'));
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
      h('div.tiny.muted', { style: { marginTop: '4px' } }, '接着拼：进度保留，以后拼完只扣剩下的颜色。')),
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
          await finishAndShow(app, p, amounts, { finish: !keep, partial: !keep });
        },
      }, '确定')),
  ], { title: '先拼到这里', tall: true });
}
