// 像素画的格子：在原图上画出像素格（一格 = 原来的一个像素 = 一颗豆子），放大看对不对；
// 不对的话调格子大小、一根手指拖格子，再点“自动对齐”（在附近找让格线正好压在像素边上的那一套）。
// 用上以后按原来的像素一格一颗，每格取中间的颜色换成最接近的色号。
import { h, clear, toast } from '../ui.js';
import { createPanZoom } from '../panzoom.js';
import { makeCanvas } from '../image.js';
import { runBoard } from '../boardasync.js';
import { snapToGrid, refineGrid, gridFit } from '../photo.js';
import { pixOf, useGrid } from './photo.js';

const MAXPX = 2048;

/** 对齐得分 → 文字 */
function fitText(S) {
  if (S == null) return '';
  const pc = Math.round(S * 100);
  return S >= 0.9 ? `对得很齐 ✓（${pc}%）` : S >= 0.75 ? `差不多（${pc}%）：放大看看，再点“自动对齐”` : `没对齐（${pc}%）：调格子大小、拖格子，再点“自动对齐”`;
}

export function gridPage(app, st) {
  app.setTitle('像素格子');
  const view = clear(app.view);
  const img = pixOf(st);
  const rect = st.rect;
  const back = () => { st.gridEdit = null; st.sub = 'gen'; app.render(); };
  app.setBack(back);
  // 正在调的格子（点“用这套格子”才用上）
  if (!st.gridEdit) {
    const g = st.grid || { px: Math.max(4, rect.w / 40), py: Math.max(4, rect.w / 40), ox: rect.x, oy: rect.y };
    st.gridEdit = { px: g.px, py: g.py, ox: g.ox, oy: g.oy, S: st.grid ? gridFit(img, g, rect) : null, guessed: !st.grid };
  }
  const ge = st.gridEdit;
  let mode = 'look';

  // ---- 原图（框选的那一块，四周多留一点） ----
  const pitch = Math.max(ge.px, ge.py);
  const X0 = Math.max(0, Math.floor(rect.x - pitch * 2)), Y0 = Math.max(0, Math.floor(rect.y - pitch * 2));
  const X1 = Math.min(img.width, Math.ceil(rect.x + rect.w + pitch * 2)), Y1 = Math.min(img.height, Math.ceil(rect.y + rect.h + pitch * 2));
  const K = Math.min(1, MAXPX / Math.max(X1 - X0, Y1 - Y0));
  const base = makeCanvas(Math.max(1, Math.round((X1 - X0) * K)), Math.max(1, Math.round((Y1 - Y0) * K)));
  base.className = 'pxg-img';
  const bg = base.getContext('2d');
  bg.imageSmoothingEnabled = K < 1;
  bg.drawImage(st.canvas, X0, Y0, X1 - X0, Y1 - Y0, 0, 0, base.width, base.height);
  base.style.width = base.width + 'px'; base.style.height = base.height + 'px';
  const layer = h('div.pz-layer.pxg-layer', base);
  const over = h('canvas.pxg-over');
  const stage = h('div.pxg-stage', layer, over);

  const info = h('div.pxg-info');
  const fit = h('div.pxg-fit');
  const seg = h('div.seg.pxg-mode');
  const drawSeg = () => seg.replaceChildren(...[['look', '🔍 放大看'], ['move', '✋ 拖格子']].map(([k, label]) =>
    h('button' + (k === mode ? '.on' : ''), { 'data-mode': k, onclick: () => { mode = k; drawSeg(); stage.classList.toggle('moving', mode === 'move'); } }, label)));
  drawSeg();

  // 原图坐标 → 屏幕（舞台里）坐标
  const toScr = (x, y) => ({ x: pz.state.tx + (x - X0) * K * pz.state.s, y: pz.state.ty + (y - Y0) * K * pz.state.s });

  /** 在舞台上画格线（按屏幕像素画，放大缩小都是细细的一条；格子太小时只画每 5 / 10 条） */
  function drawOver() {
    const W = stage.clientWidth, H = stage.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!W || !H || !pz.state.ready) return;
    if (over.width !== Math.round(W * dpr) || over.height !== Math.round(H * dpr)) { over.width = Math.round(W * dpr); over.height = Math.round(H * dpr); }
    const g = over.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const cell = ge.px * K * pz.state.s;
    const every = cell >= 6 ? 1 : cell >= 2 ? 5 : 10;
    // 只画框里的格线
    const s = snapToGrid(ge, rect);
    const lines = (n, at, horiz) => {
      for (let k = 0; k <= n; k++) {
        const thick = k % 10 === 0 || k === n, five = k % 5 === 0;
        if (k % every && k !== n) continue;
        g.beginPath();
        g.strokeStyle = thick ? 'rgba(0,220,255,1)' : five ? 'rgba(0,220,255,.9)' : 'rgba(0,220,255,.7)';
        g.lineWidth = thick ? 2 : 1;
        if (horiz) { const a = toScr(s.x, at(k)), b = toScr(s.x + s.w, at(k)); g.moveTo(a.x, Math.round(a.y) + 0.5); g.lineTo(b.x, Math.round(b.y) + 0.5); }
        else { const a = toScr(at(k), s.y), b = toScr(at(k), s.y + s.h); g.moveTo(Math.round(a.x) + 0.5, a.y); g.lineTo(Math.round(b.x) + 0.5, b.y); }
        g.stroke();
      }
    };
    lines(s.cols, k => s.x + k * ge.px, false);
    lines(s.rows, k => s.y + k * ge.py, true);
    info.replaceChildren(h('b', `框里 ${s.cols} × ${s.rows} 格`), h('span.small.muted', ` · 每格 ${ge.px.toFixed(2)} 像素`));
    fit.textContent = fitText(ge.S);
    fit.className = 'pxg-fit small ' + (ge.S == null ? 'muted' : ge.S >= 0.9 ? 'pxg-good' : ge.S >= 0.75 ? 'warn-t' : 'bad-t');
    useBtn.disabled = !(s.cols >= 2 && s.rows >= 2 && Math.max(s.cols, s.rows) <= 200);
    useBtn.textContent = Math.max(s.cols, s.rows) > 200 ? '格子太多了（一边最多 200 格）' : `用这套格子（${s.cols} × ${s.rows}）`;
  }
  let fitTimer = null;
  const refit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { ge.S = gridFit(img, ge, rect); drawOver(); }, 150); };

  const useBtn = h('button.btn.primary.block.big.pxg-use', {
    onclick: () => {
      useGrid(st, { px: ge.px, py: ge.py, ox: ge.ox, oy: ge.oy, user: true });
      st.gridEdit = null; st.sub = 'gen';
      app.render();
    },
  }, '用这套格子');

  let drag = null;
  const pz = createPanZoom(stage, layer, {
    maxAbs: 10,
    onChange: () => drawOver(),
    draw: {
      active: () => mode === 'move',
      start: pt => { drag = { x: pt.x, y: pt.y, ox: ge.ox, oy: ge.oy }; },
      move: pt => { if (!drag) return; ge.ox = drag.ox + (pt.x - drag.x) / K; ge.oy = drag.oy + (pt.y - drag.y) / K; ge.S = null; drawOver(); },
      end: () => { drag = null; refit(); },
      cancel: () => { if (drag) { ge.ox = drag.ox; ge.oy = drag.oy; drag = null; drawOver(); } },
    },
  });

  /** 格子大小改一点：屏幕中间那条格线不动 */
  const scaleBy = f => {
    const c = { x: X0 + (stage.clientWidth / 2 - pz.state.tx) / (K * pz.state.s), y: Y0 + (stage.clientHeight / 2 - pz.state.ty) / (K * pz.state.s) };
    const kx = Math.round((c.x - ge.ox) / ge.px), ky = Math.round((c.y - ge.oy) / ge.py);
    const ax = ge.ox + kx * ge.px, ay = ge.oy + ky * ge.py;
    ge.px *= f; ge.py *= f;
    ge.ox = ax - kx * ge.px; ge.oy = ay - ky * ge.py;
    ge.S = null; drawOver(); refit();
  };
  const align = async btn => {
    btn.disabled = true;
    const r = refineGrid(img, ge, rect);
    btn.disabled = false;
    if (r.S < 0.5) { toast('附近没找到对得上的格子：先把格子大小调得差不多（每一格框住一个像素），再点一次', 'error'); return; }
    Object.assign(ge, { px: r.px, py: r.py, ox: r.ox, oy: r.oy, S: r.S, guessed: false });
    drawOver();
    toast(r.S >= 0.9 ? '对齐了 ✓' : '对齐了一些：放大看看还有没有错开的地方', r.S >= 0.9 ? 'ok' : '');
  };
  const redetect = async btn => {
    btn.disabled = true; const t = btn.textContent; btn.textContent = '正在找…';
    let g = null;
    try { g = await runBoard('photoGrid', img, { rect }); } catch (e) { console.warn(e); }
    btn.disabled = false; btn.textContent = t;
    if (!g) { toast('没自动找到像素格：手动调格子大小、拖格子，再点“自动对齐”', 'error'); return; }
    Object.assign(ge, { px: g.px, py: g.py, ox: g.ox, oy: g.oy, S: gridFit(img, g, rect), guessed: false });
    drawOver();
    toast('找到了', 'ok');
  };


  view.append(
    h('p.small.muted.pxg-hint', ge.guessed
      ? '没自动找到像素格：先调“格子大小”，让一格差不多框住一个像素，再点“🎯 自动对齐”。'
      : '蓝线是找到的像素格，一格一颗豆子。放大看看是不是每格正好框住一个像素；不对就调格子大小、拖格子，再点“🎯 自动对齐”。'),
    stage,
    h('div.row.between.pxg-sum', info, fit),
    h('div.row.between.wrap.gap-s.pxg-tools', seg,
      h('div.row.gap-s',
        h('button.btn.sm.soft', { 'aria-label': '缩小', onclick: () => pz.zoomBy(1 / 1.6) }, '−'),
        h('button.btn.sm.soft', { onclick: () => pz.fit() }, '适合'),
        h('button.btn.sm.soft', { 'aria-label': '放大', onclick: () => pz.zoomBy(1.6) }, '＋'))),
    h('div.card.pxg-size',
      h('div.row.between',
        h('div', h('b', '格子大小')),
        h('div.row.gap-s',
          h('button.btn.sm.soft.pxg-smaller', { 'aria-label': '格子小一点', onclick: () => scaleBy(1 / 1.02) }, '小 −'),
          h('button.btn.sm.soft.pxg-smaller-f', { 'aria-label': '格子小一点点', onclick: () => scaleBy(1 / 1.002) }, '−'),
          h('button.btn.sm.soft.pxg-bigger-f', { 'aria-label': '格子大一点点', onclick: () => scaleBy(1.002) }, '+'),
          h('button.btn.sm.soft.pxg-bigger', { 'aria-label': '格子大一点', onclick: () => scaleBy(1.02) }, '+ 大'))),
      h('div.row.gap-s.wrap', { style: { marginTop: '10px' } },
        h('button.btn.soft.pxg-align', { onclick: e => align(e.currentTarget) }, '🎯 自动对齐'),
        h('button.btn.ghost.pxg-redetect', { onclick: e => redetect(e.currentTarget) }, '重新自动找'))),
    h('div.row.between.pxg-more',
      h('button.link.small', { onclick: () => { st.gridEdit = null; st.sub = 'crop'; app.render(); } }, '✂️ 换个范围（框选）'),
      st.grid ? h('button.link.small.pxg-off', {
        onclick: () => { st.grid = null; st.gridEdit = null; st.result = null; st.prep = null; if (st.opts.size === 'native') Object.assign(st.opts, { size: 50, maxColors: 16 }); st.sub = 'gen'; app.render(); },
      }, '不是像素画（按普通图片缩小）') : null),
    h('div.sticky-actions', useBtn));

  requestAnimationFrame(() => {
    pz.setContent(base.width, base.height);
    drawOver();
  });
  const onResize = () => { pz.resize(); drawOver(); };
  window.addEventListener('resize', onResize);
  app.onLeave = () => { pz.destroy(); window.removeEventListener('resize', onResize); };
}
