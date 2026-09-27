// 全屏看图：双指缩放、单指拖动、双击放大；可在“清单 / 整张图”之间切换，多张图左右翻。
import { h, toast } from './ui.js';
import { getImage } from './store.js';

/** 清单参考图上的框 → 整张图上的框（fullMap 见 extract/index.js 的 saveFullImage） */
export function toFullBox(b, img) {
  const m = img?.fullMap;
  if (!b || !m) return null;
  return { x0: b.x0 * m.k + m.ox, y0: b.y0 * m.k + m.oy, x1: b.x1 * m.k + m.ox, y1: b.y1 * m.k + m.oy };
}

const fullCache = new Map(); // id → dataUrl（最近看过的几张，免得来回切换时反复读库）
async function loadFull(id) {
  if (fullCache.has(id)) return fullCache.get(id);
  const rec = await getImage(id);
  if (!rec) return null;
  fullCache.set(id, rec.dataUrl);
  while (fullCache.size > 4) fullCache.delete(fullCache.keys().next().value);
  return rec.dataUrl;
}

/** 这张图有没有能看的内容 */
export function hasViewable(images) {
  return (images || []).some(im => im && (im.display || im.fullId));
}

/**
 * 把核对会话 / 图纸里的 images 变成看图器的条目。
 * focus = { img: 第几张, box, countBox }：在那张图上框出当前条目（清单图和整张图上都框）。
 */
