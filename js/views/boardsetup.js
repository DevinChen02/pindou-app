// 开始拼豆前的设置（生成拼豆板之前）：
//   ① 框出拼豆板在原图上的位置 → ② 识别网格，算出图纸尺寸（行列数、有豆子的范围）
//   → ③ 选自己用的拼豆板尺寸（输入，或点选存好的常用尺寸；放不下整幅图的不能选）
//   → ④ 把豆子整体上下左右平移摆好（不能超出拼豆板）
import { h, clear, toast, sheet, fmtNum, chip } from '../ui.js';
import * as store from '../store.js';
import { cropper } from '../cropper.js';
import { swatchCandidates } from '../image.js';
import { readCells } from '../ocrcells.js';
import { REC_MODELS, cellModelOf, downloadMB } from '../extract/ocr.js';
import { gridFromCorners, boardRecord, locksFor, unpackCells } from '../board.js';
import { runBoard } from '../boardasync.js';
import { createPanZoom } from '../panzoom.js';
import { openImageViewer, entriesFromImages } from '../viewer.js';
import { loadPixels, gridRegion, drawBoard, boardSize, merged } from './build.js';
import { goPattern } from './patterns.js';

export const DEFAULT_PEGBOARDS = [[52, 52], [78, 78], [104, 104]];

const st = { pid: null, active: false, showClean: false, clean: null, step: 'frame', im: null, pix: null, frame: null, guess: null, board: null, gridError: null, W: 0, H: 0, ox: 0, oy: 0, busy: false };

/** 有豆子的范围（行列都从 0 数）。一颗都没有时就是整张网格 */
export function beadBox(board) {
  const cells = typeof board.cells === 'string' ? unpackCells(board.cells) : board.cells;
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1, n = 0;
  for (let r = 0; r < board.rows; r++) for (let c = 0; c < board.cols; c++) {
    if (!cells[r * board.cols + c]) continue;
    n++;
    if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c;
  }
  if (!n) return { r0: 0, r1: board.rows - 1, c0: 0, c1: board.cols - 1, w: board.cols, h: board.rows, n };
  return { r0, r1, c0, c1, w: c1 - c0 + 1, h: r1 - r0 + 1, n };
}

/** 平移量限制在拼豆板以内：所有豆子都得落在板上 */
export function clampPlace(board, P) {
  const b = beadBox(board);
  const ox = Math.max(-b.c0, Math.min(P.W - 1 - b.c1, P.ox));
  const oy = Math.max(-b.r0, Math.min(P.H - 1 - b.r1, P.oy));
  return { ...P, ox, oy };
}
/** 居中摆放 */
export function centredPlace(board, W, H, mirror = false) {
  const b = beadBox(board);
  return clampPlace(board, { W, H, ox: Math.floor((W - b.w) / 2) - b.c0, oy: Math.floor((H - b.h) / 2) - b.r0, mirror });
}
export const fits = (board, W, H) => { const b = beadBox(board); return b.w <= W && b.h <= H; };

/** 正在（从拼豆页菜单）重新设置这张图纸的拼豆板 */
export const setupActive = p => st.active && st.pid === p.id;
const endSetup = () => { st.pid = null; st.active = false; st.pix = null; };

/** 从拼豆页进来：从某一步开始（'frame' 重新框选，'peg' 换尺寸/调位置）。redo：框不动也重新识别一遍网格 */
export function startSetup(p, step = 'frame', redo = false) {
  Object.assign(st, { pid: p.id, active: true, step, redo, im: null, pix: null, frame: null, guess: null, board: step === 'frame' ? null : p.board, gridError: null, busy: false, showClean: false, clean: null });
  // 之前摆过：记住拼豆板尺寸和位置（换尺寸页会高亮，原尺寸再选一次位置不变）
  if (p.board?.place) Object.assign(st, { W: p.board.place.W, H: p.board.place.H, ox: p.board.place.ox, oy: p.board.place.oy });
  else Object.assign(st, { W: 0, H: 0, ox: 0, oy: 0 });
}

