// 添加图纸 → 普通图片：选一张图（照片、插画、像素画）→ 生成图纸（选尺寸、颜色数、用哪些颜色、去背景…，实时预览）
// → 保存图纸（起名、分类、对照库存，和识别出来的图纸同一页）→ 之后和别的图纸一样：开始拼豆、扣库存、在 iPad 上拼。
// 也用于“重新生成”（图纸详情 ⋯）：换尺寸、颜色后直接改掉原来那张图纸。
import { h, clear, toast, sheet, chip, fmtNum, pickCode } from '../ui.js';
import * as store from '../store.js';
import { loadImageFile, makeCanvas, toDataURL, thumbnail, cropCanvas } from '../image.js';
import { cropper } from '../cropper.js';
import { CODES, seriesOf, rgbOf, nearestCodes } from '../palette.js';
import { runBoard } from '../boardasync.js';
import { snapToGrid, gridSize, opaqueBounds, hasTransparency } from '../photo.js';
import { drawChart, drawBeads, pixelThumb } from '../chart.js';
import { packCells } from '../board.js';
import { itemsSig } from './overview.js';
import { newId } from '../extract/index.js';
import { openImageViewer } from '../viewer.js';
import { startSession } from './recognize.js';
import { goPattern } from './patterns.js';
import { beadBox, fits, resetSetup } from './boardsetup.js';
import { readOnlyToast } from '../license.js';

/** 生成用的颜色里不放这些：珠光、果冻、夜光、温变、透明（效果特殊，“全部色卡”里才用） */
export const SPECIAL_SERIES = ['P', 'R', 'Y', 'Q', 'T'];
const MAX_SIDE = 2400;             // 选的图缩到长边这么大（生成、存原图都用这一张）
const SIZES = [30, 40, 50, 70, 100];
const COLOR_LIMITS = [0, 8, 12, 16, 24, 32];
const LONG_MAX = 200;

/** 生成出来的图纸（不是识别截图来的）：拼豆板就是“清单”，不用框选、核对 */
export const isGenerated = p => !!p?.gen;

function defaults(settings, native) {
  const d = settings.photoGen || {};
  return {
    size: native ? 'native' : (SIZES.includes(d.size) || (d.size >= 4 && d.size <= LONG_MAX) ? d.size : 50),
    maxColors: native ? 0 : (COLOR_LIMITS.includes(d.maxColors) ? d.maxColors : 16),
    set: ['normal', 'all', 'stock'].includes(d.set) ? d.set : 'normal',
    bg: true, dither: native ? false : !!d.dither,
    // 保留线条（轮廓线连成一条、保持原来的颜色）、细节多少（精细 / 适中 / 简洁）
    lines: d.lines !== false, detail: detailOf(d),
    exclude: [], replace: [],
  };
}

const DETAILS = [['simple', '简洁'], ['mid', '适中'], ['fine', '精细']];
/** 细节多少（旧版本存的“去掉零星杂点”开关：关 = 精细，开 = 适中） */
const detailOf = o => (DETAILS.some(([k]) => k === o?.detail) ? o.detail : o?.clean === false ? 'fine' : 'mid');

/** 一张图的状态（在 app.rec.photo 里，只在内存里） */
async function newState(canvas, name) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const pix = g.getImageData(0, 0, canvas.width, canvas.height);
  const transparent = hasTransparency(pix);
  const whole = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const auto = (transparent && opaqueBounds(pix)) || whole;
  let grid = null;
  try { grid = await runBoard('photoGrid', pix, {}); } catch (e) { console.warn(e); }
  return { sub: 'gen', canvas, name, transparent, whole, auto, rect: { ...auto }, grid, opts: null, result: null, prep: null, srcId: null, pid: null, sid: null };
}

/** 选了一张图 */
export async function pickPhoto(app, file) {
  if (app.readOnly) { readOnlyToast(app.readOnly); return; }
  let canvas, dataUrl;
  try {
    const big = await loadImageFile(file);
    const k = Math.min(1, MAX_SIDE / Math.max(big.width, big.height));
    canvas = big;
    if (k < 1) {
      canvas = makeCanvas(big.width * k, big.height * k);
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(big, 0, 0, canvas.width, canvas.height);
    }
    // 先按要存的格式（有透明的 PNG，否则 JPEG）编码一次再读回来：生成用的就是以后存着的那一张，
    // “重新生成”时同样的选项得到一模一样的图纸
    const transparent = hasTransparency(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height));
    dataUrl = transparent ? canvas.toDataURL('image/png') : toDataURL(canvas, 0.92);
    canvas = (await canvasOfDataUrl(dataUrl)).canvas;
  } catch (e) { toast('读取图片失败：' + e.message, 'error'); return; }
  const st = await newState(canvas, (file.name || '').replace(/\.[a-z0-9]+$/i, ''));
  st.dataUrl = dataUrl;
  st.opts = defaults(app.settings, !!nativeOf(st));
  app.rec.photo = st;
  app.rec.step = 'photo';
  app.render();
}

