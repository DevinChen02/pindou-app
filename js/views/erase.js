// 圈掉水印：图纸上画了大水印、签名、涂鸦（比如一个大红圈、“禁商用”几个字），在原图上用手指把它圈起来，
// 圈里的格子整块清空（用背景色填上），锁定成“空”，整板重新计算。
// 再进来可以接着圈；圈错了用“恢复”再圈一下就回来了。两根手指移动、放大（和看图一样）。
import { h, toast, confirmDialog, fmtNum } from '../ui.js';
import * as store from '../store.js';
import { boardRecord, locksFor, unpackCells } from '../board.js';
import { runBoard } from '../boardasync.js';
import { ocrOpt } from '../ocrcells.js';
import { createPanZoom } from '../panzoom.js';
import { makeCanvas } from '../image.js';
import { loadPixels, merged, geomOf } from './build.js';
import { isGenerated } from './photo.js';

const MAXPX = 2048; // 编辑时显示的图最长边（iPhone 上画布太大会占很多内存）

/** 点在多边形里没有（奇偶规则） */
export function inPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 圈里的格子：格子中心在圈里的（P 是原图坐标；xs / ys 是格线） */
export function cellsInPoly(P, xs, ys) {
  const cols = xs.length - 1, rows = ys.length - 1;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const out = [];
  for (let r = 0; r < rows; r++) {
    const cy = (ys[r] + ys[r + 1]) / 2;
    if (cy < y0 || cy > y1) continue;
    for (let c = 0; c < cols; c++) {
      const cx = (xs[c] + xs[c + 1]) / 2;
      if (cx >= x0 && cx <= x1 && inPoly(cx, cy, P)) out.push(r * cols + c);
    }
  }
  return out;
}

/** 一个点落在哪一格（不在网格里返回 -1） */
function cellAt(x, y, xs, ys) {
  const find = (a, v) => { if (v < a[0] || v >= a[a.length - 1]) return -1; let i = 0; while (i < a.length - 2 && a[i + 1] <= v) i++; return i; };
  const c = find(xs, x), r = find(ys, y);
  return c < 0 || r < 0 ? -1 : r * (xs.length - 1) + c;
}

/** 底色：现在认成空的格子中间的颜色（中位数）；空格太少就用白色 */
export function backgroundOf(img, xs, ys, cells) {
  const cols = xs.length - 1, R = [], G = [], B = [];
  const empty = [];
  for (let i = 0; i < cells.length; i++) if (!cells[i]) empty.push(i);
  if (empty.length < 5) return [255, 255, 255];
  const step = Math.max(1, Math.floor(empty.length / 400));
  for (let j = 0; j < empty.length; j += step) {
    const i = empty[j], r = Math.floor(i / cols), c = i % cols;
    const w = xs[c + 1] - xs[c], hh = ys[r + 1] - ys[r];
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) {
      const x = Math.round(xs[c] + w * fx), y = Math.round(ys[r] + hh * fy);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const o = (y * img.width + x) * 4;
      R.push(img.data[o]); G.push(img.data[o + 1]); B.push(img.data[o + 2]);
    }
  }
  const med = a => { a.sort((x, y) => x - y); return a[a.length >> 1] ?? 255; };
  return [med(R), med(G), med(B)];
}

/**
 * 打开圈水印编辑器。board：要改的拼豆板（默认图纸上存的）；
 * onDone(rec)：给了就把新的拼豆板交给它（准备拼豆板时还没存），否则直接存进图纸。
 * pix：已经读好的原图（{ canvas, data }，准备拼豆板时有），不给就自己读。
 * 返回 Promise：编辑器关掉（完成或取消）时 resolve（完成时给新的拼豆板，取消给 null）
 */
