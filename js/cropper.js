// 可拖动的框选器（框清单、框拼豆板共用）。
// 拖四个角、四条边调大小，拖框中间的 ✥ 移动整个框；两指捏合 / 双击 / ＋－ 放大缩小，放大后单指拖别处是挪图片。
// 防误触：手指没按在角、边、✥ 上时不会改框（以前点框外会重新画框、拖框里会挪框）；
// 两指缩放时如果第一根手指先碰到了角，第二根手指一放上去框就退回原样。
// 拖角拖到边上时（放大了的话）图片会自己往那边挪，不用松手。
import { h } from './ui.js';
import { cropCanvas } from './image.js';

const CORNER_TOL = 30;  // 手指离角多近算按到角（屏幕像素）
const EDGE_TOL = 18;    // 离边多近算按到边
const MIN = 0.02;       // 框最小（占图片的比例）
const MAX_ZOOM = 8;     // 最多放大到“整张图”的几倍
const OVER = 0.35;      // 放大后图片边缘最多可以挪到视窗里多远（视窗的比例）：边上的角可以挪到中间来调
const MARGIN = 20;      // fill 模式：图片四周留的空（角不贴着屏幕边）

/**
 * 可拖动的框选器。work.rect 为原图坐标；返回 { el, tools, get() }
 * fill：视窗占满宽度（高度最多 maxVh），图片四周留空；否则视窗和图片一样大（宽度不超过 100%、高度不超过 maxVh）
 * tools：缩放按钮（－ ＋），调用的页面放在合适的地方
 */