async function canvasOfDataUrl(url) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('图片打不开')); i.src = url; });
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, 0, 0);
  return { canvas: c };
}

/** 存着的原图 → canvas */
async function canvasOfImage(id) {
  const rec = await store.getImage(id);
  if (!rec) throw new Error('原图已经不在了，不能重新生成');
  return { canvas: (await canvasOfDataUrl(rec.dataUrl)).canvas, name: rec.name || '' };
}

async function stateFromGen(gen) {
  const { canvas, name } = await canvasOfImage(gen.srcId);
  const st = await newState(canvas, name);
  st.srcId = gen.srcId;
  if (gen.userRect) st.rect = { ...gen.userRect };
  st.opts = { ...defaults({}, false), ...gen.opts, detail: detailOf(gen.opts), lines: gen.opts?.lines !== false, exclude: [...(gen.opts?.exclude || [])], replace: (gen.opts?.replace || []).map(x => [...x]) };
  delete st.opts.clean;
  return st;
}

/** 保存页点“返回”：回到生成页（App 被系统回收过的话，从存着的原图恢复） */
export async function backToPhoto(app) {
  const s = app.rec.session;
  const st = app.rec.photo;
  if (!st || st.sid !== s.id) {
    try { app.rec.photo = Object.assign(await stateFromGen(s.gen), { sid: s.id }); } catch (e) { toast(e.message, 'error'); return; }
  }
  app.rec.step = 'photo';
  app.render();
}

/** 图纸详情 → 重新生成（换尺寸、颜色）：已经开始拼（打过勾、扣过库存）或拼完了的不行 */
export async function regenerate(app, p) {
  if (app.readOnly) { readOnlyToast(app.readOnly); return; }
  if (p.status === 'done' || store.buildTouched(p)) {
    toast(p.status === 'done' ? '这张已经拼完了：可以“复制一份”再重新生成' : '已经开始拼了（打过勾或扣过库存）：先“撤回为待拼”，或者“复制一份”再重新生成', 'error');
    return;
  }
  try {
    const st = await stateFromGen(p.gen);
    st.pid = p.id;
    app.rec.photo = st;
  } catch (e) { toast(e.message, 'error'); return; }
  app.pat.page = 'add';
  app.rec.step = 'photo';
  app.render();
}

// ---------- 页面 ----------

export async function renderPhoto(app) {
  const st = app.rec.photo;
  if (!st) { app.rec.step = 'pick'; return app.render(); }
  if (st.sub === 'crop') return cropPage(app, st);
  return genPage(app, st);
}

function cropPage(app, st) {
  app.setTitle('框选范围');
  app.setBack(() => { st.sub = 'gen'; app.render(); });
  const view = clear(app.view);
  const cr = cropper({ canvas: st.canvas, content: st.whole, rect: st.rect }, { maxVh: 58, fill: true });
  view.append(
    h('p.small.muted', '框出要拼的部分（只用图的一部分时）。拖角或边调大小，拖中间的 ✥ 移动；两指捏合或双击放大。'),
    cr.el,
    h('div.row.gap.wrap', { style: { marginTop: '6px' } },
      h('button.btn.soft.sm', { onclick: () => { st.rect = { ...st.whole }; app.rerender(); } }, '整张图'),
      st.auto.w !== st.whole.w || st.auto.h !== st.whole.h ? h('button.btn.soft.sm', { onclick: () => { st.rect = { ...st.auto }; app.rerender(); } }, '只框有东西的地方') : null,
      cr.tools),
    h('div.sticky-actions', h('button.btn.primary.block.big.pg-crop-done', {
      onclick: () => { st.rect = cr.get(); st.sub = 'gen'; st.result = null; app.render(); },
    }, '完成')));
}

