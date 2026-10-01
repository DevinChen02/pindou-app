// 拼豆板怎么画、“拼的时候”那一屏（拼豆板 + 底部颜色条）：iPhone 的“开始拼豆”和 iPad 看板共用。
// 这里不碰数据库：状态（选了哪个颜色、拼好了哪些、缩放位置）由调用的一方保存，通过回调改。
import { h, chip, fmtNum, icon, optionSheet } from './ui.js';
import { createPanZoom } from './panzoom.js';
import { rgbOf, isCode, codeCompare } from './palette.js';

export const CELL = 20;          // 一格在拼豆板上的尺寸（内容坐标）
export const M = 24;             // 左、上留给坐标数字
const rgbFor = code => (isCode(code) ? rgbOf(code) : [180, 180, 180]);

// ---------- 拼的顺序、板上怎么显示（设置里记住） ----------
export const BUILD_ORDERS = [
  { value: 'count', short: '多→少', label: '颗数多的先拼（推荐）', desc: '先把大面积的颜色拼上，剩下的小颜色有了参照更好找位置' },
  { value: 'countAsc', short: '少→多', label: '颗数少的先拼', desc: '零散的小颜色先拼完' },
  { value: 'code', short: '色号', label: '按色号', desc: 'A1、A2…，和色卡顺序一样' },
  { value: 'list', short: '清单', label: '按图纸清单的顺序', desc: '和图纸上清单写的顺序一样' },
];
export const BUILD_SHOWS = [
  { value: 'real', short: '像实物', label: '像实物（推荐）', desc: '正在拼的颜色是深色，已经拼好的是浅色，还没拼的先不画——和手上的拼豆板一模一样，最好对照' },
  { value: 'fade', short: '三种深浅', label: '三种深浅', desc: '正在拼的最深，已经拼好的浅一些，还没拼的最淡（能看到整幅图，但很浅的颜色不太分得清）' },
];
export const orderOf = settings => (BUILD_ORDERS.some(o => o.value === settings.buildOrder) ? settings.buildOrder : 'count');
export const showOf = settings => (settings.buildShow === 'fade' ? 'fade' : 'real');
export const SPOT_OPTS = [
  { value: 'off', label: '不高亮', desc: '按上面选的显示方式画' },
  { value: 'on', label: '高亮当前颜色', desc: '板子变暗，正在拼的颜色亮起来、外面一圈白边；其他颜色变暗（已拼好的更暗）。也可以点拼豆板上的“✦ 高亮”随时开关' },
];
export const spotOf = settings => !!settings.buildSpot;
/** 颜色按选好的顺序排 */
export function orderItems(items, order) {
  const list = items.map((it, i) => ({ ...it, i }));
  if (order === 'count') list.sort((a, b) => b.count - a.count || codeCompare(a.code, b.code));
  else if (order === 'countAsc') list.sort((a, b) => a.count - b.count || codeCompare(a.code, b.code));
  else if (order === 'code') list.sort((a, b) => codeCompare(a.code, b.code));
  return list;
}

/**
 * 拼豆板怎么摆：拼豆板 W×H 格，图纸网格 (r,c) 放在拼豆板 (r+oy, c+ox)；mirror = 左右翻转着看；
 * native = “按图纸原来的格子”（辅助线和图纸上的线对齐，从边上开始）
 */
export function placeOf(board) {
  const P = board.place;
  if (P && P.W > 0 && P.H > 0) {
    const native = P.native ?? (P.W === board.cols && P.H === board.rows && !P.ox && !P.oy);
    return { W: P.W, H: P.H, ox: P.ox || 0, oy: P.oy || 0, mirror: !!P.mirror, native };
  }
  return { W: board.cols, H: board.rows, ox: 0, oy: 0, mirror: false, native: true };
}

/**
 * 拼豆板上每 5 颗一条的辅助线从第几条格线开始（0 = 贴边）：实物拼豆板两边留的一样多——
 * 52×52 两边各空 1 颗、78×78 各空 4 颗、104×104 各空 2 颗，中间每 5 颗一条（n − 2×留边 是 5 的倍数）。
 * “按图纸原来的格子”时从边上开始，和图纸上的线对齐。
 */