export async function renderSetup(app, p) {
  if (st.pid !== p.id) startSetup(p, 'frame');
  const view = clear(app.view);
  view.classList.toggle('build-view', st.step === 'place');
  document.body.classList.toggle('mode-board', st.step === 'place');
  app.setTitle(['frame', 'grid'].includes(st.step) ? '准备拼豆板' : st.step === 'peg' ? '选拼豆板尺寸' : '摆好位置');
  const steps = ['frame', 'grid', 'peg', 'place'];
  const back = () => {
    const i = steps.indexOf(st.step);
    // 从拼豆页“换尺寸”进来的，往回退到头就回拼豆页
    if (i <= 0 || (p.board?.place && st.step === 'peg' && !st.pix)) {
      endSetup();
      if (p.board?.place) return app.rerender();
      // 第一次设置就退出来了（还没见到拼豆板）：没打勾、没扣库存的话，图纸还算“待拼”
      if (p.status === 'building' && !store.buildTouched(p)) return store.patchPattern(p.id, { status: 'pending', build: null }).then(() => goPattern(app, p.id));
      return goPattern(app, p.id);
    }
    st.step = steps[i - 1];
    app.rerender();
  };
  app.setBack(back);
  if (st.step !== 'place') view.append(stepper(st.step));
  if (st.step === 'frame') return frameStep(app, p, view);
  if (st.step === 'grid') return gridStep(app, p, view);
  if (st.step === 'peg') return pegStep(app, p, view);
  return placeStep(app, p, view);
}

function stepper(cur) {
  const names = [['frame', '框出拼豆板'], ['grid', '识别网格'], ['peg', '拼豆板尺寸'], ['place', '摆放']];
  const i = names.findIndex(n => n[0] === cur);
  return h('div.su-steps', names.map(([k, label], j) => h('span' + (j === i ? '.on' : j < i ? '.done' : ''), `${j + 1} ${label}`)));
}

async function ensurePixels(p) {
  if (st.pix) return;
  const im = (p.images || []).find(x => x.fullId === p.board?.imageId) || (p.images || []).find(x => x.fullId);
  if (!im) throw new Error('这张图纸没有原图');
  st.im = im;
  st.pix = await loadPixels(im);
}

// ---------- ① 框出拼豆板 ----------

async function frameStep(app, p, view) {
  const wait = h('div.bd-wait', h('div.spinner'), h('p.small.muted', '正在找拼豆板在图上的位置…'));
  if (!st.frame) {
    view.append(wait);
    try {
      await ensurePixels(p);
      const W = st.pix.canvas.width, H = st.pix.canvas.height;
      const pad = g => { const pt = (g.x1 - g.x0) / Math.max(1, g.cols || 1); return { x: Math.max(0, g.x0 - pt), y: Math.max(0, g.y0 - pt), w: Math.min(W, g.x1 + pt) - Math.max(0, g.x0 - pt), h: Math.min(H, g.y1 + pt) - Math.max(0, g.y0 - pt) }; };
      let guess = null;
      if (p.board?.geom && p.board.imageId === st.im.fullId) {
        guess = pad({ ...p.board.geom, cols: p.board.cols });
        if (!st.redo) st.board = p.board; // 识别时已经算好的拼豆板直接用，不用再等
      } else {
        const res = await runBoard('digitize', st.pix.data, { region: gridRegion(st.im, st.pix.canvas), refs: merged(p), dewatermark: app.settings.dewatermark !== false });
        if (!res.error) {
          const g = { x0: res.geom.xs[0], x1: res.geom.xs[res.geom.xs.length - 1], y0: res.geom.ys[0], y1: res.geom.ys[res.geom.ys.length - 1], cols: res.cols };
          guess = pad(g);
          st.board = boardRecord(res, st.im.fullId, { auto: true, dewatermark: app.settings.dewatermark !== false });
        } else guess = gridRegion(st.im, st.pix.canvas);
      }
      st.frame = st.guess = guess;
    } catch (e) { wait.remove(); view.append(h('div.banner.bad', h('span.ico', '⚠️'), h('div', h('b', '打不开原图'), h('div.small', e.message)))); return; }
    wait.remove();
  }
  const work = { canvas: st.pix.canvas, content: { x: 0, y: 0, w: st.pix.canvas.width, h: st.pix.canvas.height }, rect: st.frame };
  const cr = cropper(work, { maxVh: 60 });
  view.append(
    h('p.small.muted', '先把', h('b', '整块拼豆板（所有格子）'), '框在方框里，别框进清单和编号栏也没关系——下一步会在框里自动找格线。拖角调大小，拖中间移动，框外空白处可以重画。'),
    cr.el,
    h('div.row.gap', { style: { marginTop: '6px' } },
      h('button.btn.soft.sm', { onclick: () => { st.frame = { ...work.content }; app.rerender(); } }, '整张图'),
      st.guess ? h('button.btn.soft.sm', { onclick: () => { st.frame = st.guess; app.rerender(); } }, '重置') : null),
    h('div.spacer'),
    h('button.btn.primary.block.big', {
      onclick: () => {
        const f = cr.get();
        const moved = !st.guess || ['x', 'y', 'w', 'h'].some(k => Math.abs(f[k] - st.guess[k]) > 3);
        st.frame = f;
        if (moved) st.board = null; // 框变了：重新找网格
        st.step = 'grid'; app.rerender();
      },
    }, '下一步：识别网格'),
    h('div.center', { style: { marginTop: '10px' } }, h('button.link.small', {
      onclick: async () => { await store.patchPattern(p.id, { boardSkip: true }); endSetup(); app.rerender(); },
    }, '不用拼豆板，只按颜色打勾 ›')));
}

