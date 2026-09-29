// 多张截图拼成一张大图：找出每两张之间重叠的位置（只有平移——同一张图纸的截图大小一样；
// 大小不一样时先按格子的间距缩放到一样），再把重叠的部分去掉拼起来。
// 纯计算（不碰 DOM），在 Worker 里跑；图片都是 { data: RGBA, width, height }。
//
// 找重叠：先在缩小的灰度图上用“带遮罩的归一化互相关”（FFT，一次算出所有平移量的相似度），
// 再在放大的图上小范围细调到逐像素对齐。拼豆图纸的格子是周期的，缩小到看不出格线后比的是图案本身，
// 不会错开整格；细调时搜索范围小于一格。

import { gridPitchOf } from './board.js';

// ---------- FFT（基 2，原地） ----------
function fft1(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
/** 二维 FFT（W、H 是 2 的幂；数据按行存） */
function fft2(re, im, W, H, inv) {
  const rr = new Float64Array(W), ri = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) { rr[x] = re[o + x]; ri[x] = im[o + x]; }
    fft1(rr, ri, inv);
    for (let x = 0; x < W; x++) { re[o + x] = rr[x]; im[o + x] = ri[x]; }
  }
  const cr = new Float64Array(H), ci = new Float64Array(H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x]; }
    fft1(cr, ci, inv);
    for (let y = 0; y < H; y++) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y]; }
  }
}
const pow2 = n => { let p = 1; while (p < n) p <<= 1; return p; };

// ---------- 灰度、缩小 ----------
const lum = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

/** 按 k 缩小成灰度（区域平均） */
export function grayAt(img, k) {
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const g = new Float32Array(w * h), n = new Float32Array(w * h);
  const d = img.data, W = img.width, H = img.height;
  const sx = w / W, sy = h / H;
  for (let y = 0; y < H; y++) {
    const oy = Math.min(h - 1, Math.floor(y * sy)) * w;
    for (let x = 0; x < W; x++) {
      const o = oy + Math.min(w - 1, Math.floor(x * sx));
      g[o] += lum(d, (y * W + x) * 4); n[o]++;
    }
  }
  for (let i = 0; i < g.length; i++) g[i] /= n[i] || 1;
  return { g, w, h, k: w / W };
}

// ---------- 粗对齐：带遮罩的归一化互相关（Padfield 2012） ----------
/** 一张灰度图放进 W×H 的画布（其余是 0），算 A、A²、遮罩的频谱 */
function spectra(G, W, H) {
  const N = W * H;
  const a = [new Float64Array(N), new Float64Array(N)], a2 = [new Float64Array(N), new Float64Array(N)], m = [new Float64Array(N), new Float64Array(N)];
  for (let y = 0; y < G.h; y++) for (let x = 0; x < G.w; x++) {
    const v = G.g[y * G.w + x], i = y * W + x;
    a[0][i] = v; a2[0][i] = v * v; m[0][i] = 1;
  }
  for (const s of [a, a2, m]) fft2(s[0], s[1], W, H, false);
  return { a, a2, m };
}
/** corr(u) = Σx P(x+u)·Q(x)：IFFT(FP · conj(FQ)) */
function corr(P, Q, W, H) {
  const N = W * H, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    re[i] = P[0][i] * Q[0][i] + P[1][i] * Q[1][i];
    im[i] = P[1][i] * Q[0][i] - P[0][i] * Q[1][i];
  }
  fft2(re, im, W, H, true);
  return re;
}

/**
 * 两张缩小的灰度图 A、B：B 放在 A 的哪里（B 左上角 = A 左上角 + (dx, dy)）最像。
 * 只考虑重叠面积够大（≥ minFrac × 小的那张，至少 minSide×minSide）的位置。返回前几个候选 [{ dx, dy, ncc, n }]
 */
