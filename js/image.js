// 图片工具：读取、裁黑边、裁剪、缩放、取色。
import { estimateCharHeight, components, textMask } from './extract/ocr-core.js';

const MAX_PIXELS = 12_000_000; // iPhone 上单个 canvas 太大会失败

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    let w = img.naturalWidth, h = img.naturalHeight;
    const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
    const c = makeCanvas(w * k, h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function getImageData(canvas, r = { x: 0, y: 0, w: canvas.width, h: canvas.height }) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h)));
}

/** 去掉截图上下（和左右）接近纯黑的边：返回内容区域 {x,y,w,h} */
export function contentBounds(canvas) {
  const { width: w, height: h } = canvas;
  const data = getImageData(canvas).data;
  const darkRow = y => {
    let dark = 0, n = 0;
    for (let x = 0; x < w; x += 3, n++) {
      const p = (y * w + x) * 4;
      if (data[p] < 40 && data[p + 1] < 40 && data[p + 2] < 40) dark++;
    }
    return dark / n > 0.95;
  };
  const darkCol = (x, y0, y1) => {
    let dark = 0, n = 0;
    for (let y = y0; y < y1; y += 3, n++) {
      const p = (y * w + x) * 4;
      if (data[p] < 40 && data[p + 1] < 40 && data[p + 2] < 40) dark++;
    }
    return dark / n > 0.95;
  };
  let top = 0, bottom = h - 1;
  while (top < h - 1 && darkRow(top)) top++;
  while (bottom > top && darkRow(bottom)) bottom--;
  let left = 0, right = w - 1;
  while (left < w - 1 && darkCol(left, top, bottom + 1)) left++;
  while (right > left && darkCol(right, top, bottom + 1)) right--;
  // 整张图几乎都是黑的（比如深色背景的图纸）就不裁
  if ((bottom - top) < h * 0.15 || (right - left) < w * 0.15) return { x: 0, y: 0, w, h };
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/**
 * 猜色号清单的位置：图纸格子由横贯全图的格线组成，清单一般在最后一条长横线下面。
 * “横线”也包括图纸下边写行列号的那一条灰底横条（≤ 22 像素高），清单常常就在它下面。
 * 找不到时返回内容区下方 30%。imgData 为 content 区域的 ImageData。
 */
export function guessLegendRectFromData(img, content) {
  const { data, width: w, height: h } = img;
  const lum = (x, y) => { const p = (y * w + x) * 4; return 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]; };
  const step = Math.max(1, Math.floor(w / 400));
  let lastLine = -1, lastBand = -1;
  const n = Math.floor(w / step);
  // 每一列（采样点）上一次“变暗”“变亮”的边在哪一行：横条的上边和下边
  const lastDown = new Int32Array(n + 1).fill(-99), lastUp = new Int32Array(n + 1).fill(-99);
  for (let y = 2; y < h - 2; y++) {
    // 最长的连续“横线”段（允许 2 个采样点的小断口）；清单里一个个小方框的边不够长
    let run = 0, best = 0, gap = 0, brun = 0, bbest = 0, bgap = 0;
    for (let x = 0, k = 0; x < w; x += step, k++) {
      const a = lum(x, y), up = lum(x, y - 2), dn = lum(x, y + 2);
      if ((a - up > 18 && a - dn > 18) || (up - a > 18 && dn - a > 18)) { run += 1 + gap; gap = 0; if (run > best) best = run; }
      else if (run && gap < 2) gap++;
      else { run = 0; gap = 0; }
      // 横条的下边：这里变亮（或变暗），3–22 行以前有反方向的边
      const d = dn - a;
      const band = (d > 18 && y - lastDown[k] >= 3 && y - lastDown[k] <= 22) || (d < -18 && y - lastUp[k] >= 3 && y - lastUp[k] <= 22);
      if (band) { brun += 1 + bgap; bgap = 0; if (brun > bbest) bbest = brun; }
      else if (brun && bgap < 2) bgap++;
      else { brun = 0; bgap = 0; }
      if (d < -18) lastDown[k] = y;
      if (d > 18) lastUp[k] = y;
    }
    if (best / n > 0.6) lastLine = y;
    if (bbest / n > 0.6) lastBand = y + 1;
  }
  const fallback = { x: content.x, y: content.y + content.h * 0.7, w: content.w, h: content.h * 0.3 };
  let last = Math.max(lastLine, lastBand);
  if (last < 0) return fallback;
  // 格线是虚线、点线（浅灰）时，最后几行空格的格线连不成“长横线”：顺着格子的间距往下找，
  // 同样间距、横竖都有格线的还算网格（编号栏也一起跳过）
  last = followGrid(lum, w, h, step, last);
  const top = last + 3;
  const rest = h - top;
  // 横条下面只剩窄窄一条（清单只有一行、贴着图底）：里面有彩色的色块就用它
  let minRest = h * 0.03;
  if (last === lastBand && rest < minRest) {
    let colored = 0, total = 0;
    for (let y = top; y < h; y += 2) for (let x = 0; x < w; x += step) {
      const p = (y * w + x) * 4;
      total++;
      if (Math.max(data[p], data[p + 1], data[p + 2]) - Math.min(data[p], data[p + 1], data[p + 2]) > 60) colored++;
    }
    if (total && colored >= total * 0.02) minRest = Math.max(14, h * 0.008);
  }
  if (rest < minRest || rest > h * 0.6) return fallback;
  return { x: content.x, y: content.y + top, w: content.w, h: rest };
}