export function entriesFromImages(images, focus = null) {
  return (images || []).map((im, k) => {
    const f = focus && focus.img === k ? focus : null;
    const views = [];
    if (im.display) views.push({ key: 'legend', label: '清单', src: im.display, w: im.dw, h: im.dh, box: f?.box || null, box2: f?.countBox || null });
    if (im.fullId) {
      views.push({
        key: 'full', label: '整张图', load: () => loadFull(im.fullId), w: im.fw, h: im.fh,
        box: f ? toFullBox(f.box, im) : null, box2: f ? toFullBox(f.countBox, im) : null,
      });
    }
    return { name: im.name || `第 ${k + 1} 张`, from: k, views };
  }).filter(e => e.views.length);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const union = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/**
 * 打开看图器。
 * entries: [{ name, views: [{ key, label, src | load(), w, h, box?, box2? }] }]
 * opts: { index: 第几条, view: 'legend' | 'full'（优先打开的视图）, focus: 有框时是否先放大到框 }
 */
export function openImageViewer(entries, { index = 0, view = 'full', focus = true } = {}) {
  entries = (entries || []).filter(e => e.views?.length);
  if (!entries.length) { toast('没有可以查看的图片'); return null; }
  let ei = clamp(index, 0, entries.length - 1);
  let vkey = view;
  let token = 0;

  const imgEl = h('img', { alt: '', draggable: false });
  const hl = h('div.pz-hl', { hidden: true });
  const hl2 = h('div.pz-hl.dash', { hidden: true });
  const layer = h('div.pz-layer', imgEl, hl, hl2);
  const msg = h('div.pz-msg', { hidden: true });
  const hint = h('div.pz-hint', '双指缩放 · 拖动 · 双击放大');
  const stage = h('div.pz-stage', layer, msg, hint);

  const title = h('div.pz-title');
  const prevBtn = h('button.pz-btn', { 'aria-label': '上一张', onclick: () => go(ei - 1) }, '‹');
  const nextBtn = h('button.pz-btn', { 'aria-label': '下一张', onclick: () => go(ei + 1) }, '›');
  const counter = h('span.pz-count');
  const nav = h('div.pz-nav', prevBtn, counter, nextBtn);
  const closeBtn = h('button.pz-btn.close', { 'aria-label': '关闭', onclick: () => close() }, '✕');
  const seg = h('div.pz-seg');
  const pct = h('span.pz-pct');
  const boxBtn = h('button.pz-btn', { 'aria-label': '回到框出的位置', onclick: () => focusBox() }, '⌖');
  const tools = h('div.pz-tools',
    h('button.pz-btn', { 'aria-label': '缩小', onclick: () => zoomCenter(1 / 1.6) }, '−'),
    h('button.pz-btn.wide', { onclick: () => fitAll() }, '适合'),
    h('button.pz-btn', { 'aria-label': '放大', onclick: () => zoomCenter(1.6) }, '＋'),
    boxBtn, pct);
  const root = h('div.pz', { role: 'dialog', 'aria-label': '查看图片' },
    h('div.pz-top', closeBtn, title, nav),
    stage,
    h('div.pz-bottom', seg, tools));

  // ---- 缩放状态：layer 以左上角为原点 translate + scale ----
  const st = { s: 1, tx: 0, ty: 0, w: 1, h: 1, fit: 1, min: 0.1, max: 4, ready: false };
  const size = () => ({ sw: stage.clientWidth || window.innerWidth, sh: stage.clientHeight || window.innerHeight });
  function apply() {
    layer.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.s})`;
    layer.style.setProperty('--bw', (3 / st.s) + 'px'); // 框线在屏幕上始终约 3 点粗
    pct.textContent = st.ready ? Math.round(st.s / st.fit * 100) + '%' : '';
  }
  function clampT() {
    const { sw, sh } = size();
    const iw = st.w * st.s, ih = st.h * st.s;
    st.tx = iw <= sw ? (sw - iw) / 2 : clamp(st.tx, sw - iw, 0);
    st.ty = ih <= sh ? (sh - ih) / 2 : clamp(st.ty, sh - ih, 0);
  }
  function zoomAt(ns, cx, cy) {
    ns = clamp(ns, st.min, st.max);
    const ix = (cx - st.tx) / st.s, iy = (cy - st.ty) / st.s;
    st.s = ns; st.tx = cx - ix * ns; st.ty = cy - iy * ns;
    clampT(); apply();
  }
  function zoomCenter(f) { const { sw, sh } = size(); zoomAt(st.s * f, sw / 2, sh / 2); }
  function setLimits() {
    const { sw, sh } = size();
    st.fit = Math.min(sw / st.w, sh / st.h);
    st.min = Math.min(st.fit, 1);
    // 最大：原图 1 像素放到 4 个屏幕点，或“适合”的 10 倍
    st.max = Math.max(st.fit * 10, 4);
  }
  function fitAll() { setLimits(); st.s = st.fit; clampT(); apply(); }
  function curView() { return entries[ei].views.find(v => v.key === vkey) || entries[ei].views[0]; }
  function focusBox() {
    const v = curView();
    const b = union(v.box, v.box2);
    if (!b) return fitAll();
    const { sw, sh } = size();
    const bw = Math.max(b.x1 - b.x0, 8), bh = Math.max(b.y1 - b.y0, 8);
    // 框占屏幕宽度一半左右，周围留些上下文；最多放大到“适合”的 6 倍
    const ns = clamp(Math.min(sw * 0.5 / bw, sh * 0.3 / bh, st.fit * 6), st.fit, st.max);
    st.s = ns;
    st.tx = sw / 2 - (b.x0 + b.x1) / 2 * ns;
    st.ty = sh / 2 - (b.y0 + b.y1) / 2 * ns;
    clampT(); apply();
  }
  const place = (el, b) => {
    el.hidden = !b;
    if (b) Object.assign(el.style, { left: b.x0 + 'px', top: b.y0 + 'px', width: (b.x1 - b.x0) + 'px', height: (b.y1 - b.y0) + 'px' });
  };

  // ---- 显示某一条的某个视图 ----
  async function show(doFocus) {
    const my = ++token;
    const e = entries[ei];
    const v = curView();
    vkey = v.key;
    title.textContent = e.name;
    counter.textContent = `${ei + 1} / ${entries.length}`;
    nav.hidden = entries.length < 2;
    prevBtn.disabled = ei === 0;
    nextBtn.disabled = ei === entries.length - 1;
    seg.replaceChildren(...(e.views.length > 1 ? e.views.map(x => h('button' + (x.key === v.key ? '.on' : ''), {
      onclick: () => { if (x.key !== vkey) { vkey = x.key; show(focus); } },
    }, x.label)) : []));
    seg.hidden = e.views.length < 2;
    boxBtn.hidden = !(v.box || v.box2);
    st.ready = false;
    layer.style.visibility = 'hidden';
    msg.hidden = false;
    msg.textContent = v.load ? '正在载入原图…' : '';
    let src = v.src;
    if (!src && v.load) {
      try { src = await v.load(); } catch { src = null; }
    }
    if (my !== token) return;
    if (!src) { msg.textContent = '原图已经不在了（可能被清理掉了）'; return; }
    imgEl.onload = () => {
      if (my !== token) return;
      st.w = v.w || imgEl.naturalWidth;
      st.h = v.h || imgEl.naturalHeight;
      imgEl.style.width = st.w + 'px';
      imgEl.style.height = st.h + 'px';
      place(hl, v.box); place(hl2, v.box2);
      setLimits();
      msg.hidden = true;
      layer.style.visibility = '';
      st.ready = true;
      if (doFocus && (v.box || v.box2)) focusBox(); else fitAll();
    };
    imgEl.onerror = () => { if (my === token) msg.textContent = '图片打不开'; };
    imgEl.src = src;
  }
  function go(k) {
    if (k < 0 || k >= entries.length || k === ei) return;
    ei = k;
    show(focus);
  }

  // ---- 手势：Pointer Events（iPhone Safari 13+ 支持） ----
  const pts = new Map();
  let g = null, moved = false, multi = false, lastTap = { t: 0, x: 0, y: 0 };
  const pos = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const mid = p => p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0];
  const dist = p => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  function begin() {
    const p = [...pts.values()];
    if (!p.length) { g = null; layer.style.willChange = ''; return; }
    layer.style.willChange = 'transform';
    const m = mid(p);
    g = { s0: st.s, d0: p.length > 1 ? dist(p) : 0, mx: m.x, my: m.y, tx0: st.tx, ty0: st.ty };
  }
  stage.addEventListener('pointerdown', e => {
    if (!st.ready) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    if (!pts.size) { moved = false; multi = false; }
    pts.set(e.pointerId, pos(e));
    if (pts.size > 1) multi = true;
    hint.classList.add('gone');
    begin();
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, pos(e));
    const p = [...pts.values()];
    const m = mid(p);
    let ns = g.s0;
    if (p.length > 1 && g.d0 > 0) ns = clamp(g.s0 * dist(p) / g.d0, st.min, st.max);
    const ix = (g.mx - g.tx0) / g.s0, iy = (g.my - g.ty0) / g.s0;
    st.s = ns; st.tx = m.x - ix * ns; st.ty = m.y - iy * ns;
    if (p.length > 1 || Math.hypot(m.x - g.mx, m.y - g.my) > 8) moved = true;
    clampT(); apply();
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    begin();
    if (pts.size || moved || multi) return;
    // 单击：检查是不是双击
    const now = Date.now();
    if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
      lastTap.t = 0;
      if (st.s > st.fit * 1.3) fitAll(); else zoomAt(st.fit * 3, p.x, p.y);
    } else lastTap = { t: now, x: p.x, y: p.y };
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const p = pos(e);
    zoomAt(st.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), p.x, p.y);
  }, { passive: false });
  // iPhone Safari 的系统级双指缩放
  const stopGesture = e => e.preventDefault();
  root.addEventListener('gesturestart', stopGesture);
  root.addEventListener('gesturechange', stopGesture);

  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(ei - 1);
    else if (e.key === 'ArrowRight') go(ei + 1);
    else if (e.key === '+' || e.key === '=') zoomCenter(1.6);
    else if (e.key === '-') zoomCenter(1 / 1.6);
  };
  const onResize = () => { if (!st.ready) return; const r = st.s / st.fit; setLimits(); st.s = clamp(st.fit * r, st.min, st.max); clampT(); apply(); };
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  setTimeout(() => hint.classList.add('gone'), 2600);

  const hadNoScroll = document.body.classList.contains('noscroll');
  document.body.classList.add('noscroll');
  document.body.append(root);
  function close() {
    token++;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    if (!hadNoScroll) document.body.classList.remove('noscroll');
    root.remove();
  }

  if (!entries[ei].views.some(v => v.key === vkey)) vkey = entries[ei].views[0].key;
  requestAnimationFrame(() => show(focus));
  return { close };
}
