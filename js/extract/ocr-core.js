// 离线 OCR 的图像处理部分（纯函数，浏览器和 Node 测试共用）。
// 输入都是 ImageData 形状的对象：{ data: RGBA 数组, width, height }。
//
// 思路：Tesseract 直接读整张清单时，常把相邻色块的字连成一串，也读不出深色底上的白字。
// 所以这里先自己把“字”找出来：
//   1. 按“同色连片”分割：大片同色区域（页面底色、色块、表格格子）是背景，其余是字
//   2. 连通域 → 估计字高 → 去掉色块边框、表格线等大块
//   3. 把相邻字符拼成“词”（一个色号或一个数量）；底色不一样的（色块上的色号、白底上的数量）挨得再近也不拼
//   4. 每个词单独交给 PP-OCR（或裁出、按字高放大成白底黑字交给 Tesseract）逐词识别
//   字很小（< 12 像素）时再放大两倍分一次词、读一遍，取读得好的那次（readLegend）

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
  comps.label = label; // 第 k 个连通域的像素标签是 k+1
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
  // 比字高一截的直的细竖线：色块、格子的边（“1”和字一样高，括号是弯的）；它自己单独算一个词，不和两边的字拼在一起
  const isSep = c => c.h > hc * 1.4 && c.w < c.h * 0.25 && c.area >= c.w * c.h * 0.7;
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
      // 挨得近、底色也一样才是同一个词：色号写在色块上、数量写在白底上，两个挨得再近也分开
      if (cur && c.x0 - cur.x1 <= hc * 0.55 && !bgApart(cur.bgR, c.bg) && !cur.sep && !isSep(c)) {
        cur.x0 = Math.min(cur.x0, c.x0); cur.x1 = Math.max(cur.x1, c.x1);
        cur.y0 = Math.min(cur.y0, c.y0); cur.y1 = Math.max(cur.y1, c.y1);
        cur.n += glyphs(c);
        cur.parts.push({ x0: c.x0, x1: c.x1 });
        if (c.bg) cur.bgR = c.bg;
      } else {
        if (cur) words.push(cur);
        cur = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: glyphs(c), parts: [{ x0: c.x0, x1: c.x1 }], bgL: c.bg, bgR: c.bg, sep: isSep(c) };
      }
    }
    if (cur) words.push(cur);
  }
  // 太宽的“词”（>7 个字高）多半是水印、表格线，丢掉
  return words.filter(wd => wd.x1 - wd.x0 <= hc * 7 && wd.y1 - wd.y0 >= hc * 0.5);
}

/**
 * 按“颜色连成片”的区域分割：大片同色区域（页面底色、色块、表格格子）当背景，
 * 其余像素与“最近的大片区域”的颜色差即为 D（越大越像字）。
 * 字内的空洞（0、8、A 的中间）颜色和所在色块一样，不会被当成字。
 */
export function textDistance(img, k = 4, tol = 14, opt = {}) {
  const { width: w, height: h } = img;
  const n = w * h;
  const src = img.data;
  // 分区域用的图：可选先 3×3 平均（压掉 JPEG 噪点），算“字离背景多远”仍用原图
  const data = opt.smooth ? smooth3(src, w, h) : src;
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
  const isBg = r => core[r] >= (opt.minCore ?? 12);
  const sum = new Map();
  for (let i = 0; i < n; i++) {
    const r = root[i];
    if (!isBg(r)) continue;
    let s = sum.get(r);
    if (!s) { s = [0, 0, 0, 0]; sum.set(r, s); }
    s[0] += src[i * 4]; s[1] += src[i * 4 + 1]; s[2] += src[i * 4 + 2]; s[3]++;
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
    const dr = src[i * 4] - s[0] / s[3], dg = src[i * 4 + 1] - s[1] / s[3], db = src[i * 4 + 2] - s[2] / s[3];
    D[i] = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
  }
  return D;
}

