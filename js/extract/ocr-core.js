// 离线 OCR 的图像处理部分（纯函数，浏览器和 Node 测试共用）。
// 输入都是 ImageData 形状的对象：{ data: RGBA 数组, width, height }。
//
// 思路：Tesseract 直接读整张清单时，常把相邻色块的字连成一串，也读不出深色底上的白字。
// 所以这里先自己把“字”找出来：
//   1. 按“同色连片”分割：大片同色区域（页面底色、色块、表格格子）是背景，其余是字
//   2. 连通域 → 估计字高 → 去掉色块边框、表格线等大块
//   3. 把相邻字符拼成“词”（一个色号或一个数量）
//   4. 每个词单独裁出、按字高放大成白底黑字，再交给 Tesseract 逐词识别

export function toLum(img) {
  const { data, width, height } = img;
  const L = new Float32Array(width * height);
  for (let i = 0, p = 0; i < L.length; i++, p += 4) {
    L[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return L;
}

function integral(L, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += L[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}

/**
 * 粗略文字掩膜（只用来估字高）：像素与“局部背景”差得多就算字。
 * 局部背景 = 邻域里尚未被判成字的像素的平均亮度（迭代 3 次）。
 */
export function textMask(img, r, thresh = 32, L = toLum(img)) {
  const { width: w, height: h } = img;
  const n = w * h;
  let M = new Uint8Array(n);
  const W1 = w + 1;
  for (let iter = 0; iter < 3; iter++) {
    const BG = new Float32Array(n), CNT = new Float32Array(n);
    for (let i = 0; i < n; i++) if (!M[i]) { BG[i] = L[i]; CNT[i] = 1; }
    const IS = integral(BG, w, h), IC = integral(CNT, w, h);
    const next = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const a = y1 * W1 + x1, b = y0 * W1 + x1, c = y1 * W1 + x0, d = y0 * W1 + x0;
        const cnt = IC[a] - IC[b] - IC[c] + IC[d];
        if (cnt < 1) { next[y * w + x] = M[y * w + x]; continue; }
        const mean = (IS[a] - IS[b] - IS[c] + IS[d]) / cnt;
        if (Math.abs(L[y * w + x] - mean) > thresh) next[y * w + x] = 1;
      }
    }
    M = next;
  }
  return M;
}

/** 8 邻接连通域 */
export function components(M, w, h) {
  const label = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  let id = 0;
  for (let i = 0; i < M.length; i++) {
    if (!M[i] || label[i]) continue;
    id++;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (M[q] && !label[q]) { label[q] = id; stack.push(q); }
        }
      }
    }
    comps.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return comps;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 估计字符高度：取“像字符”的连通域高度的众数 */
export function estimateCharHeight(comps, imgH) {
  const hs = comps
    .filter(c => c.h >= 5 && c.h <= imgH * 0.5 && c.w <= c.h * 1.6 && c.area >= 10 && c.area <= c.w * c.h * 0.8)
    .map(c => c.h);
  if (hs.length < 3) return 0;
  const hist = new Map();
  for (const v of hs) {
    for (const k of [v - 1, v, v + 1]) hist.set(k, (hist.get(k) || 0) + (k === v ? 2 : 1));
  }
  let best = 0, bestN = -1;
  for (const [k, n] of hist) if (n > bestN || (n === bestN && k > best)) { best = k; bestN = n; }
  return best || median(hs);
}