/**
 * 从 last（已经找到的最后一条格线）往下，按格子的间距一条一条找浅的格线：
 * 那一行大半都是细线（比上下暗或亮 10 以上）、而且这一格里竖着的格线也大致按同样的间距排着（清单的色块没有这么密的竖线），
 * 就算还是网格。间距从 last 上面的格线量。返回新的最后一条线。
 */
function followGrid(lum, w, h, step, last) {
  const n = Math.floor(w / step);
  const rowHit = y => {
    if (y < 2 || y >= h - 2) return 0;
    let k = 0;
    for (let x = 0; x < w; x += step) { const a = lum(x, y), u = lum(x, y - 2), d = lum(x, y + 2); if ((a - u > 10 && a - d > 10) || (u - a > 10 && d - a > 10)) k++; }
    return k / n;
  };
  // 间距：last 上下 600 像素里，横线（一行将近一半以上是细线）之间最常见的距离
  const lines = [];
  for (let y = Math.max(2, last - 600); y <= Math.min(h - 3, last + 600); y++) if (rowHit(y) >= 0.4 && (!lines.length || y - lines[lines.length - 1] > 2)) lines.push(y);
  const gaps = lines.slice(1).map((y, i) => y - lines[i]).filter(g => g >= 6 && g <= 80).sort((a, b) => a - b);
  if (gaps.length < 4) return last;
  const p = gaps[gaps.length >> 1];
  if (gaps.filter(g => Math.abs(g - p) <= 2).length < gaps.length * 0.6) return last;
  // 这一行格子里的竖线在哪些位置：每一列（像素）在这几行里大半是细竖线的，算一条
  const vertical = (y0, y1) => {
    const xs = [];
    let prev = -9;
    for (let x = 2; x < w - 2; x++) {
      let hit = 0, tot = 0;
      for (let y = y0 + 2; y < y1 - 1; y++) { tot++; const a = lum(x, y), l = lum(x - 2, y), r = lum(x + 2, y); if ((a - l > 10 && a - r > 10) || (l - a > 10 && r - a > 10)) hit++; }
      if (tot && hit >= tot * 0.35 && x - prev > 2) { xs.push(x); prev = x; }
    }
    return xs;
  };
  // 网格的竖线位置：last 上面或下面那一排格子里量（last 可能是网格最上面那条边）。
  // 网格的竖线一条挨一条、间距正好是 p；清单的字、色块边上的竖线间距没这么整齐，也对不上这些位置
  const combScore = xs => xs.slice(1).filter((x, i) => Math.abs(x - xs[i] - p) <= 2).length;
  const above = vertical(Math.max(0, Math.round(last - p)), last), below = vertical(last, Math.min(h - 1, Math.round(last + p)));
  const ref = combScore(above) >= combScore(below) ? above : below;
  if (combScore(ref) < (w / p) * 0.4) return last;
  const match = xs => { let k = 0, j = 0; for (const x of ref) { while (j < xs.length && xs[j] < x - 2) j++; if (j < xs.length && Math.abs(xs[j] - x) <= 2) k++; } return k / ref.length; };
  let y = last, misses = 0, end = last;
  for (let guard = 0; guard < 200; guard++) {
    let best = -1, bv = 0;
    for (let q = Math.round(y + p - 2); q <= Math.round(y + p + 2); q++) { const v = rowHit(q); if (v > bv) { bv = v; best = q; } }
    // 横线很清楚、竖线将近一半还在原来的位置上；或者横线淡（空格那几行、被贴纸挡住一段）但竖线大多都在：都还是网格
    const m = best > 0 && bv >= 0.2 ? match(vertical(end, best)) : 0;
    if ((bv >= 0.45 && m >= 0.45) || m >= 0.6) { y = end = best; misses = 0; continue; }
    // 中间偶尔几条被水印、贴纸、一片深色豆子挡住：再往下几格看看（最多连着 3 条）
    if (misses++ >= 3) break;
    y += p;
  }
  return end;
}