export function coarseMatches(A, B, { minFrac = 0.02, minSide = 4, top = 4, SA = null, SB = null, W = 0, H = 0 } = {}) {
  W = W || pow2(A.w + B.w); H = H || pow2(A.h + B.h);
  SA = SA || spectra(A, W, H); SB = SB || spectra(B, W, H);
  const Nov = corr(SA.m, SB.m, W, H), sA = corr(SA.a, SB.m, W, H), sB = corr(SA.m, SB.a, W, H);
  const sAA = corr(SA.a2, SB.m, W, H), sBB = corr(SA.m, SB.a2, W, H), sAB = corr(SA.a, SB.a, W, H);
  const minN = Math.max(minSide * minSide, minFrac * Math.min(A.w * A.h, B.w * B.h));
  const out = [];
  for (let v = 0; v < H; v++) {
    const dy = v < H / 2 ? v : v - H;
    if (dy <= -B.h + minSide || dy >= A.h - minSide) continue;
    for (let u = 0; u < W; u++) {
      const dx = u < W / 2 ? u : u - W;
      if (dx <= -B.w + minSide || dx >= A.w - minSide) continue;
      const i = v * W + u, n = Nov[i];
      if (n < minN) continue;
      const va = sAA[i] - sA[i] * sA[i] / n, vb = sBB[i] - sB[i] * sB[i] / n;
      if (va <= n * 9 || vb <= n * 9) continue; // 重叠处几乎是纯色（标准差 < 3）：比不出来
      const ncc = (sAB[i] - sA[i] * sB[i] / n) / Math.sqrt(va * vb);
      out.push({ dx, dy, ncc, n });
    }
  }
  out.sort((p, q) => q.ncc - p.ncc);
  // 去掉挨在一起的（同一个峰）
  const picked = [];
  for (const c of out) {
    if (picked.length >= top) break;
    if (picked.some(p => Math.abs(p.dx - c.dx) <= 2 && Math.abs(p.dy - c.dy) <= 2)) continue;
    picked.push(c);
  }
  return picked;
}

// ---------- 细调：在放大的图上小范围找最像的位置 ----------
/** A、B 的灰度（同一缩放比例）在偏移 (dx, dy) 下重叠部分的相关系数；sample：最多取多少个点 */
function nccAt(A, B, dx, dy, sample = 40000) {
  const x0 = Math.max(0, -dx), y0 = Math.max(0, -dy);
  const x1 = Math.min(B.w, A.w - dx), y1 = Math.min(B.h, A.h - dy);
  if (x1 - x0 < 4 || y1 - y0 < 4) return { ncc: -1, n: 0 };
  const area = (x1 - x0) * (y1 - y0);
  let st = Math.max(1, Math.floor(Math.sqrt(area / sample)));
  if (st > 1 && st % 2 === 0) st++; // 奇数步长，不和格子的周期对上
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y += st) {
    const ra = (y + dy) * A.w + dx, rb = y * B.w;
    for (let x = x0; x < x1; x += st) {
      // 原大小那一层不存灰度图（太占内存），直接从 RGBA 算亮度
      const a = A.g ? A.g[ra + x] : lum(A.d, (ra + x) * 4), b = B.g ? B.g[rb + x] : lum(B.d, (rb + x) * 4);
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va <= n * 4 || vb <= n * 4) return { ncc: -1, n };
  return { ncc: (sab - sa * sb / n) / Math.sqrt(va * vb), n };
}
function refineAt(A, B, dx, dy, r) {
  let best = { dx, dy, ...nccAt(A, B, dx, dy) };
  for (let yy = dy - r; yy <= dy + r; yy++) for (let xx = dx - r; xx <= dx + r; xx++) {
    if (xx === dx && yy === dy) continue;
    const c = nccAt(A, B, xx, yy);
    if (c.ncc > best.ncc) best = { dx: xx, dy: yy, ...c };
  }
  return best;
}

/**
 * 找一对图（已经缩放到同样比例的 RGBA）的重叠位置。levels：各层的灰度（按缩放比例从小到大，最后一层是原大小）。
 * 返回 { dx, dy, ncc, frac }（原大小的像素；frac = 重叠面积占小的那张的比例）或 null
 */
export function alignPair(LA, LB, opts = {}) {
  const A0 = LA[0], B0 = LB[0];
  const cands = coarseMatches(A0, B0, opts);
  let best = null;
  for (const c of cands.slice(0, 3)) {
    let dx = c.dx, dy = c.dy, k = A0.k, r = null;
    for (let l = 1; l < LA.length; l++) {
      const A = LA[l], B = LB[l], f = A.k / k;
      dx = Math.round(dx * f); dy = Math.round(dy * f);
      r = refineAt(A, B, dx, dy, Math.ceil(f) + 1);
      dx = r.dx; dy = r.dy; k = A.k;
    }
    const full = LA[LA.length - 1], fb = LB[LB.length - 1];
    r = r || { dx, dy, ...nccAt(full, fb, dx, dy) };
    const ov = Math.max(0, Math.min(full.w, dx + fb.w) - Math.max(0, dx)) * Math.max(0, Math.min(full.h, dy + fb.h) - Math.max(0, dy));
    const cand = { dx: r.dx, dy: r.dy, ncc: r.ncc, coarse: c.ncc, frac: ov / Math.min(full.w * full.h, fb.w * fb.h) };
    if (!best || cand.ncc > best.ncc) best = cand;
  }
  return best;
}