export function guideStart(n, native = false) {
  return native ? 0 : (3 * n) % 5; // 2×留边 ≡ n (mod 5) → 留边 ≡ 3n (mod 5)
}
/** 辅助线在拼豆板上的位置（格线序号 0..n，不含外框） */
export function guideLines(n, native = false) {
  const out = [];
  for (let c = guideStart(n, native); c <= n; c += 5) if (c > 0 && c < n) out.push(c);
  return out;
}
/**
 * 编号：中间的每一颗都编号（第一个完整 5×5 大格的第一颗记作 1），四周留空的那几排不编号。
 * 52×52 两边各留 1 颗 → 中间第 2–51 颗编 1–50；78×78 留 4 → 第 5–74 颗编 1–70；104×104 留 2 → 第 3–102 颗编 1–100。
 * 其他尺寸一样两边留得一样多；“按图纸原来的格子”不留边，1 到 n 全编（和图纸上的编号一样）。
 * i：从屏幕左边（行：上边）数的第几颗（从 0 起）；不编号返回 0。镜像时两边留得一样多，还是从屏幕左边数。
 */
export function cellNum(i, n, native = false) {
  const m = guideStart(n, native);
  return i >= m && i < n - m ? i - m + 1 : 0;
}

/** 拼豆板上 (px, py) 这一颗在哪：“第 13 行 · 第 27 列”（和边上的编号一样）；留空那一圈里：“上边留空的第 1 行” */
export function cellWhere(px, py, P) {
  const r = cellNum(py, P.H, P.native), c = cellNum(px, P.W, P.native);
  const row = r ? `第 ${r} 行` : py < P.H / 2 ? `上边留空的第 ${py + 1} 行` : `下边留空的倒数第 ${P.H - py} 行`;
  const col = c ? `第 ${c} 列` : px < P.W / 2 ? `左边留空的第 ${px + 1} 列` : `右边留空的倒数第 ${P.W - px} 列`;
  return `${row} · ${col}`;
}

export const boardSize = P => ({ W: M + P.W * CELL + 8, H: M + P.H * CELL + 8 });

/**
 * 画拼豆板：每格一颗豆子（有孔的圆），空格是小钉；每 5 格一条粗线，边上标坐标。
 * 选了一个颜色时豆子分三种：正在拼（深色）、已拼好（浅色）、还没拼——
 *   show='real'：还没拼的不画（和手上的拼豆板一样）；show='fade'：还没拼的画得最淡。
 * 没选颜色（看全部）时：已拼好的浅色，其余正常。
 * spot=true（高亮当前颜色）且选了颜色：板子变暗，正在拼的原色 + 白圈，其他颜色变暗（已拼好的比没拼的更暗）。
 */
