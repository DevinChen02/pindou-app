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
 * 找不到时返回内容区下方 30%。imgData 为 content 区域的 ImageData。
 */
export function guessLegendRectFromData(img, content) {
  const { data, width: w, height: h } = img;
  const lum = (x, y) => { const p = (y * w + x) * 4; return 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]; };
  const step = Math.max(1, Math.floor(w / 400));
  let lastLine = -1;
  const n = Math.floor(w / step);
  for (let y = 2; y < h - 2; y++) {
    // 最长的连续“横线”段（允许 2 个采样点的小断口）；清单里一个个小方框的边不够长
    let run = 0, best = 0, gap = 0;
    for (let x = 0; x < w; x += step) {
      const a = lum(x, y), up = lum(x, y - 2), dn = lum(x, y + 2);
      if ((a - up > 18 && a - dn > 18) || (up - a > 18 && dn - a > 18)) { run += 1 + gap; gap = 0; if (run > best) best = run; }
      else if (run && gap < 2) gap++;
      else { run = 0; gap = 0; }
    }
    if (best / n > 0.6) lastLine = y;
  }
  const fallback = { x: content.x, y: content.y + content.h * 0.7, w: content.w, h: content.h * 0.3 };
  if (lastLine < 0) return fallback;
  const top = lastLine + 3;
  const rest = h - top;
  if (rest < h * 0.03 || rest > h * 0.6) return fallback;
  return { x: content.x, y: content.y + top, w: content.w, h: rest };
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