/** 把字符连通域拼成词；n = 估计的字符数（粘连的字按宽度估） */
export function groupWords(comps, hc) {
  const glyphs = c => (c.w <= hc * 0.95 ? 1 : Math.max(1, Math.round(c.w / (hc * 0.62))));
  const chars = comps.filter(c =>
    c.h >= hc * 0.35 && c.h <= hc * 1.6 && c.w <= hc * 5 && c.area >= hc * hc * 0.03);
  chars.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const lines = [];
  for (const c of chars) {
    const cy = (c.y0 + c.y1) / 2;
    let line = lines.find(l => Math.abs(l.cy - cy) < hc * 0.45);
    if (!line) { line = { cy, items: [] }; lines.push(line); }
    line.items.push(c);
    line.cy = line.items.reduce((s, it) => s + (it.y0 + it.y1) / 2, 0) / line.items.length;
  }
  const words = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const c of line.items) {
      if (cur && c.x0 - cur.x1 <= hc * 0.55) {
        cur.x0 = Math.min(cur.x0, c.x0); cur.x1 = Math.max(cur.x1, c.x1);
        cur.y0 = Math.min(cur.y0, c.y0); cur.y1 = Math.max(cur.y1, c.y1);
        cur.n += glyphs(c);
        cur.parts.push({ x0: c.x0, x1: c.x1 });
      } else {
        if (cur) words.push(cur);
        cur = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: glyphs(c), parts: [{ x0: c.x0, x1: c.x1 }] };
      }
    }
    if (cur) words.push(cur);
  }
  // 太宽的“词”（>7 个字高）多半是水印、表格线，丢掉
  return words.filter(wd => wd.x1 - wd.x0 <= hc * 7 && wd.y1 - wd.y0 >= hc * 0.5);
}

/** 双线性放大（RGBA） */
export function upscale(img, s) {
  const { data, width: w, height: h } = img;
  const W = Math.round(w * s), H = Math.round(h * s);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const sy = Math.min(h - 1.001, Math.max(0, (Y + 0.5) / s - 0.5));
    const iy = Math.floor(sy), fy = sy - iy;
    for (let X = 0; X < W; X++) {
      const sx = Math.min(w - 1.001, Math.max(0, (X + 0.5) / s - 0.5));
      const ix = Math.floor(sx), fx = sx - ix;
      const p = (iy * w + ix) * 4, q = (Y * W + X) * 4;
      for (let k = 0; k < 3; k++) {
        out[q + k] = data[p + k] * (1 - fx) * (1 - fy) + data[p + 4 + k] * fx * (1 - fy)
          + data[p + w * 4 + k] * (1 - fx) * fy + data[p + w * 4 + 4 + k] * fx * fy;
      }
      out[q + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * 按“颜色连成片”的区域分割：大片同色区域（页面底色、色块、表格格子）当背景，
 * 其余像素与“最近的大片区域”的颜色差即为 D（越大越像字）。
 * 字内的空洞（0、8、A 的中间）颜色和所在色块一样，不会被当成字。
 */
export function textDistance(img, k = 4, tol = 14) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = i => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const close = (p, q) => Math.abs(data[p] - data[q]) <= tol
    && Math.abs(data[p + 1] - data[q + 1]) <= tol && Math.abs(data[p + 2] - data[q + 2]) <= tol;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      if (x + 1 < w && close(p, p + 4)) { const a = find(i), b = find(i + 1); if (a !== b) parent[a] = b; }
      if (y + 1 < h && close(p, p + w * 4)) { const a = find(i), b = find(i + w); if (a !== b) parent[a] = b; }
    }
  }
  const root = new Int32Array(n);
  for (let i = 0; i < n; i++) root[i] = find(i);
  // “有厚度”的区域才算背景：区域里存在上下左右 k 像素内都属于同一区域的点。
  // 字的笔画很细，没有这样的点；色块、格子、页面底色都有。
  const core = new Int32Array(n);
  for (let y = k; y < h - k; y++) {
    for (let x = k; x < w - k; x++) {
      const i = y * w + x, r = root[i];
      if (root[i - k] === r && root[i + k] === r && root[i - k * w] === r && root[i + k * w] === r
        && root[i - k - k * w] === r && root[i + k + k * w] === r) core[r]++;
    }
  }
  const isBg = r => core[r] >= 12;
  const sum = new Map();
  for (let i = 0; i < n; i++) {
    const r = root[i];
    if (!isBg(r)) continue;
    let s = sum.get(r);
    if (!s) { s = [0, 0, 0, 0]; sum.set(r, s); }
    s[0] += data[i * 4]; s[1] += data[i * 4 + 1]; s[2] += data[i * 4 + 2]; s[3]++;
  }
  // 多源 BFS：每个像素归到最近的背景区域
  const bgOf = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (isBg(root[i])) { bgOf[i] = root[i]; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    if (x > 0 && bgOf[i - 1] === -1) { bgOf[i - 1] = bgOf[i]; queue[qt++] = i - 1; }
    if (x < w - 1 && bgOf[i + 1] === -1) { bgOf[i + 1] = bgOf[i]; queue[qt++] = i + 1; }
    if (i >= w && bgOf[i - w] === -1) { bgOf[i - w] = bgOf[i]; queue[qt++] = i - w; }
    if (i + w < n && bgOf[i + w] === -1) { bgOf[i + w] = bgOf[i]; queue[qt++] = i + w; }
  }
  const D = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (isBg(root[i]) || bgOf[i] < 0) continue;
    const s = sum.get(bgOf[i]);
    const dr = data[i * 4] - s[0] / s[3], dg = data[i * 4 + 1] - s[1] / s[3], db = data[i * 4 + 2] - s[2] / s[3];
    D[i] = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
  }
  return D;
}