// ---------- 格子间距（大小不一样的截图先缩放到一样）：用拼豆板识别里同一套找格线的办法（board.js gridPitchOf） ----------

/** 缩放 RGBA（双线性） */
export function scaleRGBA(img, k) {
  const W = Math.max(1, Math.round(img.width * k)), H = Math.max(1, Math.round(img.height * k));
  const out = new Uint8ClampedArray(W * H * 4), d = img.data, w = img.width, h = img.height;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(h - 1.001, Math.max(0, (y + 0.5) / k - 0.5)), y0 = Math.floor(gy), ty = gy - y0, y1 = Math.min(h - 1, y0 + 1);
    for (let x = 0; x < W; x++) {
      const gx = Math.min(w - 1.001, Math.max(0, (x + 0.5) / k - 0.5)), x0 = Math.floor(gx), tx = gx - x0, x1 = Math.min(w - 1, x0 + 1);
      for (let c = 0; c < 4; c++) {
        out[(y * W + x) * 4 + c] = (d[(y0 * w + x0) * 4 + c] * (1 - tx) + d[(y0 * w + x1) * 4 + c] * tx) * (1 - ty) + (d[(y1 * w + x0) * 4 + c] * (1 - tx) + d[(y1 * w + x1) * 4 + c] * tx) * ty;
      }
    }
  }
  return { data: out, width: W, height: H };
}

// ---------- 整体：两两找重叠 → 连成一张 ----------
/**
 * imgs：几张截图（RGBA）。返回
 *   { scales: [每张先缩放的比例], pos: [{ x, y } | null]（按组内坐标）, group: [组号], groups: [[图序号…]],
 *     edges: [{ i, j, dx, dy, ncc, frac }] }
 * 同一组里的图是找到了重叠、对齐好的；不同组之间找不到重叠（要用户手动排）。
 */
export function stitchPlan(imgs, opts = {}) {
  // 1. 大小不一样：按格子间距缩放到一样
  const pitches = imgs.map(gridPitchOf);
  const ok = pitches.filter(p => p > 0).sort((a, b) => a - b);
  const ref = ok.length ? ok[ok.length >> 1] : 0;
  // 只在 0.6–1.7 倍之间缩放：差 2 倍左右多半是那张图只找到了半格（表头的字、清单）而不是真的大小不同
  const scales = pitches.map(p => { const r = ref && p > 0 ? ref / p : 1; return Math.abs(r - 1) > 0.04 && r >= 0.6 && r <= 1.7 ? r : 1; });
  if (scales.every(k => k === 1)) return planAt(imgs, scales, opts);
  // 格子间距也可能估错（某张图只有清单、表头）：缩放和不缩放都试，连起来的多（组少）、更像的那个赢
  const a = planAt(imgs, scales, opts), b = planAt(imgs, scales.map(() => 1), opts);
  const score = q => q.edges.reduce((x, e) => x + e.ncc, 0);
  return b.groups.length < a.groups.length || (b.groups.length === a.groups.length && score(b) > score(a)) ? b : a;
}