// ---------- ② 识别网格 ----------

async function gridStep(app, p, view) {
  if (!st.board && !st.gridError) {
    const wait = h('div.bd-wait', h('div.spinner'), h('p', h('b', '正在识别网格…')), h('p.small.muted', '找格线、认颜色、读格子里印的色号'));
    view.append(wait);
    try {
      await ensurePixels(p);
      const W = st.pix.canvas.width, H = st.pix.canvas.height, f = st.frame;
      const m = Math.max(W, H) * 0.02;
      const region = { x: Math.max(0, f.x - m), y: Math.max(0, f.y - m), w: Math.min(W, f.x + f.w + m) - Math.max(0, f.x - m), h: Math.min(H, f.y + f.h + m) - Math.max(0, f.y - m) };
      const keep = p.board?.locks?.length && p.board.imageId === st.im.fullId ? p.board : null;
      const refs = merged(p);
      const dewatermark = app.settings.dewatermark !== false;
      let res = await runBoard('digitize', st.pix.data, { region, refs, locks: keep ? locksFor(keep, refs) : null, dewatermark });
      if (!res.error && keep && (res.rows !== keep.rows || res.cols !== keep.cols)) res = await runBoard('digitize', st.pix.data, { region, refs, dewatermark });
      if (res.error) st.gridError = res.error;
      else st.board = boardRecord(res, st.im.fullId, { auto: true, dewatermark }, keep && res.rows === keep.rows && res.cols === keep.cols ? locksFor(keep, refs) : null);
    } catch (e) { st.gridError = e.message; }
    wait.remove();
    if (app.pat.page !== 'build' || st.step !== 'grid') return;
  }
  const refs = merged(p);
  const want = refs.reduce((a, r) => a + r.count, 0);
  if (st.pendingSwatch && st.board) {
    const c = st.pendingSwatch; st.pendingSwatch = null;
    if ((st.board.stats?.legendUsed || []).includes(c)) toast(`${c} 已按你点的颜色重新识别`, 'ok');
    else toast(`图纸格子里找不到一批和你点的一样的颜色，${c} 还是按色卡色认。换个地方（色块中间、别点到字）再点一次`, 'error');
  }
  if (st.gridError && !st.board) {
    view.append(h('div.banner.bad', h('span.ico', '⚠️'), h('div', h('b', '框里没找到网格'), h('div.small', `${st.gridError}。没有格线的图纸（比如只有色块和棋盘格底纹）需要手动告诉我有几行几列。`))));
  } else {
    const b = beadBox(st.board);
    const beads = st.board.stats?.beads ?? b.n;
    const dw = app.settings.dewatermark !== false;
    view.append(gridPreview(dw && st.showClean && st.board ? cleanCanvas(app, st.board) : st.pix?.canvas, st.board));
    view.append(h('label.su-dw',
      h('input', { type: 'checkbox', checked: dw, onchange: async e => { app.settings.dewatermark = e.target.checked; await store.saveSettings(app.settings); st.board = null; st.gridError = null; st.clean = null; app.rerender(); } }),
      h('div.grow', h('b', '去水印'), h('div.tiny.muted', '同一色号的格子本来一模一样，拿它们互相比，被水印、半透明文字盖住的像素不参与认颜色。')),
      dw ? h('button.btn.sm.soft', { onclick: e => { e.preventDefault(); st.showClean = !st.showClean; app.rerender(); } }, st.showClean ? (st.clean?.canvas ? '看原图' : '正在去水印…') : '看去水印后') : null));
    view.append(h('div.card.su-sum',
      h('div.row.between', h('span.small.muted', '图纸网格'), h('b', `${st.board.cols} 列 × ${st.board.rows} 行`)),
      h('div.row.between', h('span.small.muted', '有豆子的范围'), h('b', `${b.w} 列 × ${b.h} 行`)),
      h('div.row.between', h('span.small.muted', '豆子'), h('b', `${fmtNum(beads)} 颗`, want ? h('span.small.muted', `（清单 ${fmtNum(want)}）`) : null)),
      // 有几种颜色是按清单色块在图上的实际颜色认的（其余按色卡标准色 + 校准）
      h('div.row.between.su-legend', h('span.small.muted', '按清单色块的颜色认'), h('b', `${(st.board.stats?.legendUsed || []).length} / ${refs.length} 种`)),
      st.board.ocrRead ? h('div.row.between.su-ocr-done', h('span.small.muted', '逐格读了色号'), h('b', `${fmtNum(st.board.ocrRead)} 格 ✓`)) : null));
    // 没对上清单色块的颜色：只能按色卡标准色认，容易认错——让用户在图上点它的色块，再重新识别
    const used = new Set(st.board.stats?.legendUsed || []);
    const missing = refs.filter(r => !used.has(r.code));
    if (missing.length) {
      view.append(h('div.card.su-miss',
        h('div', h('b', `${missing.length} 种颜色还没对上清单色块`)),
        h('div.small.muted', { style: { margin: '2px 0 8px' } }, '这几种只能按色卡标准色认，出图软件的颜色和色卡差得多时容易认错。点一下色号，再在图上点它的色块（清单里的那个色块，或者图纸上任意一颗这个颜色的豆子），会重新识别。'),
        h('div.row.wrap.gap-s', missing.map(r => h('button.code-cell.su-miss-code', { 'data-code': r.code, onclick: () => pickSwatch(app, p, r.code) },
          chip(r.code, { size: 'sm' }), h('span.tiny.muted', r.swatchSure ? '点的颜色没对上' : r.swatch ? '取色没对上' : '没取到色'))))));
    }
    // 颜色很接近 / 和色卡差得多的几种：只看颜色容易整种认反 → 可以让识字模型把这些格子上印的色号逐格读出来
    const riskCodes = new Set();
    for (const r of st.board.review?.risks || []) { riskCodes.add(r.code); for (const pc of r.partners || []) riskCodes.add(pc); }
    const bcells = unpackCells(st.board.cells);
    const ocrIdx = [];
    for (let i = 0; i < bcells.length; i++) if (bcells[i] && riskCodes.has(st.board.codes[bcells[i] - 1])) ocrIdx.push(i);
    if (ocrIdx.length && !st.board.ocrRead) view.append(ocrCard(app, p, ocrIdx, [...riskCodes]));
    if (want && Math.abs(beads - want) > Math.max(3, want * 0.03)) {
      view.append(h('div.banner.warn', h('span.ico', '⚠️'), h('div', h('b', '颗数和清单差得比较多'), h('div.small', '看看上面红框是不是正好框住了所有格子；不对的话点“行列数不对”手动校准。'))));
    }
    view.append(h('p.small.muted', '红线是每 5 格一条的格线，对一下是不是和原图的格子对齐。'));
  }
  view.append(
    h('div.row.gap.wrap', { style: { marginTop: '8px' } },
      h('button.btn.soft', { onclick: () => manualGrid(app, p) }, st.board ? '行列数不对？手动校准' : '📐 手动填行列数'),
      h('button.btn.ghost', { onclick: () => { st.step = 'frame'; app.rerender(); } }, '重新框选')),
    h('div.spacer'),
    st.board ? h('button.btn.primary.block.big', { onclick: () => { st.step = 'peg'; app.rerender(); } }, '对，下一步：选拼豆板尺寸') : null);
}

