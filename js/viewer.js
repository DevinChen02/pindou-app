// 全屏看图：双指缩放、单指拖动、双击放大；可在“清单 / 整张图”之间切换，多张图左右翻。
import { h, toast } from './ui.js';
import { getImage } from './store.js';
import { createPanZoom } from './panzoom.js';

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
 * entries: [{ name, views: [{ key, label, src | load(), w, h, box?, box2?, marks? }] }]
 *   marks: [{ x0, y0, x1, y1, label, tone: 'ok'|'warn'|'bad' }] 额外画出的一组框（识别总览用）
 * opts: { index: 第几条, view: 'legend' | 'full'（优先打开的视图）, focus: 有框时是否先放大到框,
 *         onTap({ x, y, entry, view, close }): 单击图片时回调（图片坐标）, hint: 底部提示文字 }
 */
export function openImageViewer(entries, { index = 0, view = 'full', focus = true, onTap = null, hint: hintText = '双指缩放 · 拖动 · 双击放大' } = {}) {
  entries = (entries || []).filter(e => e.views?.length);
  if (!entries.length) { toast('没有可以查看的图片'); return null; }
  let ei = clamp(index, 0, entries.length - 1);
  let vkey = view;
  let token = 0;

  const imgEl = h('img', { alt: '', draggable: false });
  const hl = h('div.pz-hl', { hidden: true });
  const hl2 = h('div.pz-hl.dash', { hidden: true });
  const marksEl = h('div.pz-marks');
  const layer = h('div.pz-layer', imgEl, marksEl, hl, hl2);
  const msg = h('div.pz-msg', { hidden: true });
  const hint = h('div.pz-hint', hintText);
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

  // ---- 缩放/拖动交给通用引擎 ----
  const pz = createPanZoom(stage, layer, {
    onChange: st => {
      layer.style.setProperty('--bw', (3 / st.s) + 'px'); // 框线在屏幕上始终约 3 点粗
      pct.textContent = st.ready ? Math.round(st.s / st.fit * 100) + '%' : '';
    },
    onTap: onTap ? c => onTap({ x: c.x, y: c.y, entry: entries[ei], view: curView(), close }) : null,
  });
  const fitAll = () => pz.fit();
  const zoomCenter = f => pz.zoomBy(f);
  function curView() { return entries[ei].views.find(v => v.key === vkey) || entries[ei].views[0]; }
  function focusBox() {
    const v = curView();
    const b = union(v.box, v.box2);
    if (!b) return fitAll();
    pz.focusRect(b);
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
    pz.state.ready = false;
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
      const w = v.w || imgEl.naturalWidth, hh = v.h || imgEl.naturalHeight;
      imgEl.style.width = w + 'px';
      imgEl.style.height = hh + 'px';
      place(hl, v.box); place(hl2, v.box2);
      marksEl.replaceChildren(...(v.marks || []).map(m => {
        const el = h('div.pz-mark.' + (m.tone || 'ok'), m.label ? h('span', m.label) : null);
        place(el, m);
        return el;
      }));
      msg.hidden = true;
      layer.style.visibility = '';
      pz.setContent(w, hh);
      if (doFocus && (v.box || v.box2)) focusBox();
    };
    imgEl.onerror = () => { if (my === token) msg.textContent = '图片打不开'; };
    imgEl.src = src;
  }
  function go(k) {
    if (k < 0 || k >= entries.length || k === ei) return;
    ei = k;
    show(focus);
  }

  stage.addEventListener('pz-touch', () => hint.classList.add('gone'));

  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(ei - 1);
    else if (e.key === 'ArrowRight') go(ei + 1);
    else if (e.key === '+' || e.key === '=') zoomCenter(1.6);
    else if (e.key === '-') zoomCenter(1 / 1.6);
  };
  const onResize = () => pz.resize();
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  setTimeout(() => hint.classList.add('gone'), 2600);

  const hadNoScroll = document.body.classList.contains('noscroll');
  document.body.classList.add('noscroll');
  document.body.append(root);
  function close() {
    token++;
    pz.destroy();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    if (!hadNoScroll) document.body.classList.remove('noscroll');
    root.remove();
  }

  if (!entries[ei].views.some(v => v.key === vkey)) vkey = entries[ei].views[0].key;
  requestAnimationFrame(() => show(focus));
  return { close };
}
