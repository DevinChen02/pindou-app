// 把图纸截图“数字化”成拼豆板：找网格 → 每格取色 → 按清单里的颜色归类。
// 纯函数，浏览器和 Node（测试）都能用。img = { data: RGBA, width, height }
import { rgbToLab, rgbOf, isCode } from './palette.js';

const dLab = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

export function _acorr(P, minLag, maxLag) {
  const n = P.length; let mu = 0; for (const v of P) mu += v; mu /= n;
  const R = new Float64Array(maxLag + 2);
  for (let l = minLag; l <= maxLag + 1; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += (P[i] - mu) * (P[i + l] - mu); R[l] = s / (n - l); }
  return R;
}
export { findPitch as _findPitch, profile as _profile, gridLines as _gridLines };

/**
 * 找主周期（格子边长，像素）：候选周期 p 的得分 = 自相关在 p、2p、3p… 处的平均值。
 * 真周期在所有倍数处都有峰；半周期在奇数倍处落空；2p、5p 等倍周期得分接近，取最小的那个。
 */
function findPitch(P, minLag, maxLag) {
  const n = P.length;
  const top = Math.min(Math.floor(n / 2.5), maxLag * 8);
  if (top < minLag * 3) return null;
  const R = _acorr(P, 1, top);
  const Ri = x => { const i = Math.floor(x), f = x - i; return i + 1 <= top ? R[i] * (1 - f) + R[i + 1] * f : 0; };
  const Rpk = x => Math.max(Ri(x - 0.5), Ri(x), Ri(x + 0.5)); // 峰很尖，允许半像素误差
  const cands = [];
  for (let p = minLag; p <= maxLag; p += 0.05) {
    const M = Math.min(10, Math.floor(top / p));
    if (M < 3) break;
    let s = 0; for (let m = 1; m <= M; m++) s += Rpk(m * p);
    cands.push([p, s / M]);
  }
  if (!cands.length) return null;
  const best = Math.max(...cands.map(c => c[1]));
  if (!(best > 0)) return null;
  // 最小的“够好”的周期，再在它附近取局部最高分
  const i0 = cands.findIndex(c => c[1] >= best * 0.85);
  let bi = i0;
  for (let i = i0; i < cands.length && cands[i][0] < cands[i0][0] + 1.5; i++) if (cands[i][1] > cands[bi][1]) bi = i;
  return cands[bi][0];
}

/**
 * 线条剖面：每个位置上，沿另一个方向有多少像素“比两边都暗、或比两边都亮”（细线的特征）。
 * 只数个数、不看反差大小：浅浅的格线和黑色的字一样算，而且格线横贯整行，字只占一小段，
 * 所以格线处的数值远高于字所在的行。
 */
function profile(L, W, H, axis, a0, a1, b0, b1) {
  const len = axis === 'x' ? W : H;
  const P = new Float64Array(len);
  const d = 3, t = 2.5;
  if (axis === 'x') {
    for (let y = b0; y < b1; y++) {
      const row = y * W;
      for (let x = Math.max(d, a0); x < Math.min(W - d, a1); x++) {
        const c = L[row + x], u = L[row + x - d], v = L[row + x + d];
        if ((c < u - t && c < v - t) || (c > u + t && c > v + t)) P[x]++;
      }
    }
  } else {
    for (let y = Math.max(d, b0); y < Math.min(H - d, b1); y++) {
      const row = y * W;
      for (let x = a0; x < a1; x++) {
        const c = L[row + x], u = L[row + x - d * W], v = L[row + x + d * W];
        if ((c < u - t && c < v - t) || (c > u + t && c > v + t)) P[y]++;
      }
    }
  }
  return P;
}

/**
 * 在剖面上找网格线：先估周期 p，再用“梳子”对齐相位（整段一起对齐，不怕局部被字挡住），
 * 在每个梳齿附近找实际的峰，最后用找到的线做稳健直线拟合（截图等比缩放，格线应严格等距）。
 * 网格范围 = 连续有线的最长一段。返回 { pitch, lines:[位置...] }
 */