/** 逐格读色号：读完和颜色一起重新归类（不改网格） */
function ocrCard(app, p, idx, codes) {
  const model = cellModelOf(app.settings), M = REC_MODELS[model];
  const secs = Math.max(5, Math.round(idx.length * (model === 'v5m' ? 0.035 : 0.045)));
  const status = h('div.small.su-ocr-status');
  const stopBtn = h('button.btn.sm.ghost', { hidden: true }, '停止');
  const go = h('button.btn.soft.su-ocr-go', {
    onclick: async () => {
      go.disabled = true; stopBtn.hidden = false;
      const ctl = { aborted: false };
      stopBtn.onclick = () => { ctl.aborted = true; stopBtn.disabled = true; status.textContent = '正在停止…'; };
      const board = st.board;
      const refs = merged(p);
      const lex = refs.map(r => r.code);
      const { xs, ys } = board.geom;
      try {
        await ensurePixels(p);
        const t0 = Date.now();
        const { scores, done } = await readCells(st.pix.data, xs, ys, idx, lex, {
          signal: ctl, model,
          onProgress: m => {
            if (m.phase === 'model') status.textContent = `下载识字模型 ${Math.round(m.progress * 100)}%（只有第一次）`;
            else {
              const left = m.done ? Math.round((Date.now() - t0) / m.done * (m.total - m.done) / 1000) : secs;
              status.textContent = `读色号 ${m.done} / ${m.total}，还要约 ${left} 秒`;
            }
          },
        });
        if (!done) { status.textContent = '没有读'; go.disabled = false; stopBtn.hidden = true; return; }
        status.textContent = '按读到的色号和颜色一起重新归类…';
        const keep = p.board?.locks?.length && p.board.imageId === st.im.fullId && p.board.rows === board.rows && p.board.cols === board.cols ? p.board : null;
        const locks = keep ? locksFor(keep, refs) : null;
        const res = await runBoard('classify', st.pix.data, { xs, ys, refs, opt: { locks, dewatermark: !!board.dewatermark, ocr: { scores, w: 8, early: true } } });
        res.rows = board.rows; res.cols = board.cols;
        const before = unpackCells(board.cells);
        let changed = 0;
        for (let i = 0; i < res.cells.length; i++) {
          const a = before[i] ? board.codes[before[i] - 1] : '', b = res.cells[i] ? res.codes[res.cells[i] - 1] : '';
          if (a !== b) changed++;
        }
        if (app.pat.page !== 'build' || st.board !== board) return; // 期间换了网格
        st.board = boardRecord({ ...res, geom: { xs, ys } }, board.imageId, { auto: board.auto, manual: board.manual, dewatermark: !!board.dewatermark, ocrRead: done }, locks);
        st.clean = null;
        toast(`读了 ${done} 格色号${changed ? `，${changed} 格改了颜色` : '，拼豆板没有变化'}`, 'ok');
        app.rerender();
      } catch (e) {
        status.textContent = '✗ ' + (e.message || e);
        go.disabled = false; stopBtn.hidden = true;
      }
    },
  }, '开始逐格读色号');
  const dl = h('span');
  downloadMB(model).then(mb => { dl.textContent = mb > 0 ? `第一次要下载约 ${Math.round(mb)} MB；` : ''; });
  return h('div.card.su-ocr',
    h('div', h('b', '🔍 逐格读色号（更准，要等一会儿）')),
    h('div.small.muted', { style: { margin: '2px 0 8px' } },
      `${codes.join('、')} 这几种颜色很接近、或者和色卡差得多，只看颜色容易整种认反。用识字模型把这 ${fmtNum(idx.length)} 格上印的色号一格一格读出来，和颜色一起判断。`,
      dl, `大约 ${secs} 秒，可以随时停止。`),
    h('div.tiny.muted.su-ocr-model', { style: { margin: '-4px 0 8px' } }, `识字模型：${M.name}（${M.model}），可在 设置 → 识字模型 里换`),
    h('div.row.gap', go, stopBtn), status);
}