/** 原图像素（像素画按原来的像素格；很小的图就是原大小）：{ rect, cols, rows, inner } 或 null */
function nativeOf(st) {
  if (st.grid) {
    const s = snapToGrid(st.grid, st.rect);
    if (s.cols >= 2 && s.rows >= 2 && Math.max(s.cols, s.rows) <= LONG_MAX) return { rect: { x: s.x, y: s.y, w: s.w, h: s.h }, cols: s.cols, rows: s.rows, inner: true };
    return null;
  }
  const r = st.rect;
  const w = Math.round(r.w), hh = Math.round(r.h);
  if (Math.max(w, hh) <= LONG_MAX && Math.min(w, hh) >= 2) return { rect: { x: Math.round(r.x), y: Math.round(r.y), w, h: hh }, cols: w, rows: hh, inner: false };
  return null;
}

/** 这次生成用的格子：{ rect, cols, rows, inner, native } */
function layoutOf(st) {
  const nat = nativeOf(st);
  if (st.opts.size === 'native' && nat) return { ...nat, native: true };
  const L = st.opts.size === 'native' ? 50 : st.opts.size;
  // 像素画换成别的尺寸：从原来的像素格缩放（不在像素边上混出中间色）
  if (st.grid && nat) return { rect: nat.rect, ...gridSize(nat.rect, L), inner: false, native: false, via: { cols: nat.cols, rows: nat.rows } };
  return { rect: st.rect, ...gridSize(st.rect, L), inner: false, native: false };
}

/** 能用的颜色 */
function codesFor(set, inv) {
  let codes = CODES.filter(c => !SPECIAL_SERIES.includes(seriesOf(c)));
  if (!codes.length || set === 'all') codes = [...CODES];
  if (set === 'stock') codes = CODES.filter(c => store.stockOf(inv, c) > 0);
  return codes;
}

/** 一格太多像素时先缩小（每格留约 16×16 个像素），送去后台线程的数据少一些 */
function prepared(st, L) {
  const key = [L.rect.x, L.rect.y, L.rect.w, L.rect.h].map(v => v.toFixed(2)).join() + `|${L.cols}x${L.rows}|${L.inner}|${!!L.via}`;
  if (st.prep?.key === key) return st.prep;
  const W = st.canvas.width, H = st.canvas.height, r = L.rect;
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(W, Math.ceil(r.x + r.w)), y1 = Math.min(H, Math.ceil(r.y + r.h));
  const k = L.inner || L.via ? 1 : Math.min(1, Math.max(16 * L.cols / r.w, 16 * L.rows / r.h));
  const cw = Math.max(1, Math.round((x1 - x0) * k)), ch = Math.max(1, Math.round((y1 - y0) * k));
  const c = makeCanvas(cw, ch);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(st.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, cw, ch);
  st.prep = { key, img: g.getImageData(0, 0, cw, ch), rect: { x: (r.x - x0) * (cw / (x1 - x0)), y: (r.y - y0) * (ch / (y1 - y0)), w: r.w * (cw / (x1 - x0)), h: r.h * (ch / (y1 - y0)) } };
  return st.prep;
}

/** 按现在的选项生成（在后台线程算）；算好了重画页面 */
function ensureResult(app, st, inv) {
  const L = layoutOf(st), o = st.opts;
  const codes = codesFor(o.set, inv).filter(c => !o.exclude.includes(c));
  // 像素画（原图像素、从原来的像素格缩放）一格就是一个像素：不找线条、不抹细节
  const pixel = L.native || !!L.via;
  const lines = !pixel && o.lines, detail = pixel ? 'fine' : o.detail;
  const key = JSON.stringify([L.rect, L.cols, L.rows, L.inner, L.via || null, codes, o.maxColors, o.bg, o.dither, lines, detail, o.replace]);
  if (st.result?.key === key) return { ready: true };
  if (st.want === key) return { ready: false };
  st.want = key;
  if (!codes.length) {
    st.result = { key, error: o.set === 'stock' ? '库存里还没有豆子：换成“标准色”，或者先去库存里录入' : '能用的颜色都被去掉了', L };
    st.want = null;
    return { ready: true };
  }
  const P = prepared(st, L);
  const args = { rect: P.rect, cols: L.cols, rows: L.rows, inner: L.inner, via: L.via || null, pal: codes.map(c => [c, ...rgbOf(c)]), maxColors: o.maxColors, bg: o.bg, dither: o.dither, lines, detail, replace: o.replace };
  runBoard('photo', P.img, args).then(res => {
    if (st.want !== key) return;
    st.want = null;
    st.result = { ...res, key, L, error: res.error || null };
    if (app.rec.photo === st && app.rec.step === 'photo' && st.sub === 'gen' && app.pat.page === 'add') app.rerender();
  }).catch(e => {
    if (st.want !== key) return;
    st.want = null;
    st.result = { key, L, error: e.message || String(e) };
    if (app.rec.photo === st && app.rec.step === 'photo') app.rerender();
  });
  return { ready: false };
}