function gridLines(P, lo, hi, forcePitch = null) {
  const seg = P.slice(lo, hi);
  let p = forcePitch || findPitch(seg, 9, Math.min(160, Math.floor(seg.length / 4)));
  if (!p) return null;
  const S = new Float64Array(P.length);
  for (let i = 1; i < P.length - 1; i++) S[i] = Math.max(P[i], (P[i - 1] + P[i] + P[i + 1]) / 2);
  const peakNear = (x, r) => {
    let bx = -1, bv = -1;
    for (let q = Math.round(x - r); q <= Math.round(x + r); q++) if (q > lo && q < hi - 1 && S[q] > bv) { bv = S[q]; bx = q; }
    return [bx, bv];
  };
  let a = lo;
  let lines = [];
  for (let round = 0; round < 3; round++) {
    // 相位：梳子对齐（第一轮全范围搜，之后在拟合结果附近微调）
    let bestPh = 0, bestSc = -1;
    for (let ph = 0; ph < p; ph += 0.25) {
      let sc = 0;
      for (let x = lo + ph; x < hi; x += p) sc += S[Math.round(x)];
      if (sc > bestSc) { bestSc = sc; bestPh = ph; }
    }
    a = round === 0 ? lo + bestPh : a;
    // 每个梳齿附近找峰
    const k0 = Math.ceil((lo - a) / p), k1 = Math.floor((hi - 1 - a) / p);
    const cand = [];
    for (let k = k0; k <= k1; k++) {
      const pred = a + k * p;
      const [bx, bv] = peakNear(pred, Math.max(2, p * 0.15));
      cand.push({ k, pred, x: bx, v: bv });
    }
    const vs = cand.map(c => c.v).sort((x, y) => x - y);
    const typical = vs[Math.floor(vs.length * 0.75)] || 1;
    for (const c of cand) c.real = c.v >= typical * 0.3;
    // 稳健直线拟合
    let pts = cand.filter(c => c.real);
    for (let it = 0; it < 4 && pts.length >= 3; it++) {
      let sk = 0, sx = 0, skk = 0, skx = 0;
      for (const c of pts) { sk += c.k; sx += c.x; skk += c.k * c.k; skx += c.k * c.x; }
      const n = pts.length;
      const fb = (n * skx - sk * sx) / (n * skk - sk * sk || 1);
      if (Math.abs(fb - p) < p * 0.08) { p = fb; a = (sx - fb * sk) / n; }
      const tol = it < 2 ? Math.max(3, p * 0.2) : Math.max(1.6, p * 0.1);
      pts = pts.filter(c => Math.abs(c.x - (a + p * c.k)) <= tol);
    }
    lines = cand.map(c => {
      const f = a + p * c.k;
      return { x: c.real && Math.abs(c.x - f) <= Math.max(1.2, p * 0.07) ? c.x : Math.round(f), real: c.real };
    });
  }
  // 网格范围：“有线”的最长连续段（中间偶尔缺 1~2 条允许）
  let best = [0, -1], start = -1, gap = 0;
  lines.forEach((c, i) => {
    if (c.real) {
      if (start < 0) start = i;
      gap = 0;
      if (i - start > best[1] - best[0]) best = [start, i];
    } else if (start >= 0 && ++gap > 2) { start = -1; gap = 0; }
  });
  const run = lines.slice(best[0], best[1] + 1);
  if (run.length < 4) return null;
  return { pitch: p, lines: run.map(c => c.x) };
}

/**
 * 一条线的“覆盖率”：按格子分段，每段里大部分位置都是一条细线（比两边都暗或都亮）才算这段有线。
 * 真正的格线一格一格连续穿过，覆盖率高；坐标数字、色块边界、黑边只是零碎地挨上，覆盖率低。
 */