function maskOf(D, T) {
  const M = new Uint8Array(D.length);
  for (let i = 0; i < D.length; i++) M[i] = D[i] > T ? 1 : 0;
  return M;
}

/**
 * 分析一张清单图：分割 → 连通域 → 按行聚类（每行有自己的字高，不同大小的字互不影响）→ 拼成词。
 * 返回 { words:[{x0,y0,x1,y1,n,hc,parts}], D, T, width, height }（原图坐标）
 */
export function analyze(img) {
  const T = 30;
  const D = textDistance(img, 4);
  const W = img.width, H = img.height;
  let comps = components(maskOf(D, T), W, H)
    .filter(c => c.h >= 5 && c.h <= H * 0.6 && c.w <= c.h * 6 && c.area >= 6 && !(c.h < 8 && c.w < 3));
  // 去掉色块/格子的边框：很“空”的大连通域，或者里面套着别的连通域的
  comps = comps.filter(a => {
    if (a.h > 12 && a.area / (a.w * a.h) < 0.1) return false;
    return !comps.some(b => b !== a && b.h < a.h * 0.7 && b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1);
  });
  // 按行聚类：垂直方向重叠一半以上、高度相近
  comps.sort((a, b) => a.y0 - b.y0);
  const lines = [];
  for (const c of comps) {
    let best = null;
    for (const l of lines) {
      const ov = Math.min(l.y1, c.y1) - Math.max(l.y0, c.y0);
      const ratio = c.h / l.hMed;
      if (ov > Math.min(c.h, l.hMed) * 0.5 && ratio > 0.4 && ratio < 1.8) { best = l; break; }
    }
    if (!best) { best = { y0: c.y0, y1: c.y1, items: [], hMed: c.h }; lines.push(best); }
    best.items.push(c);
    best.y0 = Math.min(best.y0, c.y0); best.y1 = Math.max(best.y1, c.y1);
    // 行高只看“像字”的连通域（细长竖线多半是色块边框）
    const charLike = best.items.filter(i => i.w / i.h >= 0.25);
    const hs = (charLike.length ? charLike : best.items).map(i => i.h).sort((a, b) => a - b);
    best.hMed = hs[Math.floor(hs.length * 0.6)];
  }
  const words = [];
  for (const line of lines) {
    const hc = line.hMed;
    const ws = groupWords(line.items, hc).map(wd => ({ ...wd, hc }));
    // 一行里词特别多（格子里的色号、行列号）→ 不是清单，跳过；字太小（< 6px）也读不出来
    if (ws.length > 40 || hc < 6) continue;
    words.push(...ws);
  }
  // 同一行的字偶尔被分到两个“行”里（比如被色块边框干扰），把紧挨着的词再合并一次
  words.sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    if (!a) continue;
    for (let j = i + 1; j < words.length; j++) {
      const b = words[j];
      if (!b) continue;
      const hc = Math.max(a.hc, b.hc);
      const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const gap = b.x0 - a.x1;
      if (ov > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.7 && gap > -hc * 0.2 && gap <= hc * 0.55 && a.hc / b.hc < 1.4 && b.hc / a.hc < 1.4) {
        words[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), n: a.n + b.n, hc, parts: [...a.parts, ...b.parts] };
        words[j] = null;
        j = i; // 重新检查合并后的词
        continue;
      }
    }
  }
  for (let i = words.length - 1; i >= 0; i--) if (!words[i]) words.splice(i, 1);
  return { words, D, T, width: W, height: H, scale: 1, hc: median(words.map(w => w.hc)) || 0 };
}