const setOpt = (app, st, patch) => { Object.assign(st.opts, patch); app.rerender(); };

/** 拼豆效果的预览（点开全屏看：拼豆效果 / 原图） */
function previewEl(st, R) {
  const maxW = Math.min(560, (window.innerWidth || 390) - 32), maxH = (window.innerHeight || 800) * 0.46;
  const cell = Math.min(maxW / R.cols, maxH / R.rows);
  const cv = h('canvas.pg-canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(R.cols * cell * dpr); cv.height = Math.round(R.rows * cell * dpr);
  cv.style.width = Math.round(R.cols * cell) + 'px'; cv.style.height = Math.round(R.rows * cell) + 'px';
  drawBeads(cv.getContext('2d'), R, cell * dpr);
  cv.addEventListener('click', () => {
    const big = Math.max(6, Math.min(16, Math.floor(2400 / Math.max(R.cols, R.rows))));
    const bc = makeCanvas(R.cols * big, R.rows * big);
    drawBeads(bc.getContext('2d'), R, big);
    const r = R.L.rect;
    const src = cropCanvas(st.canvas, { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(st.canvas.width - Math.max(0, r.x), r.w), h: Math.min(st.canvas.height - Math.max(0, r.y), r.h) }, Math.min(1, 2000 / Math.max(r.w, r.h)));
    openImageViewer([{ name: '生成的图纸', views: [
      { key: 'beads', label: '拼豆效果', src: bc.toDataURL('image/png'), w: bc.width, h: bc.height },
      { key: 'photo', label: '原图', src: src.toDataURL('image/jpeg', 0.9), w: src.width, h: src.height },
    ] }], { view: 'beads', focus: false });
  });
  return h('div.pg-prev', cv);
}

/** 这个尺寸放得进哪块常用的拼豆板 */
function boardHint(settings, cols, rows) {
  const presets = (settings.pegboards?.length ? settings.pegboards : [[52, 52], [78, 78], [104, 104]]).slice().sort((a, b) => a[0] * a[1] - b[0] * b[1]);
  const fit = presets.find(([w, hh]) => (cols <= w && rows <= hh) || (cols <= hh && rows <= w));
  return fit ? `放得进 ${fit[1]}×${fit[0]} 的拼豆板` : '比常用的拼豆板都大，要几块板拼在一起';
}

async function genPage(app, st) {
  const s = app.settings;
  if (!st.opts) st.opts = defaults(s, !!nativeOf(st));
  const o = st.opts;
  app.setTitle(st.pid ? '重新生成图纸' : '生成图纸');
  app.setBack(() => {
    if (st.pid) { const pid = st.pid; app.rec.photo = null; app.rec.step = 'pick'; app.pat.page = 'detail'; app.pat.id = pid; return app.render(); }
    app.rec.photo = null; app.rec.step = 'pick'; app.render();
  });
  const view = clear(app.view);
  const inv = await store.getInventory();
  const { ready } = ensureResult(app, st, inv);
  const R = st.result;
  const nat = nativeOf(st);
  const L = layoutOf(st);
  const busy = !ready;

  // 预览
  if (R && !R.error) {
    const prev = previewEl(st, R);
    if (busy) prev.append(h('div.pg-busy', h('div.spinner')));
    view.append(prev);
    view.append(h('div.row.between.pg-sum',
      h('div', h('b', `${R.cols} × ${R.rows}`), h('span.small.muted', ` · ${fmtNum(R.beads)} 颗 · ${R.codes.length} 色`)),
      h('div.row.gap-s',
        h('button.btn.sm.soft.pg-crop', { onclick: () => { st.sub = 'crop'; app.render(); } }, '✂️ 框选'),
        st.pid ? null : anotherBtn(app))));
    view.append(h('p.tiny.muted.center', { style: { margin: '2px 0 0' } }, '点图全屏看（拼豆效果 / 原图对照）'));
  } else if (R?.error) {
    view.append(h('div.banner.bad', h('span.ico', '⚠️'), h('div', h('b', '生成不了'), h('div.small', R.error))));
    view.append(h('div.row.end.gap-s', h('button.btn.sm.soft.pg-crop', { onclick: () => { st.sub = 'crop'; app.render(); } }, '✂️ 框选'), st.pid ? null : anotherBtn(app)));
  } else {
    view.append(h('div.bd-wait', h('div.spinner'), h('p.small.muted', '正在生成图纸…')));
  }
  if (st.grid && nat && !busy) {
    view.append(h('div.banner.info.pg-pixel', h('span.ico', '👾'), h('div.small', `这是放大过的像素画，原来是 ${nat.cols} × ${nat.rows} 格`, o.size === 'native' ? '：按原来的像素一格一颗，颜色一点不糊。' : '。选“原图像素”可以一格一颗。')));
  }

  // 尺寸
  const sizes = [...(nat ? ['native'] : []), ...SIZES];
  const custom = typeof o.size === 'number' && !SIZES.includes(o.size);
  view.append(h('div.section-title', '尺寸（最长的一边几颗豆子）'),
    h('div.tag-pick.pg-sizes',
      sizes.map(v => h('button.tagopt' + (o.size === v ? '.on' : ''), { 'data-size': String(v), onclick: () => setOpt(app, st, { size: v }) },
        v === 'native' ? `原图像素 ${nat.cols}×${nat.rows}` : String(v))),
      h('button.tagopt' + (custom ? '.on' : ''), { 'data-size': 'custom', onclick: () => customSize(app, st) }, custom ? `自定义 ${o.size}` : '自定义…')),
    h('div.tiny.muted.pg-fit', { style: { margin: '6px 2px 0' } }, `${L.cols} × ${L.rows} 格，${boardHint(s, L.cols, L.rows)}`));

  // 颜色数
  view.append(h('div.section-title', '最多用几种颜色'),
    h('div.tag-pick.pg-limits', COLOR_LIMITS.map(k => h('button.tagopt' + (o.maxColors === k ? '.on' : ''), { 'data-k': String(k), onclick: () => setOpt(app, st, { maxColors: k }) }, k ? String(k) : '不限'))),
    h('div.tiny.muted', { style: { margin: '6px 2px 0' } }, '颜色少：好拼、少买几种豆子；颜色多：更像原图。限了颜色数时会挑最能还原整张图的那几种。'));

  // 用哪些颜色
  const nStock = CODES.filter(c => store.stockOf(inv, c) > 0).length;
  const nNormal = CODES.filter(c => !SPECIAL_SERIES.includes(seriesOf(c))).length;
  view.append(h('div.section-title', '用哪些颜色（当前色卡）'),
    h('div.seg.pg-set',
      h('button' + (o.set === 'normal' ? '.on' : ''), { 'data-set': 'normal', onclick: () => setOpt(app, st, { set: 'normal' }) }, `标准色 ${nNormal}`),
      h('button' + (o.set === 'all' ? '.on' : ''), { 'data-set': 'all', onclick: () => setOpt(app, st, { set: 'all' }) }, `全部 ${CODES.length}`),
      h('button' + (o.set === 'stock' ? '.on' : ''), { 'data-set': 'stock', disabled: !nStock, onclick: () => setOpt(app, st, { set: 'stock' }) }, `有库存的 ${nStock}`)),
    h('div.tiny.muted', { style: { margin: '6px 2px 0' } }, o.set === 'all' ? '包括珠光、果冻、夜光等特殊效果的豆子。' : o.set === 'stock' ? '只用库存里还有的颜色（数量够不够看下面）。' : '不用珠光、果冻、夜光、温变、透明这些特殊效果的豆子。'));

  // 开关
  const sw = (cls, on, title, note, patch) => {
    const input = h('input', { type: 'checkbox', checked: on, role: 'switch' });
    input.addEventListener('change', () => setOpt(app, st, patch(input.checked)));
    return h('div.kv.' + cls, h('div.grow', h('div.k', title), h('div.d', note)), h('label.switch', input, h('span')));
  };
  const toggles = [];
  if (st.transparent) toggles.push(h('div.kv.pg-transp', h('div.grow', h('div.k', '透明的地方不放豆子'), h('div.d', '这张图有透明背景'))));
  if (R?.bgFound || (R && R.bgRemoved)) toggles.push(sw('pg-bg', o.bg, '去掉背景', `四周的${bgName(R.bgRgb)}背景不放豆子${o.bg && R.bgRemoved ? `（省 ${fmtNum(R.bgRemoved)} 颗）` : ''}`, v => ({ bg: v })));
  const pixel = L.native || !!L.via;
  if (pixel) {
    toggles.push(h('div.kv.pg-pixnote', h('div.grow', h('div.k', '按原来的像素'), h('div.d', '像素画一格就是一个像素：不找线条、不抹细节，颜色原样。'))));
  } else {
    toggles.push(sw('pg-lines', o.lines, '保留线条', `轮廓线、描边接成一条，保持线条原来的颜色，不会被缩没、断成点${o.lines && R?.lineCells ? ` · ${fmtNum(R.lineCells)} 格是线条` : ''}`, v => ({ lines: v })));
    toggles.push(h('div.kv.pg-detail', h('div.grow', h('div.k', '细节'),
      h('div.d', o.detail === 'simple' ? '简洁：小块的颜色、细碎的明暗都并到周围，色块大、好拼' : o.detail === 'fine' ? '精细：原样保留每个小细节（照片会比较碎）' : '适中：细碎的杂色、纹理并到周围，眼睛这类和周围差得多的小细节留着')),
      h('div.seg.pg-detail-seg', DETAILS.map(([k, label]) => h('button' + (o.detail === k ? '.on' : ''), { 'data-detail': k, onclick: () => setOpt(app, st, { detail: k }) }, label)))));
    toggles.push(sw('pg-dither', o.dither, '抖动（颜色过渡更自然）', '用几种颜色的豆子掺着拼出中间色，适合照片；豆子会更零散（打开时不并小块）', v => ({ dither: v })));
  }
  view.append(h('div.section-title', '线条和细节'), h('div.card.pg-opts', toggles));

  // 用到的颜色（点一下可以换掉）
  if (R && !R.error) view.append(colorsCard(app, st, R, inv));

  view.append(h('div.sticky-actions',
    h('button.btn.primary.big.block.pg-next', { disabled: busy || !R || !!R.error, onclick: () => finish(app, st) },
      st.pid ? '保存修改' : '下一步：保存图纸')));
}

function anotherBtn(app) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) pickPhoto(app, f); });
  return h('label.btn.sm.soft.pg-another', input, '换图');
}