/** 在图上点某个色号的色块：取那一点周围的颜色，记到图纸清单里（用户点的，归类时优先信），再重新识别网格 */
async function pickSwatch(app, p, code) {
  try { await ensurePixels(p); } catch (e) { toast(e.message, 'error'); return; }
  const hint = `在图上点 ${code} 的色块（清单里的色块，或者一颗 ${code} 豆子）`;
  openImageViewer(entriesFromImages([st.im]), {
    view: 'full', focus: false, hint,
    onTap: async ({ x, y, view, close }) => {
      if (view.key !== 'full') { toast('请在“整张图”上点'); return; }
      close();
      const g0 = st.board?.geom;
      const pitch = g0 && st.board.cols ? (g0.x1 - g0.x0) / st.board.cols : 16;
      const r = Math.max(3, pitch * 0.3);
      let cands = null;
      try { cands = swatchCandidates(st.pix.canvas, { x0: x - r, y0: y - r, x1: x + r, y1: y + r }, 0); } catch { cands = null; }
      if (!cands) { toast('没取到颜色，再点一次', 'error'); return; }
      await store.patchPattern(p.id, pp => ({ ...pp, items: pp.items.map(it => (it.code === code ? { ...it, swatch: cands, swatchSure: true } : it)) }));
      st.pendingSwatch = code;
      st.board = null; st.gridError = null; st.clean = null;
      app.rerender();
    },
  });
  toast(hint);
}