export function drawBoard(g, q, board, { sel, done, place = null, show = 'real', spot = false }) {
  const P = place || placeOf(board);
  const { cells, codes } = board;
  const rows = P.H, cols = P.W;
  g.setTransform(q, 0, 0, q, 0, 0);
  const { W, H } = boardSize(P);
  g.fillStyle = '#f7f6f3'; g.fillRect(0, 0, W, H);
  const selIdx = sel ? codes.indexOf(sel) + 1 : 0;
  const dark = spot && selIdx > 0;
  g.fillStyle = dark ? '#2f2f33' : '#ffffff'; g.fillRect(M, M, cols * CELL, rows * CELL);
  // 细格线
  g.strokeStyle = dark ? '#3e3e43' : '#ebe9e4'; g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= cols; c++) { g.moveTo(M + c * CELL + 0.5, M); g.lineTo(M + c * CELL + 0.5, M + rows * CELL); }
  for (let r = 0; r <= rows; r++) { g.moveTo(M, M + r * CELL + 0.5); g.lineTo(M + cols * CELL, M + r * CELL + 0.5); }
  g.stroke();
  // 豆子
  const peg = dark ? '#55555b' : '#dedbd4';
  const colorOf = codes.map(c => rgbFor(c));
  const rad = CELL * 0.43, hole = CELL * 0.13;
  // 图纸网格以外的拼豆板位置：浅灰底（摆放时看得出图纸占哪一块）
  const gx0 = P.ox, gy0 = P.oy, gx1 = P.ox + board.cols, gy1 = P.oy + board.rows;
  if (gx0 > 0 || gy0 > 0 || gx1 < cols || gy1 < rows) {
    g.fillStyle = dark ? '#28282b' : '#f1efea';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (c >= gx0 && c < gx1 && r >= gy0 && r < gy1) continue;
      const x = P.mirror ? cols - 1 - c : c;
      g.fillRect(M + x * CELL, M + r * CELL, CELL, CELL);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const br = r - P.oy, bc = c - P.ox;
      const v = br >= 0 && bc >= 0 && br < board.rows && bc < board.cols ? cells[br * board.cols + bc] : 0;
      const x = P.mirror ? cols - 1 - c : c;
      const cx = M + x * CELL + CELL / 2, cy = M + r * CELL + CELL / 2;
      if (!v) {
        g.fillStyle = peg;
        g.beginPath(); g.arc(cx, cy, 1.4, 0, Math.PI * 2); g.fill();
        continue;
      }
      const code = codes[v - 1];
      // 这颗豆子现在是哪种：cur 正在拼 / done 已拼好 / todo 还没拼
      const stage = v === selIdx ? 'cur' : done.has(code) ? 'done' : selIdx ? 'todo' : 'cur';
      if (stage === 'todo' && show === 'real') {
        g.fillStyle = peg;
        g.beginPath(); g.arc(cx, cy, 1.4, 0, Math.PI * 2); g.fill();
        continue;
      }
      let [R, G, B] = colorOf[v - 1] || [180, 180, 180];
      if (dark) {
        // 高亮：正在拼的原色 + 白圈；其他颜色压暗（已拼好的 30%，没拼的 18%），在暗底上还认得出颜色
        if (stage !== 'cur') { const k = stage === 'done' ? 0.3 : 0.18; R = Math.round(R * k + 30); G = Math.round(G * k + 30); B = Math.round(B * k + 33); }
        g.fillStyle = `rgb(${R},${G},${B})`;
        g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
        if (stage === 'cur') {
          g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
          const lum = 0.299 * R + 0.587 * G + 0.114 * B;
          g.fillStyle = lum > 200 ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.55)';
          g.beginPath(); g.arc(cx, cy, hole, 0, Math.PI * 2); g.fill();
        }
        continue;
      }
      if (stage === 'done') {
        // 浅色：往白色掺 60%，描一圈淡边——白色、米色的豆子也看得出来
        R = Math.round(R + (255 - R) * 0.6); G = Math.round(G + (255 - G) * 0.6); B = Math.round(B + (255 - B) * 0.6);
      }
      g.globalAlpha = stage === 'todo' ? 0.1 : 1;
      g.fillStyle = `rgb(${R},${G},${B})`;
      g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
      g.lineWidth = 1; g.strokeStyle = stage === 'done' ? 'rgba(0,0,0,.2)' : 'rgba(0,0,0,.28)'; g.stroke();
      const lum = 0.299 * R + 0.587 * G + 0.114 * B;
      g.fillStyle = lum > 200 ? 'rgba(0,0,0,.14)' : 'rgba(255,255,255,.55)';
      g.beginPath(); g.arc(cx, cy, hole, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
  }
  // 外框 + 每 5 格的辅助线（位置按拼豆板尺寸，见 guideLines；镜像时跟着翻过来）
  g.strokeStyle = '#7d858f'; g.lineWidth = 1.6;
  g.beginPath();
  const vx = [0, cols, ...guideLines(cols, P.native).map(c => (P.mirror ? cols - c : c))];
  for (const c of vx) { g.moveTo(M + c * CELL, M); g.lineTo(M + c * CELL, M + rows * CELL); }
  for (const r of [0, rows, ...guideLines(rows, P.native)]) { g.moveTo(M, M + r * CELL); g.lineTo(M + cols * CELL, M + r * CELL); }
  g.stroke();
  // 编号：中间每一颗都编号（见 cellNum），四周留空的那几排不编号；逢 5 的数字深一点
  g.textBaseline = 'middle';
  const num = (n, x, y) => {
    g.font = `${n % 5 === 0 ? 700 : 500} ${n >= 100 ? 7.5 : 9}px -apple-system, "PingFang SC", sans-serif`;
    g.fillStyle = n % 5 === 0 ? '#4a4e55' : '#9a9ea5';
    g.fillText(String(n), x, y);
  };
  g.textAlign = 'center';
  for (let c = 0; c < cols; c++) { const n = cellNum(c, cols, P.native); if (n) num(n, M + (c + 0.5) * CELL, M / 2); }
  g.textAlign = 'right';
  for (let r = 0; r < rows; r++) { const n = cellNum(r, rows, P.native); if (n) num(n, M - 3, M + (r + 0.5) * CELL); }
}