function bgName(rgb) {
  if (!rgb) return '纯色';
  const [r, g, b] = rgb;
  if (Math.min(r, g, b) > 225) return '白色';
  if (Math.max(r, g, b) < 40) return '黑色';
  return '纯色';
}

function customSize(app, st) {
  const input = h('input.input.num', { type: 'number', inputmode: 'numeric', min: 4, max: LONG_MAX, value: typeof st.opts.size === 'number' ? st.opts.size : 50 });
  const s = sheet([
    h('p.small', '最长的一边几颗豆子（另一边按图的比例）。'),
    h('div.row.gap', input, h('span', '颗')),
    h('p.tiny.muted', { style: { marginTop: '8px' } }, `4 到 ${LONG_MAX}。52×52 的拼豆板中间是 50 颗，78×78 是 70 颗，104×104 是 100 颗。`),
    h('div.row.gap.end', { style: { marginTop: '10px' } },
      h('button.btn.ghost', { onclick: () => s.close() }, '取消'),
      h('button.btn.primary', {
        onclick: () => {
          const v = parseInt(input.value, 10);
          if (!(v >= 4 && v <= LONG_MAX)) { toast(`请填 4 到 ${LONG_MAX}`, 'error'); return; }
          s.close(); setOpt(app, st, { size: v });
        },
      }, '确定')),
  ], { title: '自定义尺寸' });
  setTimeout(() => input.focus(), 50);
}