export function eraseFlow(app, p, { board = p.board, onDone = null, pix: given = null } = {}) {
  return new Promise(resolve => {
    const im = (p.images || []).find(x => x.fullId === board.imageId);
    if (!im) { toast('原图已经不在了', 'error'); resolve(null); return; }
    const geo = geomOf(board);
    const { xs, ys } = geo;
    const cols = board.cols, rows = board.rows, N = rows * cols;
    const cells = unpackCells(board.cells);
    const init = new Set((board.erased || []).filter(i => i < N));
    const cleared = new Set(init);
    const strokes = []; // 每一笔：{ add: [格子], del: [格子] }（撤销用）
    let mode = 'erase'; // erase 圈掉 / restore 恢复 / move 只移动
    let pix = null, K = 1, ox = 0, oy = 0, bg = [255, 255, 255], path = null, busy = false;

    // ---- 界面（全屏，和看图器同一套样式） ----
    const canvas = h('canvas.er-canvas');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'er-svg');
    const pathEl = document.createElementNS(svgNS, 'path');
    pathEl.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(pathEl);
    const layer = h('div.pz-layer.er-layer', canvas, svg);
    const msg = h('div.pz-msg', '正在载入原图…');
    const hint = h('div.pz-hint.er-hint', '用一根手指把水印圈起来 · 两根手指移动、放大');
    const stage = h('div.pz-stage.er-stage', layer, msg, hint);
    const undoBtn = h('button.pz-btn.wide.er-undo', { disabled: true, onclick: () => undo() }, '↶ 撤销');
    const status = h('div.er-status');
    const seg = h('div.pz-seg.er-seg');
    const doneBtn = h('button.er-done', { onclick: () => finish() }, '完成');
    const root = h('div.pz.er', { role: 'dialog', 'aria-label': '圈掉水印' },
      h('div.pz-top', h('button.pz-btn.close', { 'aria-label': '取消', onclick: () => cancel() }, '✕'), h('div.pz-title', '圈掉水印'), undoBtn),
      stage,
      h('div.pz-bottom.er-bottom',
        status,
        h('div.er-row', seg,
          h('div.pz-tools',
            h('button.pz-btn', { 'aria-label': '缩小', onclick: () => pz.zoomBy(1 / 1.6) }, '−'),
            h('button.pz-btn', { 'aria-label': '放大', onclick: () => pz.zoomBy(1.6) }, '＋'))),
        doneBtn));

    const MODES = [['erase', '⭕ 圈掉'], ['restore', '↩ 恢复'], ['move', '✋ 移动']];
    const drawSeg = () => {
      seg.replaceChildren(...MODES.map(([k, label]) => h('button' + (k === mode ? '.on' : ''), { 'data-mode': k, onclick: () => { mode = k; drawSeg(); stage.classList.toggle('drawing', mode !== 'move'); } }, label)));
    };

    const pz = createPanZoom(stage, layer, {
      maxAbs: 8,
      draw: {
        active: () => !!pix && !busy && mode !== 'move',
        start: pt => { path = [[pt.x, pt.y]]; drawPath(); },
        move: pt => {
          if (!path) return;
          const [lx, ly] = path[path.length - 1];
          if (Math.hypot(pt.x - lx, pt.y - ly) * pz.state.s < 2) return; // 屏幕上动了 2 点以上才记
          path.push([pt.x, pt.y]); drawPath();
        },
        end: () => { const P = path; path = null; drawPath(); if (P) apply(P); },
        cancel: () => { path = null; drawPath(); },
      },
    });

    function drawPath() {
      if (!path || path.length < 2) { pathEl.setAttribute('d', ''); return; }
      pathEl.setAttribute('d', 'M' + path.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z');
      pathEl.setAttribute('class', mode === 'restore' ? 'restore' : '');
    }

    /** 一笔画完：圈里的格子圈掉 / 恢复；几乎没动（点了一下）就只改点到的那一格 */
    function apply(P) {
      let len = 0;
      for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      const toImg = ([x, y]) => [ox + x / K, oy + y / K];
      let hit;
      if (len * pz.state.s < 10 || P.length < 3) {
        const i = cellAt(...toImg(P[0]), xs, ys);
        hit = i >= 0 ? [i] : [];
      } else hit = cellsInPoly(P.map(toImg), xs, ys);
      const st = { add: [], del: [] };
      if (mode === 'erase') { for (const i of hit) if (!cleared.has(i)) { cleared.add(i); st.add.push(i); } }
      else for (const i of hit) if (cleared.has(i)) { cleared.delete(i); st.del.push(i); }
      if (!st.add.length && !st.del.length) {
        toast(mode === 'erase' ? (hit.length ? '圈里的格子已经圈掉了' : '圈里没有格子（要圈在网格里面）') : '圈里没有圈掉的格子');
        return;
      }
      strokes.push(st);
      render();
    }

    function undo() {
      const st = strokes.pop();
      if (!st) return;
      for (const i of st.add) cleared.delete(i);
      for (const i of st.del) cleared.add(i);
      render();
    }

    const changed = () => cleared.size !== init.size || [...cleared].some(i => !init.has(i));

    /** 画原图，圈掉的格子用底色填上（再描上淡淡的格线，看起来就是空格） */
    function render() {
      const g = canvas.getContext('2d');
      g.drawImage(pix.canvas, ox, oy, canvas.width / K, canvas.height / K, 0, 0, canvas.width, canvas.height);
      const line = `rgb(${bg.map(v => Math.round(v * 0.82)).join(',')})`;
      g.fillStyle = `rgb(${bg.join(',')})`;
      const rect = i => { const r = Math.floor(i / cols), c = i % cols; return [(xs[c] - ox) * K, (ys[r] - oy) * K, (xs[c + 1] - xs[c]) * K, (ys[r + 1] - ys[r]) * K]; };
      for (const i of cleared) { const [x, y, w, hh] = rect(i); g.fillRect(x - 0.5, y - 0.5, w + 1, hh + 1); }
      g.strokeStyle = line;
      g.lineWidth = Math.max(1, (xs[cols] - xs[0]) / cols * K * 0.06);
      g.beginPath();
      for (const i of cleared) { const [x, y, w, hh] = rect(i); g.rect(x, y, w, hh); }
      g.stroke();
      let beads = 0;
      for (const i of cleared) if (cells[i]) beads++;
      status.replaceChildren(
        cleared.size ? h('span', h('b', `已圈掉 ${fmtNum(cleared.size)} 格`), beads ? `（其中 ${fmtNum(beads)} 格原来认成了豆子）` : '（原来都是空格）') : h('span', '还没圈'),
        h('span.er-tip', mode === 'restore' ? ' · 圈一下，圈错的格子就回来了' : mode === 'move' ? ' · 一根手指拖动' : ' · 点一下只改一格'));
      undoBtn.disabled = !strokes.length;
      const add = [...cleared].filter(i => !init.has(i)).length, back = [...init].filter(i => !cleared.has(i)).length;
      doneBtn.textContent = add || back ? `完成（${[add ? `清空 ${fmtNum(add)} 格` : '', back ? `恢复 ${fmtNum(back)} 格` : ''].filter(Boolean).join(' · ')}）` : '完成';
    }

    const onKey = e => { if (e.key === 'Escape') cancel(); else if ((e.metaKey || e.ctrlKey) && e.key === 'z') undo(); };
    const onResize = () => pz.resize();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    const hadNoScroll = document.body.classList.contains('noscroll');
    document.body.classList.add('noscroll');
    document.body.append(root);
    drawSeg();
    stage.classList.add('drawing');
    setTimeout(() => hint.classList.add('gone'), 4000);
    stage.addEventListener('pz-touch', () => setTimeout(() => hint.classList.add('gone'), 600));

    function close(v) {
      pz.destroy();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (!hadNoScroll) document.body.classList.remove('noscroll');
      root.remove();
      resolve(v);
    }
    async function cancel() {
      if (busy) return;
      if (strokes.length && !(await confirmDialog('不保存圈掉的格子？', { ok: '不保存', danger: true, detail: '这次圈的都不要了，拼豆板保持原样。' }))) return;
      close(null);
    }

    /** 完成：圈掉的格子锁定成空，整板按它重新计算（其他锁定的格子照旧） */
    async function finish() {
      if (busy) return;
      if (!changed()) { close(null); return; }
      busy = true;
      doneBtn.disabled = true; undoBtn.disabled = true;
      msg.hidden = false; msg.textContent = '按圈掉的格子重新计算整板…';
      layer.style.opacity = '0.35';
      try {
        const refs = merged(p);
        const locks = new Map(locksFor(board, refs) || []);
        for (const i of init) if (!cleared.has(i) && locks.get(i) === 0) locks.delete(i); // 恢复的格子：不再锁成空
        for (const i of cleared) locks.set(i, 0);
        const res = await runBoard('classify', pix.data, { xs, ys, refs, opt: { locks: locks.size ? locks : null, dewatermark: !!board.dewatermark, ocr: ocrOpt(board, refs) } });
        res.rows = rows; res.cols = cols;
        const rec = {
          ...board,
          ...boardRecord({ ...res, geom: geo }, board.imageId, {
            auto: board.auto, manual: board.manual, reviewedAt: board.reviewedAt || null, edits: board.edits || 0, place: board.place || null,
            dewatermark: !!board.dewatermark, ocrRead: board.ocrRead || 0, ocr: board.ocr || null,
          }, locks.size ? locks : null),
          erased: [...cleared].sort((a, b) => a - b),
        };
        let diff = 0;
        for (let i = 0; i < N; i++) {
          const a = cells[i] ? board.codes[cells[i] - 1] : '', b = res.cells[i] ? res.codes[res.cells[i] - 1] : '';
          if (a !== b) diff++;
        }
        const back = [...init].filter(i => !cleared.has(i)).length, add = [...cleared].filter(i => !init.has(i)).length;
        const gone = [...cleared].filter(i => !init.has(i) && cells[i]).length; // 圈掉的格子里原来认成豆子的
        const other = diff - gone;
        toast([add ? `圈掉了 ${fmtNum(add)} 格${gone ? `（去掉了 ${fmtNum(gone)} 颗认错的豆子）` : ''}` : '', back ? `恢复了 ${fmtNum(back)} 格` : '',
          other > 0 ? `其余 ${fmtNum(other)} 格按清单重新认了颜色` : ''].filter(Boolean).join('，'), 'ok');
        close(rec);
        if (onDone) { onDone(rec); return; }
        await store.patchPattern(p.id, { board: rec });
        app.rerender();
      } catch (e) {
        busy = false; doneBtn.disabled = false; layer.style.opacity = ''; msg.hidden = true;
        toast(e.message || String(e), 'error');
        render();
      }
    }

    // ---- 载入原图，只显示网格附近（清单那些不用） ----
    (async () => {
      try {
        pix = given || await loadPixels(im); // 整张原图（编辑器关掉就放掉：iPhone 上很占内存）
      } catch (e) { msg.textContent = e.message || '原图打不开'; return; }
      if (!root.isConnected) return;
      const W = pix.canvas.width, H = pix.canvas.height;
      const pitch = (xs[cols] - xs[0]) / cols, m = pitch * 1.5;
      ox = Math.max(0, Math.floor(xs[0] - m)); oy = Math.max(0, Math.floor(ys[0] - m));
      const cw = Math.min(W, Math.ceil(xs[cols] + m)) - ox, ch = Math.min(H, Math.ceil(ys[rows] + m)) - oy;
      K = Math.min(1, MAXPX / Math.max(cw, ch));
      canvas.width = Math.max(1, Math.round(cw * K)); canvas.height = Math.max(1, Math.round(ch * K));
      canvas.style.width = canvas.width + 'px'; canvas.style.height = canvas.height + 'px';
      svg.setAttribute('width', canvas.width); svg.setAttribute('height', canvas.height);
      svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
      canvas.dataset.map = JSON.stringify({ ox, oy, k: K }); // 原图坐标 → 画布坐标（测试用）
      bg = backgroundOf(pix.data, xs, ys, cells);
      msg.hidden = true;
      render();
      pz.setContent(canvas.width, canvas.height);
      if (init.size) hint.textContent = `上次圈掉的 ${fmtNum(init.size)} 格也显示着 · 圈错了点“恢复”再圈`;
    })();
  });
}

/** 能不能圈水印：有原图、有网格的识别图纸（生成的图纸没有水印） */
export function canErase(p, board = p.board) {
  return !!(board?.imageId && board.cols && (p.images || []).some(x => x.fullId === board.imageId) && !isGenerated(p));
}