function lineCov(L, W, axis, pos, cross) {
  const d = 3;
  let ok = 0, segs = 0;
  const px = (q, t) => (axis === 'y' ? L[q * W + t] : L[t * W + q]);
  for (let s = 0; s + 1 < cross.length; s++) {
    const a0 = cross[s] + 2, a1 = cross[s + 1] - 2;
    if (a1 <= a0) continue;
    segs++;
    let best = 0;
    for (let q = pos - 1; q <= pos + 1; q++) {
      let hit = 0;
      for (let t = a0; t < a1; t++) {
        const c = px(q, t), u = px(q - d, t), v = px(q + d, t);
        if ((c < u - 2.5 && c < v - 2.5) || (c > u + 2.5 && c > v + 2.5)) hit++;
      }
      if (hit > best) best = hit;
    }
    if (best >= (a1 - a0) * 0.55) ok++;
  }
  return segs ? ok / segs : 0;
}

/**
 * 一格的底色和“有没有字”。底色取各通道的中位数（字只占格子的一小部分，中位数不受它影响；
 * 比取众数稳，JPEG 的色度噪声会把红底打散到很多色桶里），再在它附近取平均。
 */
const HR = new Uint32Array(256), HG = new Uint32Array(256), HB = new Uint32Array(256);
function cellStats(img, x0, y0, x1, y1) {
  const { data, width } = img;
  HR.fill(0); HG.fill(0); HB.fill(0);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      HR[data[i]]++; HG[data[i + 1]]++; HB[data[i + 2]]++; n++;
    }
  }
  if (!n) return null;
  const med = H => { let c = 0; for (let v = 0; v < 256; v++) { c += H[v]; if (c * 2 >= n) return v; } return 255; };
  const c = [med(HR), med(HG), med(HB)];
  let sr = 0, sg = 0, sb = 0, sn = 0, ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const dr = data[i] - c[0], dg = data[i + 1] - c[1], db = data[i + 2] - c[2];
      const dd = dr * dr + dg * dg + db * db;
      if (dd < 900) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; sn++; }
      else if (dd > 4900) ink++;
    }
  }
  const rgb = sn ? [sr / sn, sg / sn, sb / sn] : c;
  return { rgb, ink: ink / n };
}

/** 按格线位置逐格取色 */
export function sampleCells(img, xs, ys) {
  const out = [];
  for (let r = 0; r + 1 < ys.length; r++) {
    for (let c = 0; c + 1 < xs.length; c++) {
      const w = xs[c + 1] - xs[c], h = ys[r + 1] - ys[r];
      const mx = Math.max(1, Math.round(w * 0.2)), my = Math.max(1, Math.round(h * 0.2));
      out.push(cellStats(img, Math.round(xs[c] + mx), Math.round(ys[r] + my), Math.round(xs[c + 1] - mx + 1), Math.round(ys[r + 1] - my + 1)));
    }
  }
  return out;
}

/** 手动校准：用户点了网格左上角、右下角，并告诉我们几列几行 */
export function gridFromCorners(img, { x0, y0, x1, y1, cols, rows, refs }) {
  const xs = Array.from({ length: cols + 1 }, (_, i) => x0 + (x1 - x0) * i / cols);
  const ys = Array.from({ length: rows + 1 }, (_, i) => y0 + (y1 - y0) * i / rows);
  const res = classify(sampleCells(img, xs, ys), refs);
  return { rows, cols, ...res, geom: { xs: xs.map(Math.round), ys: ys.map(Math.round), pitch: (x1 - x0) / cols, manual: true } };
}

/**
 * 数字化。
 * opts.region: { x, y, w, h } 只在这里面找网格（清单以上的部分）
 * opts.refs:   [{ code, rgb?, count }] 清单里的颜色（rgb 为清单色块的实际取色，没有就用色卡标准色）
 * 返回 { rows, cols, codes, cells(Uint8Array，0=空，i+1=codes[i]), counts, stats, geom }
 */