/** 去水印后的整张图（只给人看；在后台线程算，算好了缓存起来再刷新） */
function cleanCanvas(app, board) {
  if (st.clean?.board === board) return st.clean.canvas;
  if (st.clean?.pending !== board) {
    st.clean = { pending: board };
    const g0 = board.geom;
    runBoard('clean', st.pix.data, { xs: g0.xs, ys: g0.ys, cells: unpackCells(board.cells) }).then(out => {
      const cv = document.createElement('canvas');
      cv.width = out.width; cv.height = out.height;
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
      st.clean = { board, canvas: cv };
      if (st.step === 'grid' && st.board === board) app.rerender();
    }, e => { st.clean = null; st.showClean = false; toast(e.message, 'error'); app.rerender(); });
  }
  return st.pix?.canvas;
}

/** 原图上框出找到的网格（每 5 格一条红线），一眼看对没对齐 */
function gridPreview(src, board) {
  const g0 = board.geom;
  if (!src || !g0) return h('div');
  const xs = g0.xs || Array.from({ length: board.cols + 1 }, (_, i) => g0.x0 + (g0.x1 - g0.x0) * i / board.cols);
  const ys = g0.ys || Array.from({ length: board.rows + 1 }, (_, i) => g0.y0 + (g0.y1 - g0.y0) * i / board.rows);
  const pad = (xs[xs.length - 1] - xs[0]) / board.cols * 1.5;
  const sx = Math.max(0, xs[0] - pad), sy = Math.max(0, ys[0] - pad);
  const sw = Math.min(src.width, xs[xs.length - 1] + pad) - sx, sh = Math.min(src.height, ys[ys.length - 1] + pad) - sy;
  const maxW = Math.min(700, (window.innerWidth || 390) - 32), maxH = (window.innerHeight || 800) * 0.45;
  const k = Math.min(maxW / sw, maxH / sh);
  const cv = h('canvas.su-preview');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(sw * k * dpr); cv.height = Math.round(sh * k * dpr);
  cv.style.width = Math.round(sw * k) + 'px'; cv.style.height = Math.round(sh * k) + 'px';
  const g = cv.getContext('2d');
  g.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const K = k * dpr;
  g.strokeStyle = 'rgba(255,45,85,.9)'; g.lineWidth = 1.5 * dpr;
  g.beginPath();
  xs.forEach((x, i) => { if (i % 5 === 0 || i === xs.length - 1) { g.moveTo((x - sx) * K, (ys[0] - sy) * K); g.lineTo((x - sx) * K, (ys[ys.length - 1] - sy) * K); } });
  ys.forEach((y, i) => { if (i % 5 === 0 || i === ys.length - 1) { g.moveTo((xs[0] - sx) * K, (y - sy) * K); g.lineTo((xs[xs.length - 1] - sx) * K, (y - sy) * K); } });
  g.stroke();
  cv.addEventListener('click', () => openImageViewer(entriesFromImages([st.im]), { view: 'full', focus: false }));
  return h('div.su-prev-wrap', cv);
}