function colorsCard(app, st, R, inv) {
  const o = st.opts, settings = app.settings;
  const rows = R.codes.map((code, k) => {
    const n = R.counts[k], need = store.needOf(n, settings), stock = store.stockOf(inv, code);
    return { code, n, need, stock, short: stock < need };
  });
  // 库存还是空的（还没录过）：不一个个标“缺”，满屏红色没有意义
  const anyStock = CODES.some(c => store.stockOf(inv, c) > 0);
  if (!anyStock) for (const r of rows) r.short = false;
  const short = rows.filter(r => r.short);
  const card = h('div.card.pg-colors',
    h('div.row.between', h('b', `用到的颜色（${rows.length}）`), h('span.tiny.muted', '点颜色可以换掉')),
    !anyStock ? h('div.tiny.muted', { style: { marginTop: '2px' } }, '库存还是空的；录了库存以后，这里会标出哪些颜色不够。') : null,
    short.length ? h('div.small.warn-t.pg-short', { style: { margin: '4px 0 2px' } }, `${short.length} 种库存不够（共缺 ${fmtNum(short.reduce((a, r) => a + r.need - r.stock, 0))} 颗）`,
      o.set !== 'stock' && CODES.some(c => store.stockOf(inv, c) > 0) ? h('button.link.small', { style: { marginLeft: '6px' }, onclick: () => setOpt(app, st, { set: 'stock' }) }, '只用有库存的 ›') : null) : null,
    h('div.colors-chips.pg-chips', { style: { marginTop: '8px' } }, rows.map(r => h('button.colors-chip.pg-chip' + (r.short ? '.short' : ''), { 'data-code': r.code, onclick: () => colorSheet(app, st, r.code) },
      chip(r.code, { size: 'sm' }), h('span.n', fmtNum(r.n)), r.short ? h('span.tiny.bad-t', `缺 ${fmtNum(r.need - r.stock)}`) : null))));
  const undo = [
    ...o.exclude.map(c => h('button.tagchip.pg-undo', { 'data-code': c, onclick: () => setOpt(app, st, { exclude: o.exclude.filter(x => x !== c) }) }, `不用 ${c} ✕`)),
    ...o.replace.map(([a, b]) => h('button.tagchip.pg-undo', { 'data-code': a, onclick: () => setOpt(app, st, { replace: o.replace.filter(x => x[0] !== a) }) }, `${a} → ${b} ✕`)),
  ];
  if (undo.length) card.append(h('div.row.wrap.gap-s.pg-undos', { style: { marginTop: '10px' } }, h('span.tiny.muted', '已改：'), undo));
  return card;
}