/** 两种底色差多少（和 D 一样按每通道均方根算） */
const colorDiff = (a, b) => Math.sqrt(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) / 3);
/** 两个字的底色明显不一样（一个在色块上、一个在白底上）：不能拼成一个词 */
const BG_SPLIT = 30;
const bgApart = (a, b) => !!(a && b && colorDiff(a, b) > BG_SPLIT);

/**
 * 每个字的底色：字的框里（上下各多一行）不是字的像素（D 小）的颜色中位数——字的笔画之间、上下紧挨着的就是它的底色。
 * 这些像素颜色不一致（字横跨色块边缘、一半在色块上一半在白底上）就不定底色，照常拼词。
 * 不用“最近的背景区域”：浅色色块和白底之间是渐变时，两块会被连成同一个区域，分不开。
 */
function attachBg(comps, img, D, T) {
  const { data, width: W, height: H } = img;
  for (const c of comps) {
    const px = [];
    for (let y = Math.max(0, c.y0 - 1); y < Math.min(H, c.y1 + 1); y++) for (let x = c.x0; x < c.x1; x++) {
      const i = y * W + x;
      if (D[i] <= T * 0.5) px.push(i * 4);
    }
    if (px.length < 6) continue;
    const m = [0, 1, 2].map(k => median(px.map(p => data[p + k])));
    const near = px.filter(p => colorDiff([data[p], data[p + 1], data[p + 2]], m) <= BG_SPLIT).length;
    if (near >= px.length * 0.7) c.bg = m;
  }
}

/** 3×3 平均（RGB） */
function smooth3(data, w, h) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - 1), yb = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - 1), xb = Math.min(w - 1, x + 1);
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) { const p = (yy * w + xx) * 4; r += data[p]; g += data[p + 1]; b += data[p + 2]; c++; }
      const q = (y * w + x) * 4;
      out[q] = r / c; out[q + 1] = g / c; out[q + 2] = b / c; out[q + 3] = 255;
    }
  }
  return out;
}

function maskOf(D, T) {
  const M = new Uint8Array(D.length);
  for (let i = 0; i < D.length; i++) M[i] = D[i] > T ? 1 : 0;
  return M;
}

/**
 * 补救没认成背景的色块：噪点太多（低质量 JPEG、缩小过）的色块会整块被当成“字”，和里面的色号连成一大团，
 * 后面又被当成边框扔掉，色号就丢了。对这种“实心的一大团”：取它自己像素里最多的颜色当色块底色，
 * 和底色差得多的像素才是字；拆出来的像一排字（大小合适、不碰边、上下对齐）就换成这些字，否则原样保留。
 * 同时把这块的 D 改成“离色块底色多远”，Tesseract 那条路（wordImage）也能用。
 */
