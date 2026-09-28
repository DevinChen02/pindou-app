// 可拖动的框选器（框清单、框拼豆板共用）：拖角调整大小，拖中间移动，在框外空白处重新画。
import { h } from './ui.js';
import { cropCanvas } from './image.js';

/** 可拖动的框选器。work.rect 为原图坐标；返回 { el, get() } */
export function cropper(work, { maxVh = 62 } = {}) {
  const c = work.content;
  const disp = cropCanvas(work.canvas, c, Math.min(1, 1000 / c.w));
  const img = h('img', { src: disp.toDataURL('image/jpeg', 0.85), alt: '' });
  const wrap = h('div.crop-wrap', img);
  wrap.style.aspectRatio = `${c.w} / ${c.h}`;
  wrap.style.width = `min(100%, calc(${maxVh}vh * ${(c.w / c.h).toFixed(4)}))`;
  // 用 0–1 的比例保存
  let f = { x: (work.rect.x - c.x) / c.w, y: (work.rect.y - c.y) / c.h, w: work.rect.w / c.w, h: work.rect.h / c.h };
  const box = h('div.crop-rect');
  const handles = ['nw', 'ne', 'sw', 'se'].map(k => h('div.hd', { 'data-k': k }));
  box.append(...handles);
  wrap.append(box);
  const place = () => {
    Object.assign(box.style, { left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%', height: f.h * 100 + '%' });
    const pos = { nw: [0, 0], ne: [100, 0], sw: [0, 100], se: [100, 100] };
    handles.forEach(hd => { const [x, y] = pos[hd.dataset.k]; hd.style.left = x + '%'; hd.style.top = y + '%'; });
  };
  place();
  let drag = null;
  const pt = e => {
    const b = wrap.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };
  wrap.addEventListener('pointerdown', e => {
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const p = pt(e);
    const b = wrap.getBoundingClientRect();
    const tol = 30 / b.width, tolY = 30 / b.height;
    const corners = { nw: [f.x, f.y], ne: [f.x + f.w, f.y], sw: [f.x, f.y + f.h], se: [f.x + f.w, f.y + f.h] };
    const hit = Object.entries(corners).find(([, [x, y]]) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tolY);
    if (hit) drag = { mode: hit[0], start: p, f0: { ...f } };
    else if (p.x > f.x && p.x < f.x + f.w && p.y > f.y && p.y < f.y + f.h) drag = { mode: 'move', start: p, f0: { ...f } };
    else { drag = { mode: 'draw', start: p, f0: { x: p.x, y: p.y, w: 0, h: 0 } }; }
  });
  wrap.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = pt(e), { f0, start } = drag;
    const dx = p.x - start.x, dy = p.y - start.y;
    const min = 0.03;
    if (drag.mode === 'move') {
      f = { ...f0, x: Math.min(1 - f0.w, Math.max(0, f0.x + dx)), y: Math.min(1 - f0.h, Math.max(0, f0.y + dy)) };
    } else if (drag.mode === 'draw') {
      f = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.max(min, Math.abs(p.x - start.x)), h: Math.max(min, Math.abs(p.y - start.y)) };
    } else {
      let x0 = f0.x, y0 = f0.y, x1 = f0.x + f0.w, y1 = f0.y + f0.h;
      if (drag.mode.includes('w')) x0 = Math.min(x1 - min, p.x);
      if (drag.mode.includes('e')) x1 = Math.max(x0 + min, p.x);
      if (drag.mode.includes('n')) y0 = Math.min(y1 - min, p.y);
      if (drag.mode.includes('s')) y1 = Math.max(y0 + min, p.y);
      f = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    place();
  });
  const end = () => { drag = null; };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  return {
    el: wrap,
    get: () => ({ x: c.x + f.x * c.w, y: c.y + f.y * c.h, w: f.w * c.w, h: f.h * c.h }),
  };
}