export function digitize(img, { region, refs }) {
  const W = img.width, H = img.height, d = img.data;
  const R = region || { x: 0, y: 0, w: W, h: H };
  const rx0 = Math.max(0, Math.round(R.x)), ry0 = Math.max(0, Math.round(R.y));
  const rx1 = Math.min(W, Math.round(R.x + R.w)), ry1 = Math.min(H, Math.round(R.y + R.h));
  const L = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) L[i] = lum(d, p);

  // 两轮：先用整个区域估横线，再只在网格范围内估竖线，再回头细化横线
  let Py = profile(L, W, H, 'y', rx0, rx1, ry0, ry1);
  let gy = gridLines(Py, ry0, ry1);
  if (!gy) return { error: '没找到网格横线' };
  let Px = profile(L, W, H, 'x', rx0, rx1, gy.lines[0], gy.lines[gy.lines.length - 1]);
  let gx = gridLines(Px, rx0, rx1);
  if (!gx) return { error: '没找到网格竖线' };
  // 格子是正方形：横竖周期应该一样。差 2 倍多半是一边读成了半格（字的行、棋盘格底纹），取大的；
  // 差 3 倍以上多半是一边只看到了每 5/10 格一条的粗线，取小的
  const ratio = Math.max(gx.pitch, gy.pitch) / Math.min(gx.pitch, gy.pitch);
  if (ratio > 1.2) {
    const n = Math.round(ratio);
    if (Math.abs(ratio - n) > 0.15 * n) return { error: '横竖格子大小对不上' };
    const p = n === 2 ? Math.max(gx.pitch, gy.pitch) : Math.min(gx.pitch, gy.pitch);
    gy = gridLines(Py, ry0, ry1, p);
    if (!gy) return { error: '没找到网格横线' };
    Px = profile(L, W, H, 'x', rx0, rx1, gy.lines[0], gy.lines[gy.lines.length - 1]);
    gx = gridLines(Px, rx0, rx1, p);
    if (!gx) return { error: '没找到网格竖线' };
  }
  gy = gridLines(profile(L, W, H, 'y', gx.lines[0], gx.lines[gx.lines.length - 1], ry0, ry1), ry0, ry1, (gx.pitch + gy.pitch) / 2) || gy;

  let xs = gx.lines, ys = gy.lines;
  // 两头间距不对的（比如网格下面隔了一行坐标数字的分隔线）先去掉
  const pitchNow = (gx.pitch + gy.pitch) / 2;
  const trimSteps = a => {
    while (a.length > 4 && Math.abs(a[1] - a[0] - pitchNow) > pitchNow * 0.12) a = a.slice(1);
    while (a.length > 4 && Math.abs(a[a.length - 1] - a[a.length - 2] - pitchNow) > pitchNow * 0.12) a = a.slice(0, -1);
    return a;
  };
  const dbg = { rawX: xs.length, rawY: ys.length, stepsYend: ys.slice(-4).map((v, i, a) => i ? v - a[i - 1] : v), stepsYstart: ys.slice(0, 4) };
  xs = trimSteps(xs); ys = trimSteps(ys);
  dbg.afterStepX = xs.length; dbg.afterStepY = ys.length;
  dbg.covY = [ys.slice(0, 3).map(y => lineCov(L, W, 'y', y, xs).toFixed(2)), ys.slice(-3).map(y => lineCov(L, W, 'y', y, xs).toFixed(2))];
  dbg.covX = [xs.slice(0, 3).map(x => lineCov(L, W, 'x', x, ys).toFixed(2)), xs.slice(-3).map(x => lineCov(L, W, 'x', x, ys).toFixed(2))];
  // 两头的线：必须横贯整个网格（真正的格线），字的边缘、黑边、坐标数字那一行都不算
  for (let pass = 0; pass < 2; pass++) {
    while (ys.length > 4 && lineCov(L, W, 'y', ys[0], xs) < 0.5) ys = ys.slice(1);
    while (ys.length > 4 && lineCov(L, W, 'y', ys[ys.length - 1], xs) < 0.5) ys = ys.slice(0, -1);
    while (xs.length > 4 && lineCov(L, W, 'x', xs[0], ys) < 0.5) xs = xs.slice(1);
    while (xs.length > 4 && lineCov(L, W, 'x', xs[xs.length - 1], ys) < 0.5) xs = xs.slice(0, -1);
  }
  const cellsOf = (xs, ys) => sampleCells(img, xs, ys);
  let rows = ys.length - 1, cols = xs.length - 1;
  let stats = cellsOf(xs, ys);
  const at = (r, c) => stats[r * cols + c];

  // 去掉写着行号/列号的表头行列：整行颜色一致、而且几乎每格都有字
  const headerLike = list => {
    const inks = list.filter(s => s && s.ink > 0.04).map(s => s.ink);
    if (inks.length < list.length * 0.7) return false;
    // 表头写的是 1、2、…、10、11 这样各不相同的数字，字的多少差别大；
    // 一整排同一个色号（比如整行 H2）每格的字一模一样，不算表头
    const mu = inks.reduce((a, b) => a + b, 0) / inks.length;
    const sd = Math.sqrt(inks.reduce((a, b) => a + (b - mu) ** 2, 0) / inks.length);
    if (sd / mu < 0.18) return false;
    const labs = list.filter(Boolean).map(s => rgbToLab(s.rgb));
    const med = labs.map(l => l).sort((a, b) => a[0] - b[0])[labs.length >> 1];
    const same = labs.filter(l => dLab(l, med) < 8).length;
    return same >= labs.length * 0.9;
  };
  let trimmed = true, guard = 0;
  while (trimmed && guard++ < 6 && rows > 3 && cols > 3) {
    trimmed = false;
    const rowList = r => Array.from({ length: cols }, (_, c) => at(r, c));
    const colList = c => Array.from({ length: rows }, (_, r) => at(r, c));
    if (headerLike(rowList(0))) { ys = ys.slice(1); trimmed = true; }
    else if (headerLike(rowList(rows - 1))) { ys = ys.slice(0, -1); trimmed = true; }
    else if (headerLike(colList(0))) { xs = xs.slice(1); trimmed = true; }
    else if (headerLike(colList(cols - 1))) { xs = xs.slice(0, -1); trimmed = true; }
    if (trimmed) { rows = ys.length - 1; cols = xs.length - 1; stats = cellsOf(xs, ys); }
  }

  const res = classify(stats, refs);
  return { rows, cols, ...res, geom: { xs, ys, pitch: (gx.pitch + gy.pitch) / 2, dbg } };
}