export function guessLegendRect(canvas, content) {
  return guessLegendRectFromData(getImageData(canvas, content), content);
}

export function cropCanvas(canvas, r, scale = 1) {
  const c = makeCanvas(r.w * scale, r.h * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}

/** 缩到长边不超过 maxSide（不放大，除非 allowUp） */
export function fitCanvas(canvas, maxSide, allowUpTo = 1) {
  const k = Math.min(allowUpTo, maxSide / Math.max(canvas.width, canvas.height));
  if (Math.abs(k - 1) < 0.01) return canvas;
  return cropCanvas(canvas, { x: 0, y: 0, w: canvas.width, h: canvas.height }, k);
}

export function toJpegBase64(canvas, q = 0.9) {
  return canvas.toDataURL('image/jpeg', q).split(',')[1];
}

export function toDataURL(canvas, q = 0.85) {
  return canvas.toDataURL('image/jpeg', q);
}

export function thumbnail(canvas, maxSide = 320) {
  return toDataURL(fitCanvas(canvas, maxSide), 0.8);
}

/**
 * 在框内取色块的主色：量化后取出现最多的颜色（字只占少数像素）。
 * box 为 {x0,y0,x1,y1}，会先向内收一点避免取到边框/背景。
 */
export function sampleSwatch(canvas, box, shrink = 0.15) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  if (!(bw > 2 && bh > 2)) return null;
  const x = Math.max(0, box.x0 + bw * shrink), y = Math.max(0, box.y0 + bh * shrink);
  const w = Math.min(canvas.width - x, bw * (1 - 2 * shrink)), h = Math.min(canvas.height - y, bh * (1 - 2 * shrink));
  if (w < 1 || h < 1) return null;
  const { data } = getImageData(canvas, { x, y, w, h });
  const bins = new Map();
  for (let p = 0; p < data.length; p += 4) {
    const k = (data[p] >> 3) << 10 | (data[p + 1] >> 3) << 5 | (data[p + 2] >> 3);
    let b = bins.get(k);
    if (!b) { b = [0, 0, 0, 0]; bins.set(k, b); }
    b[0] += data[p]; b[1] += data[p + 1]; b[2] += data[p + 2]; b[3]++;
  }
  let best = null;
  for (const b of bins.values()) if (!best || b[3] > best[3]) best = b;
  return best ? [best[0] / best[3], best[1] / best[3], best[2] / best[3]].map(Math.round) : null;
}

/**
 * 清单色块的候选颜色：框里出现最多的前几种颜色（按 5 位量化分组，每组取平均）。
 * 第一种通常就是色块底色；取歪了（取到字、白底）也没关系，拼豆板归类时会拿图上的格子逐个验证。
 */
export function swatchCandidates(canvas, box, shrink = 0.1, top = 3) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  if (!(bw > 2 && bh > 2)) return null;
  const x = Math.max(0, box.x0 + bw * shrink), y = Math.max(0, box.y0 + bh * shrink);
  const w = Math.min(canvas.width - x, bw * (1 - 2 * shrink)), h = Math.min(canvas.height - y, bh * (1 - 2 * shrink));
  if (w < 1 || h < 1) return null;
  const { data } = getImageData(canvas, { x, y, w, h });
  const bins = new Map();
  for (let p = 0; p < data.length; p += 4) {
    const k = (data[p] >> 3) << 10 | (data[p + 1] >> 3) << 5 | (data[p + 2] >> 3);
    let b = bins.get(k);
    if (!b) { b = [0, 0, 0, 0]; bins.set(k, b); }
    b[0] += data[p]; b[1] += data[p + 1]; b[2] += data[p + 2]; b[3]++;
  }
  const out = [...bins.values()].sort((a, b) => b[3] - a[3]).slice(0, top).map(b => [b[0] / b[3], b[1] / b[3], b[2] / b[3]].map(Math.round));
  return out.length ? out : null;
}

/** 估计色块里色号文字的像素高度（判断截图是否太糊）：取若干条目框分别估计再取中位数 */
export function estimateTextHeightInBoxes(canvas, boxes) {
  const hs = [];
  for (const b of boxes.slice(0, 10)) {
    const w = b.x1 - b.x0, hh = b.y1 - b.y0;
    if (!(w > 4 && hh > 4)) continue;
    const img = getImageData(canvas, { x: b.x0, y: b.y0, w, h: hh });
    const r = Math.max(3, Math.round(hh / 4));
    const hc = estimateCharHeight(components(textMask(img, r), img.width, img.height), img.height * 2);
    if (hc) hs.push(hc);
  }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)];
}