function rescueSwatches(img, D, comps, W) {
  const { data } = img, label = comps.label;
  const out = [];
  comps.forEach((a, k) => {
    if (!(a.h >= 12 && a.area >= 150 && a.area / (a.w * a.h) >= 0.3)) { out.push(a); return; }
    const id = k + 1;
    // 色块是实心的一块：外框一圈基本都是这一团自己的像素；一串粘连的字外框大多是空白，不动
    let edge = 0, edgeIn = 0;
    for (let x = a.x0; x < a.x1; x++) for (const y of [a.y0, a.y1 - 1]) { edge++; if (label[y * W + x] === id) edgeIn++; }
    for (let y = a.y0 + 1; y < a.y1 - 1; y++) for (const x of [a.x0, a.x1 - 1]) { edge++; if (label[y * W + x] === id) edgeIn++; }
    if (edgeIn < edge * 0.5) { out.push(a); return; }
    // 这团像素里最多的颜色（每通道 5 位量化）
    const bins = new Map();
    for (let y = a.y0; y < a.y1; y++) for (let x = a.x0; x < a.x1; x++) {
      const i = y * W + x;
      if (label[i] !== id) continue;
      const p = i * 4, key = (data[p] >> 3) << 10 | (data[p + 1] >> 3) << 5 | (data[p + 2] >> 3);
      let b = bins.get(key); if (!b) { b = [0, 0, 0, 0]; bins.set(key, b); }
      b[0] += data[p]; b[1] += data[p + 1]; b[2] += data[p + 2]; b[3]++;
    }
    // 相邻的量化格（每通道 ±2 格）一起算：噪点会把同一种颜色分到几个格里
    let best = null, bestN = 0;
    for (const [key, b] of bins) {
      const r = key >> 10, g = (key >> 5) & 31, bl = key & 31;
      let n = 0;
      for (const [k2, b2] of bins) if (Math.abs((k2 >> 10) - r) <= 2 && Math.abs(((k2 >> 5) & 31) - g) <= 2 && Math.abs((k2 & 31) - bl) <= 2) n += b2[3];
      if (n > bestN) { bestN = n; best = b; }
    }
    if (!best || bestN < a.area * 0.25) { out.push(a); return; }
    const bg = [best[0] / best[3], best[1] / best[3], best[2] / best[3]];
    const w = a.w, h = a.h;
    const dist = new Float32Array(w * h), M = new Uint8Array(w * h);
    // 框里所有像素都算（色块没认成背景时，色块上的白字离页面白底很近，根本不在这一团里，是这一团里的“洞”）
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = ((a.y0 + y) * W + a.x0 + x) * 4, dr = data[p] - bg[0], dg = data[p + 1] - bg[1], db = data[p + 2] - bg[2];
      dist[y * w + x] = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
    }
    // 字和底色的分界：底色像素离底色很近，字很远；取 45 和“最远的一成”的一半里大的那个
    const vals = [...dist].filter(v => v > 0).sort((u, v) => u - v);
    const thr = Math.max(40, (vals[Math.floor(vals.length * 0.9)] || 0) * 0.5);
    for (let i = 0; i < w * h; i++) M[i] = dist[i] > thr ? 1 : 0;
    const parts = components(M, w, h), pl = parts.label;
    // 色块上的字四周都是色块（这一团自己的像素）；字本身的毛边四周有一半是外面
    const enclosed = (c, j) => {
      let inside = 0, all = 0;
      for (let y = Math.max(0, c.y0 - 1); y < Math.min(h, c.y1 + 1); y++) for (let x = Math.max(0, c.x0 - 1); x < Math.min(w, c.x1 + 1); x++) {
        if (pl[y * w + x] === j + 1) continue;
        const near = (x > 0 && pl[y * w + x - 1] === j + 1) || (x < w - 1 && pl[y * w + x + 1] === j + 1) || (y > 0 && pl[(y - 1) * w + x] === j + 1) || (y < h - 1 && pl[(y + 1) * w + x] === j + 1);
        if (!near) continue;
        all++;
        if (label[(a.y0 + y) * W + a.x0 + x] === id) inside++;
      }
      return all > 0 && inside / all >= 0.6;
    };
    const chars = parts.filter((c, j) => c.h >= h * 0.3 && c.h <= h * 0.92 && c.w <= c.h * 1.6 && c.area >= 8
      && c.x0 > 0 && c.y0 > 0 && c.x1 < w && c.y1 < h && enclosed(c, j));
    const cys = chars.map(c => (c.y0 + c.y1) / 2);
    const aligned = chars.length && Math.max(...cys) - Math.min(...cys) <= h * 0.25;
    const inkArea = chars.reduce((t, c) => t + c.area, 0);
    // 色号至少两个字（字母 + 数字）；色块比字高一截
    const tall = Math.max(0, ...chars.map(c => c.h));
    if (!aligned || chars.length < 2 || chars.length > 6 || inkArea < a.area * 0.05 || h < tall * 1.15) { out.push(a); return; }
    for (const c of chars) out.push({ ...c, x0: c.x0 + a.x0, x1: c.x1 + a.x0, y0: c.y0 + a.y0, y1: c.y1 + a.y0 });
    const keep = new Set(chars.map(c => parts.indexOf(c) + 1));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (a.y0 + y) * W + a.x0 + x, j = y * w + x;
      if (keep.has(pl[j])) D[i] = Math.max(D[i], dist[j]);
      else if (label[i] === id) D[i] = 0;
    }
  });
  return out;
}