/** 手动校准：填列数行数，再在原图上点左上角、右下角 */
function manualGrid(app, p) {
  const b = st.board;
  const colsIn = h('input.input.num', { type: 'number', inputmode: 'numeric', min: 2, value: b?.cols || '', placeholder: '列数' });
  const rowsIn = h('input.input.num', { type: 'number', inputmode: 'numeric', min: 2, value: b?.rows || '', placeholder: '行数' });
  const s = sheet([
    h('p.small', '看图纸边上的编号，填网格一共有几列、几行（只算格子，不算写编号的边）。'),
    h('div.row.gap', h('label.grow', h('div.small.muted', '横向（列）'), colsIn), h('span', '×'), h('label.grow', h('div.small.muted', '竖向（行）'), rowsIn)),
    h('p.small.muted', { style: { marginTop: '10px' } }, '下一步会打开原图：先点网格左上角，再点右下角（可以双指放大点准一点）。'),
    h('div.row.gap.end', { style: { marginTop: '10px' } },
      h('button.btn.ghost', { onclick: () => s.close() }, '取消'),
      h('button.btn.primary', {
        onclick: () => {
          const cols = parseInt(colsIn.value, 10), rows = parseInt(rowsIn.value, 10);
          if (!(cols >= 2 && rows >= 2 && cols <= 300 && rows <= 300)) { toast('请填列数和行数', 'error'); return; }
          s.close();
          pickCorner(st.im, '点网格【左上角】那一格的左上角', c1 => {
            pickCorner(st.im, '再点网格【右下角】那一格的右下角', async c2 => {
              const x0 = Math.min(c1.x, c2.x), y0 = Math.min(c1.y, c2.y), x1 = Math.max(c1.x, c2.x), y1 = Math.max(c1.y, c2.y);
              if (x1 - x0 < cols * 3 || y1 - y0 < rows * 3) { toast('两个角离得太近了，再试一次', 'error'); return; }
              try {
                await ensurePixels(p);
                const dewatermark = app.settings.dewatermark !== false;
                const res = gridFromCorners(st.pix.data, { x0, y0, x1, y1, cols, rows, refs: merged(p), dewatermark });
                st.board = boardRecord(res, st.im.fullId, { manual: true, dewatermark });
                st.gridError = null;
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

// ---------- ③ 选拼豆板尺寸 ----------

async function pegStep(app, p, view) {
  const board = st.board;
  const b = beadBox(board);
  const settings = app.settings;
  const presets = (settings.pegboards?.length ? settings.pegboards : DEFAULT_PEGBOARDS).map(([w, hh]) => [w, hh]);
  const choose = (W, H) => {
    if (!fits(board, W, H)) { toast(`${W}×${H} 放不下这幅图`, 'error'); return; }
    const keepOffset = st.W === W && st.H === H;
    const P = keepOffset ? clampPlace(board, { W, H, ox: st.ox, oy: st.oy }) : centredPlace(board, W, H);
    Object.assign(st, { W, H, ox: P.ox, oy: P.oy, step: 'place' });
    app.rerender();
  };
  const savePresets = async list => { settings.pegboards = list; await store.saveSettings(settings); app.rerender(); };
  view.append(h('div.card.su-sum',
    h('div.row.between', h('span.small.muted', '这幅图有豆子的范围'), h('b', `${b.w} 列 × ${b.h} 行`)),
    h('div.tiny.muted', { style: { marginTop: '4px' } }, '拼豆板至少要这么大，放不下整幅图的尺寸不能选。')));
  view.append(h('div.section-title', '常用尺寸'));
  view.append(h('div.su-pegs', presets.map(([w, hh], i) => {
    const ok = fits(board, w, hh);
    return h('div.su-peg' + (ok ? '' : '.no') + (st.W === w && st.H === hh ? '.on' : ''),
      h('button.su-peg-main', { disabled: !ok, onclick: () => choose(w, hh) },
        h('b', `${w} × ${hh}`), h('span.tiny', ok ? `四周空 ${w - b.w} 列 · ${hh - b.h} 行` : '放不下')),
      h('button.su-peg-x', { 'aria-label': `从常用里删掉 ${w}×${hh}`, onclick: () => savePresets(presets.filter((_, j) => j !== i)) }, '✕'));
  }), !presets.length ? h('p.small.muted', '还没有常用尺寸，在下面输入一个。') : null));
  const wIn = h('input.input.num', { type: 'number', inputmode: 'numeric', min: 1, placeholder: '宽（列）', value: st.W && !presets.some(([w, hh]) => w === st.W && hh === st.H) ? st.W : '' });
  const hIn = h('input.input.num', { type: 'number', inputmode: 'numeric', min: 1, placeholder: '高（行）', value: st.W && !presets.some(([w, hh]) => w === st.W && hh === st.H) ? st.H : '' });
  const read = () => { const w = parseInt(wIn.value, 10), hh = parseInt(hIn.value, 10); if (!(w > 0 && hh > 0 && w <= 400 && hh <= 400)) { toast('请填拼豆板的宽和高（格数）', 'error'); return null; } return [w, hh]; };
  view.append(h('div.section-title', '自定义尺寸'),
    h('div.row.gap.su-custom', wIn, h('span', '×'), hIn),
    h('div.row.gap', { style: { marginTop: '8px' } },
      h('button.btn.primary', { onclick: () => { const v = read(); if (v) choose(...v); } }, '用这个尺寸'),
      h('button.btn.soft', {
        onclick: () => {
          const v = read(); if (!v) return;
          if (presets.some(([w, hh]) => w === v[0] && hh === v[1])) { toast('常用里已经有这个尺寸了'); return; }
          savePresets([...presets, v].sort((a, c) => a[0] * a[1] - c[0] * c[1]));
          toast(`已存为常用：${v[0]}×${v[1]}`, 'ok');
        },
      }, '存为常用')),
    h('div.section-title', '或者'),
    h('button.btn.ghost.block', { onclick: () => { Object.assign(st, { W: board.cols, H: board.rows, ox: 0, oy: 0, step: 'place' }); app.rerender(); } }, `按图纸原来的格子（${board.cols} × ${board.rows}）`));
}

// ---------- ④ 摆放：整体上下左右平移 ----------

function placeStep(app, p, view) {
  const board = { ...st.board, cells: unpackCells(st.board.cells) };
  const P0 = clampPlace(board, { W: st.W, H: st.H, ox: st.ox, oy: st.oy, mirror: !!p.board?.place?.mirror });
  Object.assign(st, { ox: P0.ox, oy: P0.oy });
  const stage = h('div.bd-stage');
  const layer = h('div.bd-layer');
  const canvas = h('canvas');
  layer.append(canvas);
  stage.append(layer);
  const { W, H } = boardSize({ ...P0 });
  const q = Math.max(1, Math.min(2.5, Math.sqrt(9e6 / (W * H))));
  canvas.width = Math.round(W * q); canvas.height = Math.round(H * q);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const b = beadBox(board);
  const readout = h('div.small.su-read');
  const redraw = () => {
    const P = { W: st.W, H: st.H, ox: st.ox, oy: st.oy, mirror: P0.mirror };
    drawBoard(canvas.getContext('2d'), q, board, { sel: null, done: new Set(), place: P, frame: true });
    const top = b.r0 + st.oy, left = b.c0 + st.ox;
    readout.textContent = `上空 ${top} 行 · 下空 ${st.H - top - b.h} 行 · 左空 ${left} 列 · 右空 ${st.W - left - b.w} 列`;
  };
  const move = (dx, dy) => {
    const P = clampPlace(board, { W: st.W, H: st.H, ox: st.ox + dx, oy: st.oy + dy });
    if (P.ox === st.ox && P.oy === st.oy) return false;
    st.ox = P.ox; st.oy = P.oy; redraw(); return true;
  };
  // 按住连续移动
  const arrow = (label, aria, dx, dy) => {
    const btn = h('button.su-arrow', { 'aria-label': aria }, label);
    let t = null, t2 = null;
    const stop = () => { clearTimeout(t); clearInterval(t2); t = t2 = null; };
    btn.addEventListener('pointerdown', e => { e.preventDefault(); move(dx, dy); t = setTimeout(() => { t2 = setInterval(() => { if (!move(dx, dy)) stop(); }, 70); }, 350); });
    btn.addEventListener('pointerup', stop); btn.addEventListener('pointerleave', stop); btn.addEventListener('pointercancel', stop);
    btn.addEventListener('click', e => { if (e.detail === 0) move(dx, dy); }); // 键盘
    return btn;
  };
  const pad = h('div.su-pad',
    h('span'), arrow('↑', '上移', 0, -1), h('span'),
    arrow('←', '左移', -1, 0), h('button.su-arrow.mid', { onclick: () => { const P = centredPlace(board, st.W, st.H); st.ox = P.ox; st.oy = P.oy; redraw(); } }, '居中'), arrow('→', '右移', 1, 0),
    h('span'), arrow('↓', '下移', 0, 1), h('span'));
  const panel = h('div.bd-tray.su-place',
    h('div.row.between', h('b', `拼豆板 ${st.W} × ${st.H}`), h('button.link.small', { onclick: () => { st.step = 'peg'; app.rerender(); } }, '换尺寸')),
    readout,
    h('div.row.gap.su-place-row', pad,
      h('div.grow.small.muted', '整幅图一起上下左右平移（按住连续移动），豆子不会超出拼豆板。浅色格子是拼豆板上空着的位置。')),
    h('button.btn.primary.block', {
      onclick: async () => {
        const place = { W: st.W, H: st.H, ox: st.ox, oy: st.oy, mirror: P0.mirror };
        await store.patchPattern(p.id, pp => ({ ...pp, board: { ...st.board, place }, boardError: null, boardSkip: false }));
        endSetup();
        toast(`已摆到 ${st.W}×${st.H} 的拼豆板上`, 'ok');
        app.rerender();
      },
    }, '完成，开始拼豆'));
  view.append(stage, panel);
  redraw();
  const pz = createPanZoom(stage, layer, { maxFit: 10 });
  app.onLeave = () => pz.destroy();
  requestAnimationFrame(() => pz.setContent(W, H));
}