// ---------- 固定在边上的行号、列号 ----------

/**
 * 放大后，画布上自带的行号（左边）、列号（上边）会移出屏幕：在舞台边上盖三条尺子，
 * 跟着缩放平移实时重画——左边行号、上边列号。
 * 画布自带的那排数字还在屏幕里时，对应的尺子不显示。
 */
export function makeRulers(stage, P) {
  const TH = 20, LW = 28;
  const top = h('canvas.bd-ruler.top'), left = h('canvas.bd-ruler.left');
  for (const c of [top, left]) c.style.display = 'none';
  let raf = 0, last = null;
  const font = w => `${w} 10px -apple-system, "PingFang SC", sans-serif`;
  const prep = (cv, w, hh) => {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    cv.style.width = w + 'px'; cv.style.height = hh + 'px'; cv.style.display = '';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    g.fillStyle = 'rgba(247,246,243,.95)'; g.fillRect(0, 0, w, hh);
    return g;
  };
  // 和画布上一样：中间的每一颗编号，四周留空的不编（见 cellNum）；格子在屏幕上多大决定隔几颗标一个数（数字至少要 ~16 像素宽）
  const stepFor = px => (px >= 16 ? 1 : px * 5 >= 18 ? 5 : 10);
  const shown = (n, step) => n && (step === 1 || n % step === 0 || (n === 1 && step === 5));
  // 每 5 颗的辅助线（和外框）在尺子上画一道短线，方便对位置
  const vlines = [0, P.W, ...guideLines(P.W, P.native).map(c => (P.mirror ? P.W - c : c))], hlines = [0, P.H, ...guideLines(P.H, P.native)];
  function draw(st) {
    const sw = stage.clientWidth, sh = stage.clientHeight, cs = CELL * st.s;
    // 画布自带的数字（上边中线 M/2、左边右对齐到 M-3）移出屏幕了才盖尺子，不挡住没放大时的豆子
    const showTop = st.ty + (M / 2) * st.s < 4;
    const showLeft = st.tx + (M - 10) * st.s < 2;
    const x0 = showLeft ? LW : 0, y0 = showTop ? TH : 0, x1 = sw, step = stepFor(cs);
    if (showTop) {
      const g = prep(top, sw, TH);
      g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, TH - 0.5); g.lineTo(sw, TH - 0.5);
      for (const c of vlines) { const x = Math.round(st.tx + (M + c * CELL) * st.s) + 0.5; if (x > x0 && x < sw) { g.moveTo(x, TH - 6); g.lineTo(x, TH); } }
      g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let c = 0; c < P.W; c++) {
        const n = cellNum(c, P.W, P.native);
        if (!shown(n, step)) continue;
        const x = st.tx + (M + (c + 0.5) * CELL) * st.s;
        if (x < x0 + 6 || x > x1 - 6) continue;
        g.font = font(n % 5 === 0 ? 700 : 500); g.fillStyle = n % 5 === 0 ? '#3a3d42' : '#80848a';
        g.fillText(String(n), x, TH / 2);
      }
    } else top.style.display = 'none';
    if (showLeft) {
      const g = prep(left, LW, sh);
      g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(LW - 0.5, 0); g.lineTo(LW - 0.5, sh);
      for (const r of hlines) { const y = Math.round(st.ty + (M + r * CELL) * st.s) + 0.5; if (y > y0 && y < sh) { g.moveTo(LW - 6, y); g.lineTo(LW, y); } }
      g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let r = 0; r < P.H; r++) {
        const n = cellNum(r, P.H, P.native);
        if (!shown(n, step)) continue;
        const y = st.ty + (M + (r + 0.5) * CELL) * st.s;
        if (y < y0 + 5 || y > sh - 5) continue;
        g.font = font(n % 5 === 0 ? 700 : 500); g.fillStyle = n % 5 === 0 ? '#3a3d42' : '#80848a';
        g.fillText(String(n), LW - 7, y);
      }
      if (showTop) { g.fillStyle = 'rgba(247,246,243,1)'; g.fillRect(0, 0, LW, TH); } // 左上角的空角
    } else left.style.display = 'none';
  }
  return {
    els: [top, left],
    update(st) { last = { s: st.s, tx: st.tx, ty: st.ty }; if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (stage.isConnected) draw(last); }); },
  };
}