/**
 * 一行词是不是“色号、数量”一对一对排开的：色号和自己的数量挨得近、和下一个色号离得远，相邻的间距一大一小交替。
 * 格子里的色号、行列号是等距排开的，相邻间距差不多一样。返回间距“交替”的比例（0–1）
 */
function pairedSpacing(ws) {
  const cx = ws.map(w => (w.x0 + w.x1) / 2).sort((a, b) => a - b);
  const d = cx.slice(1).map((v, i) => v - cx[i]).filter(v => v > 0);
  let alt = 0;
  for (let i = 0; i + 1 < d.length; i++) if (Math.abs(d[i] - d[i + 1]) / Math.min(d[i], d[i + 1]) > 0.25) alt++;
  return alt / Math.max(1, d.length - 1);
}

/**
 * 分析一张清单图：分割 → 连通域 → 按行聚类（每行有自己的字高，不同大小的字互不影响）→ 拼成词。
 * 返回 { words:[{x0,y0,x1,y1,n,hc,parts}], D, T, width, height }（原图坐标）
 */
export function analyze(img, opt = {}) {
  // opt.scale = 2：先放大两倍再分（字只有 6–10 像素高时，色块、数量框里留的底色太窄，原图上认不出是底色）
  if (opt.scale === 2) return { ...analyze(upscale2(img), { ...opt, scale: 1 }), scale: 2 };
  const T = 30;
  // k=3：色块小、字大、色块上还有 JPEG 噪点时，色块也要能认成“背景”（k=4 时珍珠兔兔那张 29 色只认出 19 色）
  const D = textDistance(img, opt.k ?? 3, opt.tol ?? 14, opt);
  const W = img.width, H = img.height;
  const raw = components(maskOf(D, T), W, H);
  let comps = (opt.rescue === false ? raw : rescueSwatches(img, D, raw, W))
    .filter(c => c.h >= 5 && c.h <= H * 0.6 && c.w <= c.h * 6 && c.area >= 6 && !(c.h < 8 && c.w < 3));
  // 每个字的底色（色块补救改过 D 之后再算，色块上的字四周就是色块的颜色）
  attachBg(comps, img, D, T);
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
    // 字太小（< 6px）读不出来；一行里词特别多（格子里的色号、行列号）→ 不是清单，跳过。
    // 但清单排成一行的（20 多种颜色就有 40 多个词）照常读：它是“色号、数量”一对一对的，间距一大一小交替，格子和行列号是等距的
    if (hc < 6 || (ws.length > 40 && (ws.length > 120 || pairedSpacing(ws) < 0.6))) continue;
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
      if (ov > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.7 && gap > -hc * 0.2 && gap <= hc * 0.55 && a.hc / b.hc < 1.4 && b.hc / a.hc < 1.4 && !bgApart(a.bgR, b.bgL) && !a.sep && !b.sep) {
        words[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), n: a.n + b.n, hc, parts: [...a.parts, ...b.parts], bgL: a.bgL, bgR: b.bgR };
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
/**
 * 按这个词自己的“墨色深浅”定阈值：取框内 D 的 95 分位的一半。
 * 低分辨率 JPEG 里细字边缘发虚，全局阈值会把笔画描粗（A8 糊成一团、G15 读成 618），自适应阈值更清楚。
 */
export function autoT(ana, box) {
  const { D } = ana, W = ana.width;
  const vals = [];
  const step = Math.max(1, Math.floor((box.x1 - box.x0) * (box.y1 - box.y0) / 4000));
  let k = 0;
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) if (k++ % step === 0) vals.push(D[y * W + x]);
  if (!vals.length) return ana.T;
  vals.sort((a, b) => a - b);
  return Math.max(12, vals[Math.floor(vals.length * 0.95)] * 0.5);
}