/** 按颜色归类（带“清单颗数”约束） */
export function classify(stats, refs) {
  const codes = refs.map(r => r.code);
  const K = codes.length;
  const N = stats.length;
  const lab = stats.map(s => (s ? rgbToLab(s.rgb) : [100, 0, 0]));
  const ink = stats.map(s => (s ? s.ink : 0));
  // 参考色：色卡标准色（实测比清单色块取色稳：清单色块常被画成半透明或带字），后面还会按格子实际颜色修正
  let refLab = refs.map(r => rgbToLab(isCode(r.code) ? rgbOf(r.code) : r.rgb || [128, 128, 128]));
  const target = refs.map(r => r.count || 0);
  const total = target.reduce((a, b) => a + b, 0);

  // 图纸格子里有没有印色号：有的话“有字 = 有豆子”是很强的线索
  const inkCells = ink.filter(v => v > 0.04).length;
  const printed = inkCells > Math.min(N * 0.25, total * 0.5);
  const TEXT = printed ? 14 : 0;

  // 空格颜色：没字的格子里最常见的颜色（没印色号时：离所有清单颜色都远的格子里最常见的）
  const pool = [];
  for (let i = 0; i < N; i++) {
    if (printed ? ink[i] <= 0.02 : Math.min(...refLab.map(r => dLab(lab[i], r))) > 12) pool.push(lab[i]);
  }
  let emptyLab = [98, 0, 0];
  if (pool.length) {
    const bins = new Map();
    for (const l of pool) {
      const k = `${Math.round(l[0] / 4)},${Math.round(l[1] / 4)},${Math.round(l[2] / 4)}`;
      const b = bins.get(k) || { n: 0, s: [0, 0, 0] };
      b.n++; b.s[0] += l[0]; b.s[1] += l[1]; b.s[2] += l[2];
      bins.set(k, b);
    }
    let best = null; for (const b of bins.values()) if (!best || b.n > best.n) best = b;
    emptyLab = best.s.map(v => v / best.n);
  }

  const bias = new Float64Array(K);
  const assign = new Int16Array(N);
  const costs = new Float32Array(N * (K + 1));
  const fillCosts = () => {
    for (let i = 0; i < N; i++) {
      const hasInk = ink[i] > 0.04;
      costs[i * (K + 1)] = dLab(lab[i], emptyLab) + (hasInk ? TEXT : 0);
      for (let k = 0; k < K; k++) costs[i * (K + 1) + k + 1] = dLab(lab[i], refLab[k]) + (hasInk ? 0 : TEXT);
    }
  };
  const run = () => {
    const cnt = new Int32Array(K);
    for (let i = 0; i < N; i++) {
      let bk = 0, bv = costs[i * (K + 1)];
      for (let k = 0; k < K; k++) {
        const v = costs[i * (K + 1) + k + 1] + bias[k];
        if (v < bv) { bv = v; bk = k + 1; }
      }
      assign[i] = bk;
      if (bk) cnt[bk - 1]++;
    }
    return cnt;
  };
  // “带颗数约束的归类”：哪类比清单多了就给它加一点代价，少了就减一点（拉格朗日乘子），
  // 再用归到每类的格子的实际颜色修正参考色，反复几轮（相当于带约束的 k-means）
  const constrained = (iters) => {
    let cnt = run();
    if (!(total > 0)) return cnt;
    let bestErr = Infinity, stall = 0, bestBias = Float64Array.from(bias);
    for (let it = 0; it < iters; it++) {
      let err = 0;
      for (let k = 0; k < K; k++) err += Math.abs(cnt[k] - target[k]);
      if (err < bestErr) { bestErr = err; stall = 0; bestBias = Float64Array.from(bias); } else if (++stall > 80) break;
      if (!err) break;
      const step = 0.4 * (it < 100 ? 1 : it < 250 ? 0.5 : 0.25);
      for (let k = 0; k < K; k++) {
        const e = cnt[k] - target[k];
        if (e) bias[k] = Math.max(-30, Math.min(30, bias[k] + Math.sign(e) * Math.min(1, Math.abs(e) / Math.max(4, target[k] * 0.05)) * step));
      }
      cnt = run();
    }
    // 回到误差最小的那一组
    bias.set(bestBias);
    return run();
  };
  fillCosts();
  let cnt;
  for (let round = 0; round < 4; round++) {
    cnt = constrained(400);
    if (round === 3) break;
    // 用每类格子的颜色中位数更新参考色（格子里的真实颜色比清单色块/色卡更准）
    const groups = refLab.map(() => []);
    for (let i = 0; i < N; i++) if (assign[i]) groups[assign[i] - 1].push(lab[i]);
    refLab = refLab.map((r, k) => {
      const g = groups[k];
      if (g.length < 3) return r;
      const med = j => g.map(l => l[j]).sort((a, b) => a - b)[g.length >> 1];
      return [med(0), med(1), med(2)];
    });
    fillCosts();
  }
  const counts = Object.fromEntries(codes.map((c, k) => [c, cnt[k]]));
  const diff = codes.map((c, k) => ({ code: c, want: target[k], got: cnt[k] })).filter(x => x.want !== x.got);
  return {
    codes, cells: Uint8Array.from(assign), counts,
    stats: { printed, exact: codes.length - diff.length, total: codes.length, diff, beads: cnt.reduce((a, b) => a + b, 0), want: total },
  };
}

// ---------- 存取：cells 压成字符串存进数据库 ----------
export function packCells(cells) {
  let s = '';
  for (const v of cells) s += String.fromCharCode(48 + v); // '0' 起，最多 200 多种颜色也够
  return s;
}
export function unpackCells(str) {
  const a = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) - 48;
  return a;
}