/**
 * 裁出一个词，放大到目标字高，二值化成“白底黑字”，四周留白。
 * ana 为 analyze() 的返回值。返回 ImageData 形状对象。
 */
export function wordImage(ana, box, targetH = 40, T = ana.T, blur = false, spread = 0) {
  const { D } = ana;
  const hc = box.hc || ana.hc;
  const W = ana.width, H = ana.height;
  const pad = Math.round(hc * 0.25);
  const y0 = Math.max(0, box.y0 - pad), y1 = Math.min(H, box.y1 + pad);
  const ch = y1 - y0;
  const s = Math.max(0.5, targetH / hc);
  // 分段：spread>0 时每个字符单独一段，段间多留空，避免 “11” 被读成 “1”
  let segs;
  if (spread && box.parts && box.parts.length > 1) {
    const ps = [...box.parts].sort((a, b) => a.x0 - b.x0);
    segs = ps.map((p, k) => ({
      x0: k === 0 ? Math.max(0, p.x0 - pad) : Math.floor((ps[k - 1].x1 + p.x0) / 2),
      x1: k === ps.length - 1 ? Math.min(W, p.x1 + pad) : Math.ceil((p.x1 + ps[k + 1].x0) / 2),
    }));
  } else {
    segs = [{ x0: Math.max(0, box.x0 - pad), x1: Math.min(W, box.x1 + pad) }];
  }
  const gap = Math.round(spread * targetH);
  const oh = Math.max(1, Math.round(ch * s));
  const segW = segs.map(g => Math.max(1, Math.round((g.x1 - g.x0) * s)));
  const ow = segW.reduce((a, b) => a + b, 0) + gap * (segs.length - 1);
  const m = Math.round(targetH * 0.5);
  const OW = ow + 2 * m, OH = oh + 2 * m;
  const out = new Uint8ClampedArray(OW * OH * 4).fill(255);
  let offX = m;
  segs.forEach((g, k) => {
    const cw = g.x1 - g.x0;
    for (let oy = 0; oy < oh; oy++) {
      const sy = Math.min(ch - 1.001, Math.max(0, (oy + 0.5) / s - 0.5));
      const iy = Math.floor(sy), fy = sy - iy;
      for (let ox = 0; ox < segW[k]; ox++) {
        const sx = Math.min(cw - 1.001, Math.max(0, (ox + 0.5) / s - 0.5));
        const ix = Math.floor(sx), fx = sx - ix;
        const p = (y0 + iy) * W + g.x0 + ix;
        const v = D[p] * (1 - fx) * (1 - fy) + D[p + 1] * fx * (1 - fy) + D[p + W] * (1 - fx) * fy + D[p + W + 1] * fx * fy;
        if (v > T) {
          const q = ((oy + m) * OW + offX + ox) * 4;
          out[q] = out[q + 1] = out[q + 2] = 0;
        }
      }
    }
    offX += segW[k] + gap;
  });
  return blur ? boxBlur({ data: out, width: OW, height: OH }) : { data: out, width: OW, height: OH };
}