export function wordImage(ana, box, targetH = 40, T = ana.T, blur = false, spread = 0) {
  const { D } = ana;
  if (T === 'auto') T = autoT(ana, box);
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
  { psm: '7', th: 36, T: 'auto', blur: true }, // 每个词自适应阈值（低清 JPEG 细字更准）
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
  const g = t.match(/^([A-Za-z]{1,3}[0-9A-Za-z]{1,3}?)[xX×*(]+(\d{1,5})\)?$/);
  return !!g && !!normalizeCode(g[1]);
}

// ---------- 词 → (色号, 数量) 配对 ----------

const COUNT_RE = /^[xX×*]?\(?(\d{1,5})\)?$/;

/**
 * words: [{ text, x0, y0, x1, y1, conf }]
 * normalizeCode: palette.normalizeCode
 * 返回 [{ code, rawCode, count, codeBox, countBox, uncertain }]
 */
const RULER = Array.from({ length: 99 }, (_, i) => i + 1).join('');
/** 这一串数字像不像坐标刻度连起来读出的（67891、1011121314…）；带括号/x 的是数量，不算 */
function rulerLike(t) {
  const raw = String(t.raw ?? t.text ?? '');
  if (/[()xX×*]/.test(raw)) return 0;
  const d = raw.replace(/\D/g, '');
  return d.length >= 4 && RULER.includes(d) ? d.length : 0;
}
function dropRulerRows(codes, counts, amb, junk) {
  const all = [...codes, ...counts, ...amb, ...junk];
  const rows = [];
  for (const t of all) {
    const h = Math.max(4, t.y1 - t.y0), cy = (t.y0 + t.y1) / 2;
    const r = rows.find(r => Math.abs(r.cy - cy) < Math.max(r.h, h) * 0.5);
    if (r) r.items.push(t); else rows.push({ cy, h, items: [t] });
  }
  const bad = new Set();
  for (const r of rows) {
    const lens = r.items.map(t => rulerLike({ raw: String(t.text || '').replace(/\s+/g, '') })).filter(Boolean);
    if (lens.length >= 2 || lens.some(n => n >= 5)) for (const t of r.items) bad.add(t);
  }
  if (!bad.size) return;
  for (const list of [codes, counts, amb]) for (let i = list.length - 1; i >= 0; i--) if (bad.has(list[i])) list.splice(i, 1);
}