export function cropper(work, { maxVh = 62, fill = false } = {}) {
  const c = work.content;
  // 原图分辨率显示（放大了也清楚），太大的图（几张拼起来的）缩一点
  const disp = cropCanvas(work.canvas, c, Math.min(1, Math.sqrt(6e6 / (c.w * c.h))));
  disp.className = 'crop-img';
  const IW = disp.width, IH = disp.height;
  const wrap = h('div.crop-wrap' + (fill ? '.fill' : ''), disp);
  if (!fill) {
    wrap.style.aspectRatio = `${c.w} / ${c.h}`;
    wrap.style.width = `min(100%, calc(${maxVh}vh * ${(c.w / c.h).toFixed(4)}))`;
  }
  const M = fill ? MARGIN : 0;
  // 框：用 0–1 的比例保存
  let f = { x: (work.rect.x - c.x) / c.w, y: (work.rect.y - c.y) / c.h, w: work.rect.w / c.w, h: work.rect.h / c.h };
  const box = h('div.crop-rect');
  const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e', 'c'].map(k => h('div.hd' + (k.length === 1 ? (k === 'c' ? '.mv' : '.ed') : ''), { 'data-k': k }, k === 'c' ? '✥' : null));
  box.append(...handles);
  wrap.append(box);

  // 视图：图片左上角在 (tx, ty)，1 个图片像素 = s 个屏幕像素
  let W = 0, H = 0, fitS = 0;
  let view = { s: 1, tx: 0, ty: 0 };
  const zoomed = () => fitS && view.s > fitS * 1.01;

  const clampView = () => {
    view.s = Math.min(fitS * MAX_ZOOM, Math.max(fitS, view.s));
    const axis = (t, size, V) => (size <= V - 2 * M + 0.5 ? (V - size) / 2 : Math.min(V * OVER, Math.max(V - size - V * OVER, t)));
    view.tx = axis(view.tx, IW * view.s, W);
    view.ty = axis(view.ty, IH * view.s, H);
  };
  const boxScreen = () => {
    const k = view.s;
    return { x0: view.tx + f.x * IW * k, y0: view.ty + f.y * IH * k, x1: view.tx + (f.x + f.w) * IW * k, y1: view.ty + (f.y + f.h) * IH * k };
  };
  const place = () => {
    const r = boxScreen(), bw = r.x1 - r.x0, bh = r.y1 - r.y0;
    Object.assign(box.style, { left: r.x0 + 'px', top: r.y0 + 'px', width: bw + 'px', height: bh + 'px' });
    box.classList.toggle('no-mv', bw < 90 || bh < 90);   // 框太小：不显示中间的 ✥（免得和角挤在一起）
    box.classList.toggle('no-ed', bw < 70 || bh < 70);
  };
  let zoomBtns = null;
  const apply = () => {
    disp.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
    wrap.classList.toggle('zoomed', !!zoomed());
    place();
    if (zoomBtns) { zoomBtns.out.disabled = !zoomed(); zoomBtns.in.disabled = view.s >= fitS * MAX_ZOOM * 0.99; }
  };
  const layout = () => {
    if (!wrap.isConnected || !wrap.clientWidth) return;
    if (fill) {
      const w0 = wrap.clientWidth;
      wrap.style.height = Math.round(Math.min(innerHeight * maxVh / 100, (w0 - 2 * M) * IH / IW + 2 * M)) + 'px';
    }
    const rel = fitS ? view.s / fitS : 1;
    W = wrap.clientWidth; H = wrap.clientHeight;
    fitS = Math.min((W - 2 * M) / IW, (H - 2 * M) / IH);
    view.s = fitS * rel;
    clampView(); apply();
  };
  new ResizeObserver(layout).observe(wrap);

  /** 以屏幕上的 (x, y) 为中心缩放到 s */
  const zoomAt = (s, x = W / 2, y = H / 2) => {
    const ix = (x - view.tx) / view.s, iy = (y - view.ty) / view.s;
    view.s = s; view.tx = x - ix * s; view.ty = y - iy * s;
    clampView(); apply();
  };
  let anim = 0;
  const animateTo = (s, x, y) => {
    cancelAnimationFrame(anim);
    const from = { ...view };
    zoomAt(s, x, y);
    const to = { ...view };
    view = from;
    const t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / 180), e = 1 - (1 - k) ** 3;
      view = { s: from.s + (to.s - from.s) * e, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e };
      apply();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  };

  // ---- 手势 ----
  const pts = new Map();           // 按着的手指
  let drag = null;                 // 拖角 / 边 / ✥
  let pinch = null, pan = null;
  let tap = null, lastTap = null;  // 双击放大
  let raf = 0;

  const local = e => { const b = wrap.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const toImg = (x, y) => ({ u: (x - view.tx) / (IW * view.s), v: (y - view.ty) / (IH * view.s) });

  const hitTest = (x, y) => {
    const r = boxScreen();
    let best = null, bd = CORNER_TOL;
    for (const [k, cx, cy] of [['nw', r.x0, r.y0], ['ne', r.x1, r.y0], ['sw', r.x0, r.y1], ['se', r.x1, r.y1]]) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < bd) { bd = d; best = k; }
    }
    if (best) return best;
    if (!box.classList.contains('no-mv') && Math.hypot(x - (r.x0 + r.x1) / 2, y - (r.y0 + r.y1) / 2) < 26) return 'c';
    const inX = x > r.x0 && x < r.x1, inY = y > r.y0 && y < r.y1;
    const cand = [];
    if (inX) cand.push(['n', Math.abs(y - r.y0)], ['s', Math.abs(y - r.y1)]);
    if (inY) cand.push(['w', Math.abs(x - r.x0)], ['e', Math.abs(x - r.x1)]);
    const e = cand.filter(([, d]) => d < EDGE_TOL).sort((a, b) => a[1] - b[1])[0];
    return e ? e[0] : null;
  };

  const applyDrag = () => {
    const p = toImg(drag.x, drag.y), du = p.u - drag.p0.u, dv = p.v - drag.p0.v, f0 = drag.f0;
    if (drag.mode === 'c') {
      f = { ...f0, x: Math.min(1 - f0.w, Math.max(0, f0.x + du)), y: Math.min(1 - f0.h, Math.max(0, f0.y + dv)) };
    } else {
      let x0 = f0.x, y0 = f0.y, x1 = f0.x + f0.w, y1 = f0.y + f0.h;
      const m = drag.mode;
      if (m.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, f0.x + du));
      if (m.includes('e')) x1 = Math.max(x0 + MIN, Math.min(1, f0.x + f0.w + du));
      if (m.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, f0.y + dv));
      if (m.includes('s')) y1 = Math.max(y0 + MIN, Math.min(1, f0.y + f0.h + dv));
      f = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    place();
  };
  // 拖角拖到视窗边上：图片自己往那边挪（放大了才有得挪）
  const autoPan = () => {
    raf = 0;
    if (!drag?.active || !zoomed()) return;
    const E = 36;
    const vx = drag.x < E ? E - drag.x : drag.x > W - E ? W - E - drag.x : 0;
    const vy = drag.y < E ? E - drag.y : drag.y > H - E ? H - E - drag.y : 0;
    if (vx || vy) {
      const tx = view.tx, ty = view.ty;
      view.tx += vx * 0.15; view.ty += vy * 0.15;
      clampView();
      if (view.tx !== tx || view.ty !== ty) { apply(); applyDrag(); }
    }
    raf = requestAnimationFrame(autoPan);
  };

  const startPinch = () => {
    const [a, b] = [...pts.values()];
    if (drag) { f = drag.f0; drag = null; place(); } // 第一根手指碰到的角退回原样
    pan = null; tap = null;
    pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...view } };
  };
  const startPan = p => { pan = { x0: p.x, y0: p.y, v0: { ...view } }; };

  wrap.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { wrap.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    cancelAnimationFrame(anim);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size >= 2) { startPinch(); return; }
    const mode = hitTest(p.x, p.y);
    if (mode) drag = { mode, f0: { ...f }, p0: toImg(p.x, p.y), sx: p.x, sy: p.y, x: p.x, y: p.y, active: false };
    else { startPan(p); tap = { x: p.x, y: p.y, t: e.timeStamp }; }
  });
  wrap.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { v0, m0 } = pinch;
      const s = Math.min(fitS * MAX_ZOOM, Math.max(fitS, v0.s * d / pinch.d0));
      const ix = (m0.x - v0.tx) / v0.s, iy = (m0.y - v0.ty) / v0.s;
      view = { s, tx: m.x - ix * s, ty: m.y - iy * s };
      clampView(); apply();
    } else if (drag) {
      drag.x = p.x; drag.y = p.y;
      if (!drag.active && Math.hypot(p.x - drag.sx, p.y - drag.sy) < 4) return; // 手抖不算
      drag.active = true;
      applyDrag();
      if (!raf) raf = requestAnimationFrame(autoPan);
    } else if (pan) {
      if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > 10) tap = null;
      view = { ...pan.v0, tx: pan.v0.tx + p.x - pan.x0, ty: pan.v0.ty + p.y - pan.y0 };
      clampView(); apply();
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size < 2) { pinch = null; const rest = [...pts.values()][0]; if (rest) startPan(rest); }
      return;
    }
    if (drag) { drag = null; return; }
    if (tap && e.type === 'pointerup' && e.timeStamp - tap.t < 300) {
      const p = local(e);
      if (lastTap && e.timeStamp - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
        lastTap = null;
        if (zoomed()) animateTo(fitS); else animateTo(fitS * 3, p.x, p.y);
      } else lastTap = { x: p.x, y: p.y, t: e.timeStamp };
    }
    tap = null; pan = null;
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const p = local(e);
    zoomAt(view.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
  }, { passive: false });
  wrap.addEventListener('gesturestart', e => e.preventDefault()); // iPhone：别让整个页面跟着缩放

  const zout = h('button.btn.soft.sm.crop-zout', { type: 'button', 'aria-label': '缩小', onclick: () => animateTo(view.s / 1.8) }, '－');
  const zin = h('button.btn.soft.sm.crop-zin', { type: 'button', 'aria-label': '放大', onclick: () => animateTo(view.s * 1.8) }, '＋');
  zoomBtns = { in: zin, out: zout };
  const tools = h('div.crop-zoom', zout, zin);

  const api = {
    el: wrap,
    tools,
    get: () => ({ x: c.x + f.x * c.w, y: c.y + f.y * c.h, w: f.w * c.w, h: f.h * c.h }),
  };
  wrap._crop = { get: api.get, view: () => ({ ...view, fit: fitS }) }; // 测试用
  return api;
}