function colorSheet(app, st, code) {
  const o = st.opts;
  const s = sheet(h('div.menu',
    h('button.pg-replace', {
      onclick: async () => {
        s.close();
        const sug = nearestCodes(rgbOf(code), 7).map(x => x.code).filter(c => c !== code);
        const to = await pickCode({ current: null, suggestions: sug, title: `${code} 换成哪个颜色？` });
        if (!to || to === code) return;
        setOpt(app, st, { replace: [...o.replace.filter(x => x[0] !== code), [code, to]] });
        toast(`${code} 都换成了 ${to}`, 'ok');
      },
    }, '🎨 换成别的颜色（整种换掉）'),
    h('button.pg-exclude', {
      onclick: () => {
        s.close();
        // 本来就是“换成”的颜色：去掉那条替换；否则不用这个色号，让它自动换成最接近的
        const rep = o.replace.find(x => x[1] === code);
        if (rep) setOpt(app, st, { replace: o.replace.filter(x => x !== rep), exclude: [...new Set([...o.exclude, code])] });
        else setOpt(app, st, { exclude: [...new Set([...o.exclude, code])] });
        toast(`不用 ${code} 了，换成了最接近的颜色`, 'ok');
      },
    }, '🚫 不用这个颜色（自动换成最接近的）'),
  ), { title: code });
}

// ---------- 保存 ----------

/** 生成的拼豆板在原图上的格子（核对、修正格子时看原图上这一格） */
function geomOn(rect, cols, rows) {
  const xs = Array.from({ length: cols + 1 }, (_, i) => Math.round(rect.x + rect.w * i / cols));
  const ys = Array.from({ length: rows + 1 }, (_, i) => Math.round(rect.y + rect.h * i / rows));
  return { x0: xs[0], y0: ys[0], x1: xs[cols], y1: ys[rows], xs, ys };
}