export function pairWords(words, normalizeCode) {
  const codes = [], counts = [], amb = [], junk = [];
  for (const wd of words) {
    let t = String(wd.text || '').replace(/\s+/g, '');
    // 去掉首尾杂字符（例如 "(G14" 里多读的括号），但保留数量两边成对的括号
    if (!/^\(\d+\)$/.test(t)) t = t.replace(/^[^A-Za-z0-9x]+/, '').replace(/[^0-9A-Za-z)]+$/, '').replace(/^([A-Za-z]{1,3}\d{1,3})\)$/, '$1');
    if (!t) { junk.push({ ...wd, raw: '' }); continue; }
    // 色号和数量粘在一起：H2(2606) / A11x68
    const glued = t.match(/^([A-Za-z]{1,3}[0-9A-Za-z]{1,3}?)[xX×*(]+(\d{1,5})\)?$/);
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
    if (/^[A-Za-z]{1,3}[0-9A-Za-z]{1,3}$/.test(t) && /\d/.test(t)) codes.push({ ...wd, raw: t, code: null });
    else junk.push({ ...wd, raw: t });
  }
  // 格子边上的坐标刻度（1 2 3 … 71）常被框进清单，读成 “P1 234”“67891” 这种：整行丢掉
  dropRulerRows(codes, counts, amb, junk);
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
  const fixed = codes.map(c => !!c.code && String(c.raw).toUpperCase().replace(/^([A-Z]+)0+/, '$1') !== c.code);
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
    if (t.conf != null && t.conf < 40) return; // 把握太低的孤立数字多半是水印里的字
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
  // 还有读出了数量、色号那里连字都没找到的（色块太花、字太淡）：照同一张清单里其他“色号→数量”的相对位置，
  // 在该有色号的地方留一个“待填色号”的条目（核对时按色块颜色给建议），不让它悄悄漏掉
  const done = items.filter(it => it.code && it.countBox);
  if (done.length >= 3) {
    const off = f => median(done.map(f));
    const dx = off(it => (it.countBox.x0 + it.countBox.x1) / 2 - (it.codeBox.x0 + it.codeBox.x1) / 2);
    const dy = off(it => (it.countBox.y0 + it.countBox.y1) / 2 - (it.codeBox.y0 + it.codeBox.y1) / 2);
    const cw = off(it => it.codeBox.x1 - it.codeBox.x0), ch = off(it => it.codeBox.y1 - it.codeBox.y0);
    const takenT = new Set(items.map(it => it.countBox && `${it.countBox.x0},${it.countBox.y0}`));
    const th = off(it => it.countBox.y1 - it.countBox.y0);
    counts.forEach((t, j) => {
      if (takenT.has(`${t.x0},${t.y0}`) || (support[j] === 1 && medSupport >= 3) || support[j] < maxSupport * 0.5) return;
      if (t.conf != null && t.conf < 40) return;
      // 只补在“已经配好的数量”那几行里、字一样大的（格子边上的坐标刻度、别处的数字不算）
      const h = t.y1 - t.y0, tcy = (t.y0 + t.y1) / 2;
      if (h < th * 0.7 || h > th * 1.4) return;
      if (!done.some(it => Math.abs((it.countBox.y0 + it.countBox.y1) / 2 - tcy) < th * 0.5)) return;
      const cx = (t.x0 + t.x1) / 2 - dx, cy = (t.y0 + t.y1) / 2 - dy;
      const box = { x0: cx - cw / 2, y0: cy - ch / 2, x1: cx + cw / 2, y1: cy + ch / 2 };
      // 那个位置已经有别的条目（比如色号读出来了、只是没配上这个数）就不补
      if (items.some(it => it.codeBox.x0 < box.x1 && it.codeBox.x1 > box.x0 && it.codeBox.y0 < box.y1 && it.codeBox.y1 > box.y0)) return;
      if (box.x0 < 0 || box.y0 < 0) return;
      items.push({ code: null, rawCode: '?', count: t.n, codeBox: box, countBox: { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 }, uncertain: true, inferred: true });
    });
  }
  const hMed = median(items.map(it => it.codeBox.y1 - it.codeBox.y0)) || 10;
  items.sort((a, b) => {
    const dy = a.codeBox.y0 - b.codeBox.y0;
    return Math.abs(dy) > hMed * 0.8 ? dy : a.codeBox.x0 - b.codeBox.x0;
  });
  return items;
}

/** 2 倍双线性放大（RGBA） */
function upscale2(img) {
  const { data, width: w, height: h } = img, W = w * 2, H = h * 2;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1.001, Math.max(0, (y + 0.5) / 2 - 0.5)), iy = Math.floor(fy), ty = fy - iy;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1.001, Math.max(0, (x + 0.5) / 2 - 0.5)), ix = Math.floor(fx), tx = fx - ix;
      const p = (iy * w + ix) * 4, q = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) out[q + c] = (data[p + c] * (1 - tx) + data[p + 4 + c] * tx) * (1 - ty) + (data[p + w * 4 + c] * (1 - tx) + data[p + w * 4 + 4 + c] * tx) * ty;
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * 读一张清单：分词 → 每个词交给 readWord(ana, word) 识别（返回 { text, conf }）→ 配成“色号 + 数量”。
 * 字很小（< 12 像素）时再放大两倍分一次词、读一遍，哪次读出的“色号 + 数量”多就用哪次（一样多用原图的）：
 * 小字、压缩得厉害的截图，放大后色块和数量框才认得出是底色；字不太小的图放大反而容易把字拆散。
 * upscale=false 不放大再读（Tesseract：它自己会把每个词放大，再放大一次反而多读错）。
 * onWord(i, n)：进度；返回 { ana, pairs }（pairs 的坐标是 ana 里的，ana.scale 是放大倍数）
 */