/** 3×3 均值模糊：给二值字形加一点抗锯齿，Tesseract 更喜欢 */
function boxBlur(img) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += data[(yy * w + xx) * 4]; c++;
        }
      }
      const q = (y * w + x) * 4;
      out[q] = out[q + 1] = out[q + 2] = s / c;
      out[q + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** 逐词识别时依次尝试的参数；前一个读不出/置信度低就换下一个 */
export const OCR_ATTEMPTS = [
  { psm: '7', th: 36, T: null, blur: true },
  { psm: '7', th: 36, T: null, blur: true, spread: 0.35 },
  { psm: '8', th: 44, T: 55, blur: true },
  { psm: '7', th: 28, T: 70, blur: true },
];

/** 识别结果的字数是否和图上的字符数对得上 */
export function lengthMatches(text, n) {
  const t = String(text || '').replace(/\s+/g, '');
  return !n || t.length === n;
}

/** 词的文字是否“像样”：能读成色号或数量 */
export function plausibleToken(text, normalizeCode) {
  const t = String(text || '').replace(/\s+/g, '').replace(/^[^A-Za-z0-9x(]+|[^0-9A-Za-z)]+$/g, '');
  if (!t) return false;
  if (/^[xX×*]?\(?\d{1,5}\)?$/.test(t)) return true;
  if (normalizeCode(t)) return true;
  return /^([A-Za-z][0-9A-Za-z]{1,2}?)[xX×*(]+(\d{1,5})\)?$/.test(t) && !!normalizeCode(t.match(/^([A-Za-z][0-9A-Za-z]{1,2}?)/)[1]);
}

// ---------- 词 → (色号, 数量) 配对 ----------

const COUNT_RE = /^[xX×*]?\(?(\d{1,5})\)?$/;

/**
 * words: [{ text, x0, y0, x1, y1, conf }]
 * normalizeCode: palette.normalizeCode
 * 返回 [{ code, rawCode, count, codeBox, countBox, uncertain }]
 */
export function pairWords(words, normalizeCode) {
  const codes = [], counts = [], amb = [], junk = [];
  for (const wd of words) {
    let t = String(wd.text || '').replace(/\s+/g, '');
    // 去掉首尾杂字符（例如 "(G14" 里多读的括号），但保留数量两边成对的括号
    if (!/^\(\d+\)$/.test(t)) t = t.replace(/^[^A-Za-z0-9x]+/, '').replace(/[^0-9A-Za-z)]+$/, '').replace(/^([A-Za-z]\d{1,2})\)$/, '$1');
    if (!t) { junk.push({ ...wd, raw: '' }); continue; }
    // 色号和数量粘在一起：H2(2606) / A11x68
    const glued = t.match(/^([A-Za-z][0-9A-Za-z]{1,2}?)[xX×*(]+(\d{1,5})\)?$/);
    if (glued && normalizeCode(glued[1])) {
      const frac = glued[1].length / t.length;
      const mid = wd.x0 + (wd.x1 - wd.x0) * frac;
      const g = codes.length + 1;
      codes.push({ ...wd, x1: mid, raw: glued[1], code: normalizeCode(glued[1]), glued: g });
      counts.push({ ...wd, x0: mid, n: +glued[2], prefixed: true, glued: g });
      continue;
    }
    const cm = t.match(COUNT_RE);
    const prefixed = /^[xX×*(]/.test(t);
    const code = prefixed ? null : normalizeCode(t);
    if (code && /[A-Za-z]/.test(t)) { codes.push({ ...wd, raw: t, code }); continue; }
    // 纯数字但也能读成色号（像素字体里 G→6、B→8）：先存着，按位置再判断
    if (code && cm) { amb.push({ ...wd, raw: t, code, n: +cm[1] }); continue; }
    if (cm) { counts.push({ ...wd, n: +cm[1], prefixed }); continue; }
    if (/^[A-Za-z][0-9A-Za-z]{1,2}$/.test(t)) codes.push({ ...wd, raw: t, code: null });
    else junk.push({ ...wd, raw: t });
  }
  for (const a of amb) {
    const h = Math.max(4, a.y1 - a.y0), cy = (a.y0 + a.y1) / 2, cx = (a.x0 + a.x1) / 2;
    const rowOf = t => Math.abs((t.y0 + t.y1) / 2 - cy) < h * 0.5;
    const codeOnLeft = codes.some(c => rowOf(c) && a.x0 - c.x1 > -h * 0.3 && a.x0 - c.x1 < h * 4);
    const countBelow = [...counts, ...amb].some(t => t !== a
      && (t.y0 + t.y1) / 2 - cy > h * 0.6 && (t.y0 + t.y1) / 2 - cy < h * 4
      && Math.abs((t.x0 + t.x1) / 2 - cx) < h * 1.5);
    const sameRowAsCount = counts.some(rowOf);
    const sameRowAsCode = codes.some(rowOf);
    let isCode;
    if (codeOnLeft) isCode = false;
    else if (countBelow && !sameRowAsCount) isCode = true;
    else isCode = sameRowAsCode && !sameRowAsCount;
    if (isCode) codes.push({ ...a, amb: true });
    else counts.push({ ...a, prefixed: false });
  }
  // 一行里只有孤零零一个数字的，多半是杂字（水印、角标），配对时降权
  const rowSupport = (list, t) => {
    const h = Math.max(4, t.y1 - t.y0), cy = (t.y0 + t.y1) / 2;
    return list.filter(o => Math.abs((o.y0 + o.y1) / 2 - cy) < h * 0.5).length;
  };
  const support = counts.map(t => rowSupport(counts, t));
  const medSupport = median(support);
  const maxSupport = Math.max(0, ...support);
  const codeSupport = codes.map(c => rowSupport(codes, c));
  const maxCodeSupport = Math.max(0, ...codeSupport);
  // 需要“纠错”才能读成色号的（如 EA→E4），可信度低
  const fixed = codes.map(c => !!c.code && String(c.raw).toUpperCase().replace(/^([A-Z])0+/, '$1') !== c.code);
  // 两种版式分别配对：数量在色号“正下方” / “右边同一行”，取置信度总分高的那种
  const candBelow = [], candRight = [];
  codes.forEach((c, i) => {
    const h = Math.max(4, c.y1 - c.y0), ccx = (c.x0 + c.x1) / 2, ccy = (c.y0 + c.y1) / 2;
    counts.forEach((t, j) => {
      if (c.glued || t.glued) { if (c.glued && c.glued === t.glued) { candBelow.push({ i, j, cost: -9 }); candRight.push({ i, j, cost: -9 }); } return; }
      const tcx = (t.x0 + t.x1) / 2, tcy = (t.y0 + t.y1) / 2;
      const dx = tcx - ccx, dy = tcy - ccy;
      let bonus = t.prefixed ? -0.4 : 0;
      if ((support[j] === 1 && medSupport >= 3) || support[j] < maxSupport * 0.5) bonus += 2;
      if (codeSupport[i] < maxCodeSupport * 0.5) bonus += 1.5;
      if (fixed[i]) bonus += 0.8;
      if (dy > h * 0.5 && dy < h * 5 && Math.abs(dx) < Math.max(c.x1 - c.x0, t.x1 - t.x0) * 0.8 + h) {
        candBelow.push({ i, j, cost: dy / h + Math.abs(dx) / h * 0.6 + bonus });
      }
      const gap = t.x0 - c.x1;
      if (Math.abs(dy) < h * 0.6 && gap > -h * 0.3 && gap < h * 7) {
        candRight.push({ i, j, cost: 0.6 + gap / h * 0.7 + Math.abs(dy) / h + bonus });
      }
    });
  });
  const greedy = cand => {
    cand.sort((a, b) => a.cost - b.cost);
    const usedC = new Set(), usedT = new Set(), map = new Map();
    let score = 0;
    for (const { i, j } of cand) {
      if (usedC.has(i) || usedT.has(j)) continue;
      usedC.add(i); usedT.add(j); map.set(i, j);
      const t = counts[j];
      score += 1 + (t.conf ?? 80) / 100 + (t.prefixed ? 0.5 : 0);
    }
    return { map, score };
  };
  const b = greedy(candBelow), r = greedy(candRight);
  const below = b.score >= r.score;
  const pairOf = (below ? b : r).map;
  const items = codes.map((c, i) => {
    const t = pairOf.has(i) ? counts[pairOf.get(i)] : null;
    return {
      code: c.code, rawCode: c.raw, count: t ? t.n : null,
      codeBox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
      countBox: t ? { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 } : null,
      uncertain: !c.code || !t || !!c.amb || fixed[i] || (c.conf != null && c.conf < 60) || (t && t.conf != null && t.conf < 60),
    };
  }).filter(it => it.code || it.count != null);
  // 没配上数量的色号：只有和已配对的色号在同一行时才保留（多半是数量没读出来），
  // 否则多半是框进来的格子里的字，丢掉
  const pairedRows = items.filter(it => it.count != null).map(it => [(it.codeBox.y0 + it.codeBox.y1) / 2, it.codeBox.y1 - it.codeBox.y0]);
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    if (it.count != null) continue;
    const cy = (it.codeBox.y0 + it.codeBox.y1) / 2;
    if (!pairedRows.some(([y, hh]) => Math.abs(y - cy) < hh * 0.5)) items.splice(k, 1);
  }
  // 读出了数量、但对应位置的色号没读出来：留一个“待填色号”的条目，核对时按色块颜色给建议
  const pairedT = new Set(pairOf.values());
  const usedJ = new Set();
  counts.forEach((t, j) => {
    if (pairedT.has(j) || (support[j] === 1 && medSupport >= 3) || support[j] < maxSupport * 0.5) return;
    const h = Math.max(4, t.y1 - t.y0), tcx = (t.x0 + t.x1) / 2, tcy = (t.y0 + t.y1) / 2;
    let bestK = -1, bestCost = Infinity;
    junk.forEach((c, k) => {
      if (usedJ.has(k)) return;
      const ccx = (c.x0 + c.x1) / 2, ccy = (c.y0 + c.y1) / 2;
      const onCodeRow = codes.some(o => Math.abs((o.y0 + o.y1) / 2 - ccy) < h * 0.5);
      if (!onCodeRow) return;
      let cost = Infinity;
      if (below && tcy - ccy > h * 0.5 && tcy - ccy < h * 5 && Math.abs(tcx - ccx) < h * 2) cost = (tcy - ccy) / h + Math.abs(tcx - ccx) / h;
      if (!below && Math.abs(tcy - ccy) < h * 0.6 && t.x0 - c.x1 > -h * 0.3 && t.x0 - c.x1 < h * 7) cost = (t.x0 - c.x1) / h;
      if (cost < bestCost) { bestCost = cost; bestK = k; }
    });
    if (bestK < 0) return;
    usedJ.add(bestK);
    const c = junk[bestK];
    items.push({
      code: null, rawCode: c.raw || '?', count: t.n,
      codeBox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
      countBox: { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 }, uncertain: true,
    });
  });
  const hMed = median(items.map(it => it.codeBox.y1 - it.codeBox.y0)) || 10;
  items.sort((a, b) => {
    const dy = a.codeBox.y0 - b.codeBox.y0;
    return Math.abs(dy) > hMed * 0.8 ? dy : a.codeBox.x0 - b.codeBox.x0;
  });
  return items;
}