async function finish(app, st) {
  const R = st.result;
  if (!R || R.error) return;
  if (app.readOnly) { readOnlyToast(app.readOnly); return; }
  const btn = app.view.querySelector('.pg-next');
  if (btn) { btn.disabled = true; btn.textContent = '正在画图纸…'; }
  try {
    const { cols, rows, codes, cells, counts, beads } = R;
    if (!st.srcId) st.srcId = await store.putImage({ dataUrl: st.dataUrl, w: st.canvas.width, h: st.canvas.height, name: st.name || '原图' });
    const pat = { cols, rows, codes, cells, counts };
    const ch = drawChart(pat);
    const chartId = await store.putImage({ dataUrl: ch.canvas.toDataURL('image/png'), w: ch.canvas.width, h: ch.canvas.height, name: '图纸' });
    const board = {
      v: 2, rows, cols, codes: [...codes], cells: packCells(cells), stats: { beads }, imageId: st.srcId,
      geom: geomOn(R.L.rect, cols, rows), review: { risks: [], uncertain: [] }, locks: [], createdAt: Date.now(), edits: 0, gen: true,
    };
    const images = [
      { name: '图纸', fullId: chartId, fw: ch.canvas.width, fh: ch.canvas.height, thumb: pixelThumb(pat), legend: ch.legend },
      { name: '原图', fullId: st.srcId, fw: st.canvas.width, fh: st.canvas.height, thumb: thumbnail(cropCanvas(st.canvas, st.whole), 320) },
    ];
    const o = st.opts;
    const gen = {
      v: 1, srcId: st.srcId, rect: R.L.rect, userRect: { ...st.rect }, cols, rows, native: !!R.L.native,
      opts: { size: o.size, maxColors: o.maxColors, set: o.set, bg: o.bg, dither: o.dither, lines: o.lines, detail: o.detail, exclude: [...o.exclude], replace: o.replace.map(x => [...x]) },
      at: Date.now(),
    };
    // 下次默认用这次的选项（像素画的“原图像素”不算）
    app.settings.photoGen = { size: o.size === 'native' ? (app.settings.photoGen?.size || 50) : o.size, maxColors: R.L.native ? (app.settings.photoGen?.maxColors ?? 16) : o.maxColors, set: o.set, dither: o.dither, lines: o.lines, detail: o.detail };
    await store.saveSettings(app.settings);
    const items = codes.map((code, k) => ({ id: newId(), img: null, code, rawCode: code, count: counts[k], box: null, rgb: null, uncertain: false, verified: true, orig: { code, count: counts[k] } }));
    if (st.pid) return saveRegenerated(app, st, { board, images, items, gen });
    startSession(app, { method: 'photo', images, items, statedTotal: beads, statedColors: codes.length });
    const s = app.rec.session;
    // 文件名有意义就拿来当图纸名字（相机、截图默认的 IMG_1234 之类不要）
    if (st.name && !/^(img|dsc|dcim|pxl|image|photo|screenshot|截屏|屏幕快照|微信图片|mmexport)([_\- ]?\d.*)?$/i.test(st.name) && !/^\d+$/.test(st.name) && st.name.length <= 30) s.name = st.name;
    Object.assign(s, { gen, boardPre: { sig: itemsSig(items), board }, mode: 'list' });
    st.sid = s.id;
    app.rec.step = 'preview';
    app.saveSession();
    app.render();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error');
    if (btn) { btn.disabled = false; btn.textContent = st.pid ? '保存修改' : '下一步：保存图纸'; }
  }
}

/** 重新生成：直接改掉原来那张图纸（拼豆板一样大时，选过的拼豆板尺寸和摆放位置照旧） */
async function saveRegenerated(app, st, { board, images, items, gen }) {
  const p = await store.getPattern(st.pid);
  if (!p) throw new Error('图纸不存在了');
  if (p.status === 'done' || store.buildTouched(p)) throw new Error('这张图纸已经开始拼了，不能重新生成');
  const old = p.board;
  let place = null;
  if (old?.place && old.rows === board.rows && old.cols === board.cols) {
    const P = old.place;
    const nb = { ...board };
    const b = beadBox(nb);
    if (P.native || (fits(nb, P.W, P.H) && b.c0 + P.ox >= 0 && b.r0 + P.oy >= 0 && b.c1 + P.ox < P.W && b.r1 + P.oy < P.H)) place = P;
  }
  const oldImgs = (p.imageIds || []).filter(id => id !== gen.srcId);
  await store.patchPattern(p.id, pp => ({
    ...pp,
    items: items.map(i => ({ code: i.code, count: i.count })),
    board: { ...board, ...(place ? { place } : {}) },
    images: images.map(im => ({ fullId: im.fullId, fw: im.fw, fh: im.fh, name: im.name, legend: im.legend || null })),
    imageIds: images.map(im => im.fullId),
    thumbs: images.map(im => im.thumb).filter(Boolean),
    statedTotal: board.stats.beads, gen, boardError: null,
  }));
  store.deleteImagesIfUnused(oldImgs);
  resetSetup(p.id);
  app.rec.photo = null; app.rec.step = 'pick';
  toast(place ? '已重新生成（拼豆板尺寸、位置照旧）' : '已重新生成；开始拼豆时再选拼豆板尺寸', 'ok');
  return goPattern(app, p.id);
}