export async function readLegend(img, readWord, normalizeCode, { onWord, opt = {}, upscale = true } = {}) {
  const run = async scale => {
    const ana = analyze(img, { ...opt, scale });
    const words = [];
    for (let i = 0; i < ana.words.length; i++) {
      onWord?.(i + 1, ana.words.length);
      words.push({ ...ana.words[i], ...(await readWord(ana, ana.words[i])) });
    }
    return { ana, pairs: pairWords(words, normalizeCode) };
  };
  const a = await run(1);
  if (!upscale || (a.ana.words.length && !(a.ana.hc < 12))) return a;
  const b = await run(2);
  // 读出“色号 + 数量”的项数；同一个色号出现两次（肯定有读错的）、只有色号没有数量的（多半是把格子里的色号当成了清单）倒扣。
  // 一样多用原图的。（在 14 张示例图和它们压缩、缩小过的 40 多个版本上定的）
  const score = r => {
    const codes = r.pairs.filter(p => p.code && p.count != null).map(p => p.code);
    return codes.length - 2 * (codes.length - new Set(codes).size) - r.pairs.filter(p => p.code && p.count == null).length;
  };
  return score(b) > score(a) ? b : a;
}

/** 色块的颜色：框里（上下左右多 20%）出现最多的颜色（每通道 4 位量化）；字的笔画细，占不了多数 */
export function swatchColor(img, b) {
  const h = b.y1 - b.y0, m = h * 0.2;
  const x0 = Math.max(0, Math.round(b.x0 - m)), x1 = Math.min(img.width, Math.round(b.x1 + m));
  const y0 = Math.max(0, Math.round(b.y0 - m)), y1 = Math.min(img.height, Math.round(b.y1 + m));
  const bins = new Map();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * img.width + x) * 4, k = (img.data[p] >> 4) << 8 | (img.data[p + 1] >> 4) << 4 | (img.data[p + 2] >> 4);
    let e = bins.get(k);
    if (!e) bins.set(k, e = [0, 0, 0, 0]);
    e[0] += img.data[p]; e[1] += img.data[p + 1]; e[2] += img.data[p + 2]; e[3]++;
  }
  let best = null;
  for (const e of bins.values()) if (!best || e[3] > best[3]) best = e;
  return best ? [best[0] / best[3], best[1] / best[3], best[2] / best[3]] : null;
}

/**
 * 读不清的色号再挑一次（色号读不出来、或者读得没把握的项）：
 * 色号位置上那几个字，按色卡里的每个色号逐个算“像不像”（scoreCodes(box) → Map 色号 → CTC 对数概率），
 * 再加一点“色块颜色和色卡颜色接近”的分（出图软件的颜色和色卡常有偏差，所以只占一小部分），
 * 取最像的、而且这张清单里别的项没用过的。改过的项还是“把握不大”，核对时要看一眼；alts 是另外几个候选。
 * 门槛（CTC 分 ≥ −10；色差 > 20 时要读得很清楚，分 ≥ −3）在 14 张示例图和 44 个压缩、缩小版本上调的：
 * 宁可留“待填色号”，也不要多填错的。
 * pairs 的坐标是 ana 里的（ana.scale 倍），img 是原图。
 */
