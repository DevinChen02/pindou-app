// 把一张拼豆图纸画出来（浏览器里用 canvas）：
//   drawChart：和别的图纸截图一个样子——格子里写色号、每 5 格一条粗线、上边左边写编号，下面是色号清单（色块 + 颗数）；
//   drawBeads：像拼在板上的豆子（生成图纸时的预览、全屏看）；
//   pixelThumb：一格一个像素放大的小图（图纸库的缩略图）。
// pat = { cols, rows, codes, cells（Uint8Array，0 = 空，k = codes[k-1]）, counts }
import { makeCanvas } from './image.js';
import { hexOf, inkFor } from './palette.js';

const FONT = '-apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif';

/** 图纸图。返回 { canvas, grid: { x0, y0, s }, legend: { x, y, w, h } } */
export function drawChart(pat, { title = '' } = {}) {
  const { cols, rows, codes, cells } = pat;
  const counts = pat.counts || codes.map((_, k) => cells.reduce((a, v) => a + (v === k + 1), 0));
  const s = Math.max(12, Math.min(40, Math.round(Math.min(2800 / Math.max(cols, rows), Math.sqrt(7e6 / (cols * rows))))));
  const m = Math.round(s * 1.4); // 编号栏
  const pad = Math.max(16, Math.round(s * 0.6));
  const gw = cols * s, gh = rows * s;
  const W = Math.max(m + gw + pad * 2, 640);
  // 清单：每项 = 色块（里面写色号）+ 颗数
  const u = Math.max(22, Math.min(44, Math.round(W / 40)));
  const itemW = u * 5.2, perRow = Math.max(1, Math.floor((W - pad * 2) / itemW));
  const legRows = Math.ceil(codes.length / perRow);
  const legH = u * 1.8 + legRows * u * 1.7 + pad;
  const H = pad + m + gh + pad + legH;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const x0 = Math.round((W - gw - m) / 2) + m, y0 = pad + m;
  // 上边、左边写编号的灰条（和常见图纸一样）
  g.fillStyle = '#ececec';
  g.fillRect(x0, y0 - m, gw, m); g.fillRect(x0 - m, y0, m, gh);
  // 格子
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = cells[r * cols + c];
    if (!v) continue;
    g.fillStyle = hexOf(codes[v - 1]);
    g.fillRect(x0 + c * s, y0 + r * s, s, s);
  }
  // 色号（格子太小就不写）
  if (s >= 14) {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const v = cells[r * cols + c];
      if (!v) continue;
      const code = codes[v - 1];
      g.font = `600 ${Math.round(s * (code.length <= 2 ? 0.42 : 0.34))}px ${FONT}`;
      g.fillStyle = inkFor(hexOf(code));
      g.fillText(code, x0 + (c + 0.5) * s, y0 + (r + 0.5) * s + 0.5);
    }
  }
  // 格线：细线每格一条，粗线每 5 格一条
  g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = Math.max(1, s / 18);
  g.beginPath();
  for (let c = 0; c <= cols; c++) { g.moveTo(x0 + c * s, y0); g.lineTo(x0 + c * s, y0 + gh); }
  for (let r = 0; r <= rows; r++) { g.moveTo(x0, y0 + r * s); g.lineTo(x0 + gw, y0 + r * s); }
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = Math.max(2, s / 9);
  g.beginPath();
  for (let c = 0; c <= cols; c += 5) { g.moveTo(x0 + c * s, y0); g.lineTo(x0 + c * s, y0 + gh); }
  for (let r = 0; r <= rows; r += 5) { g.moveTo(x0, y0 + r * s); g.lineTo(x0 + gw, y0 + r * s); }
  g.moveTo(x0 + gw, y0); g.lineTo(x0 + gw, y0 + gh); g.moveTo(x0, y0 + gh); g.lineTo(x0 + gw, y0 + gh);
  g.stroke();
  // 编号：格子够大每格都写，小了每 5 格写一个
  const every = s >= 18 ? 1 : 5;
  g.fillStyle = '#333';
  g.font = `600 ${Math.round(Math.min(s * 0.46, m * 0.5))}px ${FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let c = 0; c < cols; c++) if ((c + 1) % every === 0 || c === 0) g.fillText(String(c + 1), x0 + (c + 0.5) * s, y0 - m / 2);
  g.textAlign = 'right';
  for (let r = 0; r < rows; r++) if ((r + 1) % every === 0 || r === 0) g.fillText(String(r + 1), x0 - m * 0.18, y0 + (r + 0.5) * s);
  // 清单
  const ly = y0 + gh + pad;
  const beads = counts.reduce((a, b) => a + b, 0);
  g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = '#222';
  g.font = `700 ${Math.round(u * 0.62)}px ${FONT}`;
  g.fillText(`${title ? title + '  ' : ''}${cols} × ${rows}  共 ${beads} 颗 · ${codes.length} 色`, pad, ly + u * 0.7);
  const lx0 = pad + Math.max(0, (W - pad * 2 - perRow * itemW) / 2);
  codes.forEach((code, k) => {
    const x = lx0 + (k % perRow) * itemW, y = ly + u * 1.8 + Math.floor(k / perRow) * u * 1.7;
    const sw = u * 2.3, sh = u * 1.25;
    g.fillStyle = hexOf(code); g.fillRect(x, y, sw, sh);
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, sw - 1, sh - 1);
    g.fillStyle = inkFor(hexOf(code)); g.textAlign = 'center';
    g.font = `700 ${Math.round(u * 0.6)}px ${FONT}`;
    g.fillText(code, x + sw / 2, y + sh / 2 + 1);
    g.fillStyle = '#222'; g.textAlign = 'left';
    g.font = `600 ${Math.round(u * 0.6)}px ${FONT}`;
    g.fillText(String(counts[k]), x + sw + u * 0.35, y + sh / 2 + 1);
  });
  return { canvas: cv, grid: { x0, y0, s }, legend: { x: 0, y: ly, w: W, h: H - ly } };
}

/** 像拼在板上的豆子：浅色底板上一颗颗圆豆子（格子小于 4 像素时画方块）。cell：一格多少像素 */
export function drawBeads(g, pat, cell, { ox = 0, oy = 0, board = '#efede8', peg = '#dcd9d2' } = {}) {
  const { cols, rows, codes, cells } = pat;
  g.fillStyle = board;
  g.fillRect(ox, oy, cols * cell, rows * cell);
  const round = cell >= 4;
  const fills = codes.map(hexOf);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = cells[r * cols + c];
    const x = ox + c * cell, y = oy + r * cell;
    if (!v) {
      if (cell >= 6) { g.fillStyle = peg; g.beginPath(); g.arc(x + cell / 2, y + cell / 2, cell * 0.12, 0, Math.PI * 2); g.fill(); }
      continue;
    }
    g.fillStyle = fills[v - 1];
    if (round) { g.beginPath(); g.arc(x + cell / 2, y + cell / 2, cell * 0.47, 0, Math.PI * 2); g.fill(); }
    else g.fillRect(x, y, cell + 0.25, cell + 0.25);
  }
  if (cell >= 10) {
    // 豆子中间的孔
    g.fillStyle = 'rgba(0,0,0,.13)';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!cells[r * cols + c]) continue;
      g.beginPath(); g.arc(ox + (c + 0.5) * cell, oy + (r + 0.5) * cell, cell * 0.14, 0, Math.PI * 2); g.fill();
    }
  }
}

/** 图纸库的缩略图：一格一个方块（空格白色） */
export function pixelThumb(pat, max = 320) {
  const { cols, rows, codes, cells } = pat;
  const k = Math.max(1, Math.floor(max / Math.max(cols, rows)));
  const cv = makeCanvas(cols * k, rows * k);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = cells[r * cols + c];
    if (!v) continue;
    g.fillStyle = hexOf(codes[v - 1]);
    g.fillRect(c * k, r * k, k, k);
  }
  if (cv.width <= max && cv.height <= max) return cv.toDataURL('image/png');
  const t = makeCanvas(cv.width * max / Math.max(cv.width, cv.height), cv.height * max / Math.max(cv.width, cv.height));
  t.getContext('2d').drawImage(cv, 0, 0, t.width, t.height);
  return t.toDataURL('image/png');
}
