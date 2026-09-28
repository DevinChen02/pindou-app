// 通用的双指缩放 / 单指拖动 / 双击放大（看图器和拼豆板共用）。
// stage：固定大小、overflow:hidden 的容器；layer：内容层（左上角为原点，用 transform 缩放平移）。

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * opts:
 *   onTap({ x, y })     单击（内容坐标）；会等 300ms 确认不是双击
 *   onChange(state)     每次缩放/平移后
 *   maxFit=10, maxAbs=4 最大放大：适合的 10 倍，或内容 1 像素放到 4 个屏幕点，取大的
 *   doubleTap=3         双击放大到“适合”的几倍
 */
export function createPanZoom(stage, layer, { onTap = null, onChange = null, maxFit = 10, maxAbs = 4, doubleTap = 3 } = {}) {
  const st = { s: 1, tx: 0, ty: 0, w: 1, h: 1, fit: 1, min: 0.1, max: 4, ready: false };
  const size = () => ({ sw: stage.clientWidth || window.innerWidth, sh: stage.clientHeight || window.innerHeight });
  function apply() {
    layer.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.s})`;
    onChange?.(st);
  }
  function clampT() {
    const { sw, sh } = size();
    const iw = st.w * st.s, ih = st.h * st.s;
    st.tx = iw <= sw ? (sw - iw) / 2 : clamp(st.tx, sw - iw, 0);
    st.ty = ih <= sh ? (sh - ih) / 2 : clamp(st.ty, sh - ih, 0);
  }
  function setLimits() {
    const { sw, sh } = size();
    st.fit = Math.min(sw / st.w, sh / st.h);
    st.min = Math.min(st.fit, 1);
    st.max = Math.max(st.fit * maxFit, maxAbs);
  }
  function zoomAt(ns, cx, cy) {
    ns = clamp(ns, st.min, st.max);
    const ix = (cx - st.tx) / st.s, iy = (cy - st.ty) / st.s;
    st.s = ns; st.tx = cx - ix * ns; st.ty = cy - iy * ns;
    clampT(); apply();
  }
  const api = {
    state: st,
    /** 换内容（尺寸以内容坐标计），默认缩放到“适合” */
    setContent(w, h, { keep = false } = {}) {
      const r = keep && st.ready ? st.s / st.fit : null;
      st.w = w; st.h = h; setLimits(); st.ready = true;
      if (r) { st.s = clamp(st.fit * r, st.min, st.max); clampT(); apply(); } else api.fit();
    },
    fit() { setLimits(); st.s = st.fit; clampT(); apply(); },
    zoomBy(f) { const { sw, sh } = size(); zoomAt(st.s * f, sw / 2, sh / 2); },
    zoomAt,
    /** 把内容里的一个矩形放到屏幕中间（最多放大到适合的 maxF 倍） */
    focusRect(b, { wFrac = 0.5, hFrac = 0.3, maxF = 6 } = {}) {
      const { sw, sh } = size();
      const bw = Math.max(b.x1 - b.x0, 8), bh = Math.max(b.y1 - b.y0, 8);
      const ns = clamp(Math.min(sw * wFrac / bw, sh * hFrac / bh, st.fit * maxF), st.fit, st.max);
      st.s = ns;
      st.tx = sw / 2 - (b.x0 + b.x1) / 2 * ns;
      st.ty = sh / 2 - (b.y0 + b.y1) / 2 * ns;
      clampT(); apply();
    },
    /** 屏幕坐标 → 内容坐标 */
    toContent(px, py) { return { x: (px - st.tx) / st.s, y: (py - st.ty) / st.s }; },
    resize() { if (!st.ready) return; const r = st.s / st.fit; setLimits(); st.s = clamp(st.fit * r, st.min, st.max); clampT(); apply(); },
    destroy() { clearTimeout(tapTimer); },
  };

  // ---- 手势：Pointer Events（iPhone Safari 13+ 支持） ----
  const pts = new Map();
  let g = null, moved = false, multi = false, lastTap = { t: 0, x: 0, y: 0 }, tapTimer = null;
  const pos = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const mid = p => (p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0]);
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
    // 叠在画面上的按钮（缩放、完成等）自己处理点击，不当成拖动/单击
    if (e.target?.closest?.('button, a, input, textarea, select')) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    if (!pts.size) { moved = false; multi = false; }
    pts.set(e.pointerId, pos(e));
    if (pts.size > 1) multi = true;
    stage.dispatchEvent(new CustomEvent('pz-touch'));
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
    const now = Date.now();
    if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
      lastTap.t = 0;
      clearTimeout(tapTimer);
      if (st.s > st.fit * 1.3) api.fit(); else zoomAt(st.fit * doubleTap, p.x, p.y);
    } else {
      lastTap = { t: now, x: p.x, y: p.y };
      if (onTap) {
        const c = api.toContent(p.x, p.y);
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => onTap(c), 300);
      }
    }
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
  stage.addEventListener('gesturestart', stopGesture);
  stage.addEventListener('gesturechange', stopGesture);
  return api;
}