function planAt(imgs, scales, { minNcc = 0.8, onProgress } = {}) {
  const n = imgs.length;
  const S = imgs.map((im, i) => (scales[i] === 1 ? im : scaleRGBA(im, scales[i])));
  // 2. 各层灰度：粗（长边约 256）→ 中 → 原大小
  const maxSide = Math.max(...S.map(im => Math.max(im.width, im.height)));
  const k0 = Math.min(1, 256 / maxSide);
  const ks = [k0];
  while (ks[ks.length - 1] < 1) ks.push(Math.min(1, ks[ks.length - 1] * 4));
  const L = S.map(im => ks.map((k, li) => (k === 1 && li > 0 ? { d: im.data, w: im.width, h: im.height, k: 1 } : grayAt(im, k))));
  // 粗层的频谱算一次，所有配对共用
  const W = pow2(2 * Math.max(...L.map(l => l[0].w))), H = pow2(2 * Math.max(...L.map(l => l[0].h)));
  const SP = L.map(l => spectra(l[0], W, H));
  // 3. 两两找重叠
  const edges = [];
  const pairs = n * (n - 1) / 2;
  let done = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const m = alignPair(L[i], L[j], { SA: SP[i], SB: SP[j], W, H });
    if (m && m.ncc >= minNcc) edges.push({ i, j, dx: m.dx, dy: m.dy, ncc: m.ncc, frac: m.frac });
    onProgress?.(++done / pairs);
  }
  // 4. 最大生成树：最像的先连
  edges.sort((a, b) => b.ncc - a.ncc);
  const group = [...Array(n).keys()];
  const find = a => (group[a] === a ? a : (group[a] = find(group[a])));
  const pos = Array(n).fill(null), tree = [];
  for (const e of edges) { const a = find(e.i), b = find(e.j); if (a !== b) { group[b] = a; tree.push(e); } }
  const roots = [...new Set([...Array(n).keys()].map(find))];
  const groups = roots.map(r => [...Array(n).keys()].filter(i => find(i) === r));
  for (const g of groups) {
    pos[g[0]] = { x: 0, y: 0 };
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of tree) {
        if (pos[e.i] && !pos[e.j]) { pos[e.j] = { x: pos[e.i].x + e.dx, y: pos[e.i].y + e.dy }; changed = true; }
        else if (pos[e.j] && !pos[e.i]) { pos[e.i] = { x: pos[e.j].x - e.dx, y: pos[e.j].y - e.dy }; changed = true; }
      }
    }
    // 组内坐标从 0 开始
    const mx = Math.min(...g.map(i => pos[i].x)), my = Math.min(...g.map(i => pos[i].y));
    for (const i of g) pos[i] = { x: pos[i].x - mx, y: pos[i].y - my };
  }
  return { scales, pos, groups, edges: tree, sizes: S.map(im => ({ w: im.width, h: im.height })) };
}

/**
 * 拼成一张：rects = [{ x, y, w, h }]（每张在大图上的位置，已经缩放好的大小）。
 * 重叠的地方用离自己边缘最远的那张（截图边上常有水印、状态栏、切歪的半格，用中间的更干净）。
 * 返回每一行的分段 [{ y0, y1, runs: [{ x0, x1, i }] }]（画的时候每段从第 i 张图对应位置拷过去）
 */
export function ownership(rects, W, H, band = 2) {
  const out = [];
  for (let y = 0; y < H; y += band) {
    const yc = y + band / 2, runs = [];
    let cur = -1, start = 0;
    for (let x = 0; x <= W; x += band) {
      let best = -1, bd = -Infinity;
      if (x < W) {
        const xc = x + band / 2;
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (xc < r.x || xc >= r.x + r.w || yc < r.y || yc >= r.y + r.h) continue;
          const d = Math.min(xc - r.x, r.x + r.w - xc, yc - r.y, r.y + r.h - yc);
          if (d > bd) { bd = d; best = i; }
        }
      }
      if (best !== cur) {
        if (cur >= 0) runs.push({ x0: start, x1: Math.min(W, x), i: cur });
        cur = best; start = x;
      }
    }
    out.push({ y0: y, y1: Math.min(H, y + band), runs });
  }
  return out;
}

/** 手动排：pieces = [{ w, h }]，每行 perRow 张（1 = 上下拼，pieces.length = 左右拼），每行居中。返回 { rects, W, H } */
export function gridLayout(pieces, perRow) {
  const rows = [];
  for (let i = 0; i < pieces.length; i += perRow) rows.push(pieces.slice(i, i + perRow).map((p, k) => ({ ...p, i: i + k })));
  const rowW = rows.map(r => r.reduce((a, p) => a + p.w, 0)), rowH = rows.map(r => Math.max(...r.map(p => p.h)));
  const W = Math.max(...rowW), rects = Array(pieces.length);
  let y = 0;
  rows.forEach((r, ri) => {
    let x = Math.round((W - rowW[ri]) / 2);
    for (const p of r) { rects[p.i] = { x, y, w: p.w, h: p.h }; x += p.w; }
    y += rowH[ri];
  });
  return { rects, W, H: y };
}