export async function refineCodes(img, ana, pairs, scoreCodes, { rgbOf, deltaE, sigma = 16, onItem } = {}) {
  const s = ana.scale || 1;
  const used = new Set(pairs.filter(p => p.code && !p.uncertain).map(p => p.code));
  const todo = pairs.filter(p => p.count != null && p.codeBox && (!p.code || p.uncertain));
  const ranked = [];
  for (let i = 0; i < todo.length; i++) {
    onItem?.(i + 1, todo.length);
    const p = todo[i], cb = p.codeBox;
    const b = { x0: cb.x0 / s, y0: cb.y0 / s, x1: cb.x1 / s, y1: cb.y1 / s };
    const pad = (b.y1 - b.y0) * 0.35;
    const box = { x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad), x1: Math.min(img.width, b.x1 + pad), y1: Math.min(img.height, b.y1 + pad) };
    const lik = await scoreCodes(box);
    const rgb = rgbOf && deltaE ? swatchColor(img, b) : null;
    const cand = [...lik].filter(([, l]) => Number.isFinite(l)).map(([code, l]) => {
      const pc = rgb && rgbOf(code), d = pc ? deltaE(rgb, pc) : 0;
      return { code, l, d, score: l - (d / sigma) ** 2 / 2 };
    }).sort((a, b) => b.score - a.score)
      // 太不像的不要：那里根本没有色号（标题里的数字、空白），或者颜色差得太远又读得不清楚——宁可留着“待填色号”
      .filter(c => c.l >= -10 && (c.d <= 20 || c.l >= -3));
    if (cand.length) ranked.push({ p, cand, margin: cand.length > 1 ? cand[0].score - cand[1].score : 99 });
  }
  // 最有把握的先定，后面的避开已经用过的色号
  ranked.sort((a, b) => b.margin - a.margin);
  for (const { p, cand } of ranked) {
    const pick = cand.find(c => !used.has(c.code));
    if (!pick) continue;
    used.add(pick.code);
    if (p.code !== pick.code) { p.code = pick.code; p.rawCode = p.rawCode || pick.code; }
    p.uncertain = true;
    p.alts = cand.filter(c => c.code !== pick.code).slice(0, 3).map(c => c.code);
  }
  return pairs;
}

/**
 * 两遍读的结果合在一起（标准模型读的 a，高精度模型再读、逐个色号挑过的 b）。坐标都换成原图的（返回的 pairs 是原图坐标）。
 * 以 b 为主；a 里有、b 里没有的项（按数量的位置对）补回来——高精度模型偶尔会把一项读丢，宁可留着让人核对；
 * 同一项 a 有把握、b 是挑出来的（没把握），色号用 a 的；b 读出、a 没能确认的色号都标“把握不大”。
 */
export function mergeReads(a, b) {
  const norm = r => r.pairs.map(p => {
    const s = r.ana.scale || 1, m = x => x && { x0: x.x0 / s, y0: x.y0 / s, x1: x.x1 / s, y1: x.y1 / s };
    return { ...p, codeBox: m(p.codeBox), countBox: m(p.countBox) };
  });
  const A = norm(a), B = norm(b);
  const center = x => [(x.x0 + x.x1) / 2, (x.y0 + x.y1) / 2];
  const inside = (x, box) => { const [cx, cy] = center(x); const m = (box.y1 - box.y0) * 0.3; return cx > box.x0 - m && cx < box.x1 + m && cy > box.y0 - m && cy < box.y1 + m; };
  const used = new Set(B.filter(p => p.code).map(p => p.code));
  for (const p of A) {
    if (p.count == null || !p.countBox) continue;
    const q = B.find(x => x.countBox && (inside(x.countBox, p.countBox) || inside(p.countBox, x.countBox)));
    if (!q) {
      if (p.code && used.has(p.code)) B.push({ ...p, code: null, uncertain: true });
      else { B.push({ ...p, confirmed: !p.uncertain }); if (p.code) used.add(p.code); }
      continue;
    }
    q.confirmed = !!(p.code && !p.uncertain && p.code === q.code);
    if (p.code && !p.uncertain && (!q.code || q.uncertain) && p.code !== q.code && !used.has(p.code)) {
      if (q.code) used.delete(q.code);
      q.code = p.code; q.rawCode = p.rawCode; q.uncertain = false; q.confirmed = true; delete q.alts;
      used.add(p.code);
    }
  }
  // 高精度这遍读出来、标准模型那遍没能确认的色号：都标“把握不大”，核对时看一眼
  for (const q of B) { if (q.code && !q.confirmed) q.uncertain = true; delete q.confirmed; }
  return B;
}