/** “拼的顺序和显示”弹层；save(key, value) 存设置并重画 */
export function viewSheet(settings, save) {
  optionSheet('拼的顺序和显示', [
    { title: '先拼哪个颜色（底部颜色的排列、拼好后自动跳到的下一个）', value: orderOf(settings), options: BUILD_ORDERS, onPick: v => save('buildOrder', v) },
    { title: '选了一个颜色时，板上怎么显示', value: showOf(settings), options: BUILD_SHOWS, onPick: v => save('buildShow', v) },
    { title: '高亮当前颜色（其他颜色变暗）', value: spotOf(settings) ? 'on' : 'off', options: SPOT_OPTS, onPick: v => save('buildSpot', v === 'on') },
  ]);
}

// ---------- “拼的时候”那一屏 ----------

/**
 * 拼豆板舞台：画布 + 手指缩放拖动 + 固定的行号列号 + 缩放条（镜像、高亮、缩小、适合、放大）。
 *   board：{ rows, cols, codes, cells(Uint8Array) }；place：placeOf(board)（镜像按这里的 mirror）
 *   onTap(cell, showInfo)：点了拼豆板上一格；cell = { px, py, r, c, inGrid, code, where }
 *   view：{ get, set } 记住缩放位置（换颜色重画时不跳回去）；info：{ get, set } 提示条跟着重画带过去
 *   extra：盖在舞台上的其他元素（比如修正模式的提示条）
 * 返回 { stage, pz }（离开页面时调 pz.destroy()）
 */
export function boardStage({ board, place, sel, done, show, spot, onMirror, onSpot, onTap, view = null, info: infoState = null, extra = [], mark = null }) {
  const stage = h('div.bd-stage');
  const layer = h('div.bd-layer');
  const canvas = h('canvas');
  layer.append(canvas);
  const info = h('div.bd-info', { hidden: true });
  let pz = null;
  const zoomBar = h('div.bd-zoom',
    h('button.wide.bd-mirror' + (place.mirror ? '.on' : ''), { 'aria-label': '镜像', 'aria-pressed': String(!!place.mirror), onclick: onMirror }, '⇋', h('span.t', ' 镜像')),
    h('button.wide.bd-spot' + (spot ? '.on' : ''), { 'aria-label': '高亮当前颜色', 'aria-pressed': String(spot), onclick: onSpot }, '✦', h('span.t', ' 高亮')),
    h('button', { 'aria-label': '缩小', onclick: () => pz.zoomBy(1 / 1.6) }, '−'),
    h('button.wide', { onclick: () => pz.fit() }, '适合'),
    h('button', { 'aria-label': '放大', onclick: () => pz.zoomBy(1.6) }, '＋'));
  if (place.mirror) stage.append(h('div.bd-mirror-tag', '镜像中（左右翻转）'));
  // 放大后行号、列号固定在左边、上边
  const rulers = makeRulers(stage, place);
  stage.append(layer, ...rulers.els, info, zoomBar, ...extra);
  // 修正格子时点中的那一格：红框闪一闪（px, py 是拼豆板上的位置，镜像时已经翻过来了）
  // （红框的粗细按屏幕算，放大了也不会变成一大圈：缩放时更新 --k = 1/缩放倍数）
  const markEl = mark ? h('div.bd-mark', { style: { left: (M + mark.px * CELL) + 'px', top: (M + mark.py * CELL) + 'px', width: CELL + 'px', height: CELL + 'px' } }) : null;
  if (markEl) layer.append(markEl);
  const { W, H } = boardSize(place);
  const q = Math.max(1, Math.min(2.5, Math.sqrt(9e6 / (W * H))));
  canvas.width = Math.round(W * q); canvas.height = Math.round(H * q);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  drawBoard(canvas.getContext('2d'), q, board, { sel, done, place, show, spot });
  let infoTimer = null;
  // 点格子会切换选中颜色、整页重画：提示条跟着带过去，别一闪就没了
  const showInfo = (text, until) => {
    info.hidden = false; info.textContent = text;
    infoState?.set({ text, until });
    clearTimeout(infoTimer); infoTimer = setTimeout(() => { info.hidden = true; }, Math.max(0, until - Date.now()));
  };
  const last = infoState?.get();
  if (last && last.until > Date.now()) showInfo(last.text, last.until);
  pz = createPanZoom(stage, layer, {
    maxFit: 14,
    onChange: st => { rulers.update(st); markEl?.style.setProperty('--k', String(1 / st.s)); },
    onTap: ({ x, y }) => {
      // 点的是拼豆板上第几行第几列（镜像时左右反过来），再换回图纸网格里的那一格
      const px = Math.floor((x - M) / CELL), py = Math.floor((y - M) / CELL);
      if (px < 0 || py < 0 || px >= place.W || py >= place.H) return;
      const pc = place.mirror ? place.W - 1 - px : px;
      const c = pc - place.ox, r = py - place.oy;
      const inGrid = c >= 0 && r >= 0 && c < board.cols && r < board.rows;
      const v = inGrid ? board.cells[r * board.cols + c] : 0;
      const code = v ? board.codes[v - 1] : null;
      onTap({ px, py, r, c, inGrid, code, where: cellWhere(px, py, place) }, showInfo);
    },
  });
  requestAnimationFrame(() => {
    pz.setContent(W, H);
    // 换颜色、打勾后重画：保持原来的缩放位置
    const st = view?.get();
    if (st) { Object.assign(pz.state, st); pz.zoomAt(pz.state.s, 0, 0); }
    // 点中的格子被挤到屏幕外了（下面换成了改颜色的面板，舞台变矮）：挪到刚好看得见
    if (mark) {
      // 上边、左边让开固定的行列号，下边让开缩放按钮
      const { s, tx, ty } = pz.state, sw = stage.clientWidth, sh = stage.clientHeight;
      const x0 = tx + (M + mark.px * CELL) * s, y0 = ty + (M + mark.py * CELL) * s, x1 = x0 + CELL * s, y1 = y0 + CELL * s;
      const dx = x0 < 36 ? 36 - x0 : x1 > sw - 12 ? sw - 12 - x1 : 0;
      const dy = y0 < 30 ? 30 - y0 : y1 > sh - 64 ? sh - 64 - y1 : 0;
      if (dx || dy) { pz.state.tx += dx; pz.state.ty += dy; pz.zoomAt(pz.state.s, 0, 0); view?.set({ s: pz.state.s, tx: pz.state.tx, ty: pz.state.ty }); }
    }
  });
  // 记住缩放位置（换颜色重画时不跳回去）
  if (view) {
    const saveView = () => view.set({ s: pz.state.s, tx: pz.state.tx, ty: pz.state.ty });
    stage.addEventListener('pointerup', saveView);
    stage.addEventListener('wheel', saveView);
    zoomBar.addEventListener('click', saveView);
  }
  return { stage, pz };
}

/**
 * 底部颜色条：排序按钮、“全部”、每种颜色（颗数、拼好的打勾）。
 * onPick(code | null)；scroll：{ get, set } 记住横着滑到的位置
 */
export function colorStrip({ items, sel, done, settings, onSort, onPick, scroll = null }) {
  const colors = h('div.hscroll.bd-colors',
    h('button.bd-sortb', { 'aria-label': '拼的顺序和显示方式', onclick: onSort }, icon('sort'), h('span.lab', BUILD_ORDERS.find(o => o.value === orderOf(settings)).short)),
    h('button.bd-color.all' + (!sel ? '.on' : ''), { onclick: () => onPick(null) }, h('span.lab', '全部'), h('span.n', `${items.length} 色`)),
    items.map(it => h('button.bd-color' + (sel === it.code ? '.on' : '') + (done.has(it.code) ? '.done' : ''), {
      'data-code': it.code,
      onclick: () => onPick(sel === it.code ? null : it.code),
    }, chip(it.code, { size: 'sm' }), h('span.n', fmtNum(it.count)), done.has(it.code) ? h('span.ck', '✓') : null)));
  // 点颜色会整页重画：颜色条停在原来滑到的位置，不跳回最左边（放进页面后调 keepTrayScroll）
  if (scroll) {
    colors.addEventListener('scroll', () => scroll.set({ x: colors.scrollLeft, y: colors.scrollTop }), { passive: true });
    requestAnimationFrame(() => keepTrayScroll(colors, sel, scroll));
  }
  return colors;
}

/**
 * 颜色条放回上次的位置；选中的颜色（比如拼好后自动跳到的下一个）不在屏幕里时，才挪到刚好露出来。
 * 横着滑（手机、iPad 竖屏）或竖着滑（iPad 横屏的侧边栏）都行
 */
export function keepTrayScroll(colors, sel, scroll) {
  if (!colors.isConnected) return;
  const last = scroll.get() || {};
  const on = sel && colors.querySelector('.bd-color.on');
  const vertical = colors.scrollHeight > colors.clientHeight + 1 && colors.scrollWidth <= colors.clientWidth + 1;
  if (vertical) {
    let y = last.y || 0;
    if (on) {
      const base = colors.getBoundingClientRect().top;
      const t = on.getBoundingClientRect().top - base + colors.scrollTop, b = t + on.offsetHeight, hh = colors.clientHeight;
      if (t < y) y = Math.max(0, t - 8);
      else if (b > y + hh) y = b - hh + 8;
    }
    colors.scrollTop = y;
  } else {
    let x = last.x || 0;
    if (on) {
      const base = colors.getBoundingClientRect().left;
      const l = on.getBoundingClientRect().left - base + colors.scrollLeft, r = l + on.offsetWidth, w = colors.clientWidth;
      if (l < x) x = Math.max(0, l - 12);
      else if (r > x + w) x = r - w + 12;
    }
    colors.scrollLeft = x;
  }
  scroll.set({ x: colors.scrollLeft, y: colors.scrollTop });
}

/** 选中一个颜色时底部那一行：色号、颗数（和清单不一样时带上清单的数）、说明、“这个颜色拼好了” */
export function selBar({ it, boardCount, isDone, hasBoard, show, spot, onToggle, readOnly = false }) {
  return h('div.bd-selbar',
    chip(it.code, { size: 'md' }),
    h('div.grow',
      h('b', `${it.code} · ${fmtNum(it.count)} 颗`, it.listCount != null && it.listCount !== it.count ? h('span.tiny.muted', `（清单 ${fmtNum(it.listCount)}）`) : null),
      hasBoard ? h('div.tiny.muted', (boardCount === it.count ? '' : `板上 ${boardCount} · `) + (spot ? `亮的 = 正在拼，暗的 = 已拼好，${show === 'real' ? '没拼的先不画' : '最暗 = 还没拼'}` : show === 'real' ? '浅色 = 已拼好，没拼的先不画' : '浅色 = 已拼好，最淡 = 还没拼')) : null),
    readOnly ? (isDone ? h('span.small.muted', '✓ 已拼好') : null) : h('button.btn' + (isDone ? '.ghost' : '.ok'), { onclick: onToggle }, isDone ? '↺ 还没拼好' : '✓ 这个颜色拼好了'));
}

/** 拼豆板上每种颜色的格子数 */
export function cellCounts(board) {
  const m = new Map();
  for (const v of board.cells) if (v) m.set(board.codes[v - 1], (m.get(board.codes[v - 1]) || 0) + 1);
  return m;
}
