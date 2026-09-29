// 把图纸截图“数字化”成拼豆板：找网格 → 每格取色 → 按清单里的颜色归类。
// 纯函数，浏览器和 Node（测试）都能用。img = { data: RGBA, width, height }
import { rgbToLab } from './palette.js';
import { classifyGrid, boardReview } from './cells.js';
export { classifyGrid };

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

function extendGrid(img, xs, ys, R, headerLike) {
  const stats0 = sampleCells(img, xs, ys);
  const labOf = st => (st ? rgbToLab(st.rgb) : null);
  // 网格里出现过的颜色（量化成小格，≥2 格才算）
  const bins = new Map();
  const key = l => `${Math.round(l[0] / 4)},${Math.round(l[1] / 4)},${Math.round(l[2] / 4)}`;
  for (const st of stats0) { if (!st) continue; const k = key(labOf(st)); bins.set(k, (bins.get(k) || 0) + 1); }
  const seen = l => {
    const b = [Math.round(l[0] / 4), Math.round(l[1] / 4), Math.round(l[2] / 4)];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) if ((bins.get(`${b[0] + i},${b[1] + j},${b[2] + k}`) || 0) >= 2) return true;
    return false;
  };
  // 最多的颜色当“空格色”
  let emptyKey = null, emptyN = 0;
  for (const [k, n] of bins) if (n > emptyN) { emptyN = n; emptyKey = k; }
  const isEmptyColor = l => { const [a, b, c] = emptyKey.split(',').map(Number); return Math.abs(Math.round(l[0] / 4) - a) <= 1 && Math.abs(Math.round(l[1] / 4) - b) <= 1 && Math.abs(Math.round(l[2] / 4) - c) <= 1; };
  const px = (xs[xs.length - 1] - xs[0]) / (xs.length - 1), py = (ys[ys.length - 1] - ys[0]) / (ys.length - 1);
  // 一排候选格子能不能并进来
  const ok = (cells, labelCells) => {
    if (!cells.length || cells.some(c => !c)) return false;
    if (headerLike(cells)) return false;
    const labs = cells.map(labOf);
    if (labs.filter(seen).length < cells.length * 0.85) return false;
    const hasBead = labs.some(l => !isEmptyColor(l));
    // 编号栏在继续：外侧那一格有字，而且和上一排外侧那格颜色一样
    const [lab, prev] = labelCells;
    const labelled = lab && prev && lab.ink > 0.04 && dLab(labOf(lab), labOf(prev)) < 8;
    return hasBead || labelled;
  };
  const cellAt = (x0, y0, x1, y1) => sampleCells(img, [x0, x1], [y0, y1])[0];
  for (let guard = 0; guard < 3; guard++) {
    let changed = false;
    // 下
    const yb = Math.round(ys[ys.length - 1] + py);
    if (yb <= R.ry1 + 2 && yb < img.height) {
      const y0 = ys[ys.length - 1];
      const cells = sampleCells(img, xs, [y0, yb]);
      const lab = xs[0] - px >= 0 ? [cellAt(Math.round(xs[0] - px), y0, xs[0], yb), cellAt(Math.round(xs[0] - px), ys[ys.length - 2], xs[0], y0)] : [];
      if (ok(cells, lab)) { ys = [...ys, yb]; changed = true; }
    }
    // 上
    const yt = Math.round(ys[0] - py);
    if (yt >= R.ry0 - 2 && yt >= 0) {
      const cells = sampleCells(img, xs, [yt, ys[0]]);
      const lab = xs[0] - px >= 0 ? [cellAt(Math.round(xs[0] - px), yt, xs[0], ys[0]), cellAt(Math.round(xs[0] - px), ys[0], xs[0], ys[1])] : [];
      if (ok(cells, lab)) { ys = [yt, ...ys]; changed = true; }
    }
    // 右
    const xr = Math.round(xs[xs.length - 1] + px);
    if (xr <= R.rx1 + 2 && xr < img.width) {
      const x0 = xs[xs.length - 1];
      const cells = sampleCells(img, [x0, xr], ys);
      const lab = ys[0] - py >= 0 ? [cellAt(x0, Math.round(ys[0] - py), xr, ys[0]), cellAt(xs[xs.length - 2], Math.round(ys[0] - py), x0, ys[0])] : [];
      if (ok(cells, lab)) { xs = [...xs, xr]; changed = true; }
    }
    // 左
    const xl = Math.round(xs[0] - px);
    if (xl >= R.rx0 - 2 && xl >= 0) {
      const cells = sampleCells(img, [xl, xs[0]], ys);
      const lab = ys[0] - py >= 0 ? [cellAt(xl, Math.round(ys[0] - py), xs[0], ys[0]), cellAt(xs[0], Math.round(ys[0] - py), xs[1], ys[0])] : [];
      if (ok(cells, lab)) { xs = [xl, ...xs]; changed = true; }
    }
    if (!changed) break;
  }
  return { xs, ys };
}

/** 梳子得分：按周期 q 取最好的相位，齿上的平均值 / 整体平均值（越大越像真周期） */
function combScore(P, lo, hi, q) {
  let mean = 0; for (let i = lo; i < hi; i++) mean += P[i]; mean /= Math.max(1, hi - lo);
  if (!(mean > 0)) return 0;
  let best = 0;
  for (let ph = 0; ph < q; ph += 0.5) {
    let s = 0, n = 0;
    for (let x = lo + ph; x < hi - 1; x += q) { s += Math.max(P[Math.floor(x)], P[Math.ceil(x)]); n++; }
    if (n && s / n > best) best = s / n;
  }
  return best / mean;
}

/** 台阶剖面：每个位置上，沿另一个方向有多少像素是“色块交界”（前两个像素、后两个像素各自平稳，前后差很多） */
function stepProfile(img, axis, lo, hi, c0, c1) {
  const { data: d, width: W, height: H } = img;
  const P = new Float64Array(axis === 'y' ? H : W);
  const dist2 = (i, j) => { const a = d[i] - d[j], b = d[i + 1] - d[j + 1], c = d[i + 2] - d[j + 2]; return a * a + b * b + c * c; };
  const step = axis === 'y' ? W * 4 : 4, cstep = axis === 'y' ? 4 : W * 4;
  for (let a = Math.max(2, lo); a < Math.min(axis === 'y' ? H - 2 : W - 2, hi); a++) {
    let n = 0;
    let i = axis === 'y' ? (a * W + c0) * 4 : (c0 * W + a) * 4;
    for (let b = c0; b < c1; b++, i += cstep) {
      if (dist2(i - step, i + step) > 1600 && dist2(i - 2 * step, i - step) < 144 && dist2(i + step, i + 2 * step) < 144) n++;
    }
    P[a] = n;
  }
  return P;
}
/** 用台阶剖面校正格线相位（周期不变）；差得不多或台阶太少就不动 */
function phaseFix(img, lines, cross, axis, lo, hi) {
  if (lines.length < 4) return lines;
  const p = (lines[lines.length - 1] - lines[0]) / (lines.length - 1);
  const a0 = lines[0] - Math.round(p), a1 = lines[lines.length - 1] + Math.round(p);
  const P = stepProfile(img, axis, a0, a1, cross[0], cross[cross.length - 1]);
  let best = -1, bph = 0;
  for (let ph = 0; ph < p; ph += 0.25) {
    let sc = 0;
    for (let x = a0 + ph; x < a1; x += p) sc += Math.max(P[Math.floor(x)] || 0, P[Math.ceil(x)] || 0);
    if (sc > best) { best = sc; bph = ph; }
  }
  const teeth = (a1 - a0) / p;
  if (best / teeth < 8) return lines;
  const cur = (((lines[0] - a0) % p) + p) % p;
  let dph = bph - cur;
  if (dph > p / 2) dph -= p; else if (dph < -p / 2) dph += p;
  if (Math.abs(dph) <= Math.max(2.5, p / 5)) return lines;
  // 整体平移；平移后超出范围的去掉，另一头补一条
  let out = lines.map(v => Math.round(v + dph));
  if (dph > 0 && out[0] - p >= lo) out = [Math.round(out[0] - p), ...out];
  if (dph < 0 && out[out.length - 1] + p < hi) out = [...out, Math.round(out[out.length - 1] + p)];
  return out.filter(v => v >= lo && v < hi);
}

/**
 * 一格的底色和“有没有字”（找网格时判断表头、往外补格子用）。底色取各通道的中位数（字只占格子的一小部分，中位数不受它影响；
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
export function gridFromCorners(img, { x0, y0, x1, y1, cols, rows, refs, locks = null, dewatermark = false }) {
  const xs = Array.from({ length: cols + 1 }, (_, i) => Math.round(x0 + (x1 - x0) * i / cols));
  const ys = Array.from({ length: rows + 1 }, (_, i) => Math.round(y0 + (y1 - y0) * i / rows));
  const res = classifyGrid(img, xs, ys, refs, { locks, dewatermark });
  return { ...res, rows, cols, geom: { xs, ys, pitch: (x1 - x0) / cols, manual: true } };
}

/**
 * 数字化。
 * opts.region: { x, y, w, h } 只在这里面找网格（清单以上的部分）
 * opts.refs:   [{ code, rgb?, count }] 清单里的颜色（rgb 为清单色块的实际取色，没有就用色卡标准色）
 * 返回 { rows, cols, codes, cells(Uint8Array，0=空，i+1=codes[i]), counts, stats, geom }
 */
/**
 * 数字化：找网格 + 逐格归类。颗数明显比清单少时，多半是框（或自动猜的清单位置）切掉了网格边上的一两行/列：
 * 四周各放宽 3 格再找一次，行列只多不少、颗数和清单差得少一半以上才用新的结果。
 */
export function digitize(img, opts) {
  const res = digitizeOnce(img, opts);
  const want = (opts.refs || []).reduce((a, r) => a + (r.count || 0), 0);
  if (res.error || !want || !opts.region || opts.noRetry) return res;
  const beads = res.stats?.beads ?? 0;
  if (beads >= want - Math.max(3, want * 0.015)) return res;
  const p = res.geom.pitch || 10, R = opts.region, W = img.width, H = img.height;
  const x0 = Math.max(0, R.x - 3 * p), y0 = Math.max(0, R.y - 3 * p);
  const x1 = Math.min(W, R.x + R.w + 3 * p), y1 = Math.min(H, R.y + R.h + 3 * p);
  if (x0 >= R.x && y0 >= R.y && x1 <= R.x + R.w && y1 <= R.y + R.h) return res;
  const r2 = digitizeOnce(img, { ...opts, region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  if (r2.error) return res;
  const grew = r2.rows >= res.rows && r2.cols >= res.cols;
  const d1 = Math.abs(beads - want), d2 = Math.abs((r2.stats?.beads ?? 0) - want);
  return grew && d2 < d1 * 0.5 ? { ...r2, geom: { ...r2.geom, extended: true } } : res;
}

/**
 * 在区域里找横竖格线（两轮：先用整个区域估横线，再只在网格范围内估竖线，再回头细化横线）。
 * 返回 { gx, gy }（各自的 lines、pitch）或 { error }
 */
function findGrid(L, W, H, rx0, rx1, ry0, ry1) {
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
    let p;
    if (Math.abs(ratio - n) > 0.15 * n) {
      // 不是整数倍（比如一边被字的行距带偏成 3/4 格）：两个候选周期都在横竖两个剖面上试，梳子对得最齐的赢
      const sc = q => combScore(Px, rx0, rx1, q) + combScore(Py, ry0, ry1, q);
      p = sc(gx.pitch) >= sc(gy.pitch) ? gx.pitch : gy.pitch;
    } else p = n === 2 ? Math.max(gx.pitch, gy.pitch) : Math.min(gx.pitch, gy.pitch);
    gy = gridLines(Py, ry0, ry1, p);
    if (!gy) return { error: '没找到网格横线' };
    Px = profile(L, W, H, 'x', rx0, rx1, gy.lines[0], gy.lines[gy.lines.length - 1]);
    gx = gridLines(Px, rx0, rx1, p);
    if (!gx) return { error: '没找到网格竖线' };
  }
  gy = gridLines(profile(L, W, H, 'y', gx.lines[0], gx.lines[gx.lines.length - 1], ry0, ry1), ry0, ry1, (gx.pitch + gy.pitch) / 2) || gy;

  return { gx, gy };
}

/** 只找网格、返回格子边长（像素）：多图拼接时比较几张截图的缩放比例用。找不到返回 0 */
export function gridPitchOf(img) {
  const W = img.width, H = img.height, d = img.data;
  const L = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) L[i] = lum(d, p);
  const g = findGrid(L, W, H, 0, W, 0, H);
  if (g.error) return 0;
  const n = Math.min(g.gx.lines.length, g.gy.lines.length);
  return n >= 6 ? (g.gx.pitch + g.gy.pitch) / 2 : 0;
}

function digitizeOnce(img, { region, refs, locks = null, dewatermark = false }) {
  const W = img.width, H = img.height, d = img.data;
  const R = region || { x: 0, y: 0, w: W, h: H };
  const rx0 = Math.max(0, Math.round(R.x)), ry0 = Math.max(0, Math.round(R.y));
  const rx1 = Math.min(W, Math.round(R.x + R.w)), ry1 = Math.min(H, Math.round(R.y + R.h));
  const L = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) L[i] = lum(d, p);

  const grid = findGrid(L, W, H, rx0, rx1, ry0, ry1);
  if (grid.error) return { error: grid.error };
  let { gx, gy } = grid;
  let xs = gx.lines, ys = gy.lines;
  // 相位检查：格线很浅、每格又印着字时，“字的那一行”也会形成周期性的峰，可能锁到错位的位置上。
  // 用“色块交界”（两边各自平稳、彼此差很多的台阶）再对一次相位：字的笔画不是台阶，格子交界才是
  ys = phaseFix(img, ys, xs, 'y', ry0, ry1);
  xs = phaseFix(img, xs, ys, 'x', rx0, rx1);
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
    const all0 = list.map(s => (s ? s.ink : 0));
    const avg0 = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    // 编号是浅灰小字、图又缩小过时，一位数的格子可能“没字”：编号特征很明显就放宽
    const step0 = all0.length >= 14 && (avg0(all0.slice(0, 9)) < avg0(all0.slice(9)) * 0.6 || avg0(all0.slice(-9)) < avg0(all0.slice(0, -9)) * 0.6);
    if (inks.length < list.length * (step0 ? 0.5 : 0.7)) return false;
    // 表头写的是 1、2、…、10、11 这样各不相同的数字，字的多少差别大；
    // 一整排同一个色号（比如整行 H2）每格的字一模一样，不算表头
    const mu = inks.reduce((a, b) => a + b, 0) / inks.length;
    const sd = Math.sqrt(inks.reduce((a, b) => a + (b - mu) ** 2, 0) / inks.length);
    // 编号从 1 开始：1~9 是一位数，10 起是两位数，字明显变多（正着编、倒着编都算）
    const all = list.map(s => (s ? s.ink : 0));
    const avg = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const digitStep = all.length >= 14 && (avg(all.slice(0, 9)) < avg(all.slice(9)) * 0.85 || avg(all.slice(-9)) < avg(all.slice(0, -9)) * 0.85);
    const strongStep = all.length >= 14 && (avg(all.slice(0, 9)) < avg(all.slice(9)) * 0.75 || avg(all.slice(-9)) < avg(all.slice(0, -9)) * 0.75);
    if (sd / mu < 0.18 && !digitStep) return false;
    const labs = list.filter(Boolean).map(s => rgbToLab(s.rgb));
    const med = labs.map(l => l).sort((a, b) => a[0] - b[0])[labs.length >> 1];
    const same = labs.filter(l => dLab(l, med) < 8).length;
    // 底色一致（水印、半透明编号栏会让一部分格子颜色偏一点；编号特征很明显时放宽）
    return same >= labs.length * (strongStep ? 0.6 : 0.9);
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

  // 往外补格子：两头的格线太浅没找到（最后一两行全是空格、下面紧挨着编号栏等）。
  // 补的条件：新的一排格子颜色都是网格里已有的颜色、不像编号栏，而且
  // 旁边的编号栏还在继续（有行号/列号），或者这一排里有豆子
  ({ xs, ys } = extendGrid(img, xs, ys, { rx0, ry0, rx1, ry1 }, headerLike));
  rows = ys.length - 1; cols = xs.length - 1;

  const res = classifyGrid(img, xs, ys, refs, { locks, dewatermark });
  return { ...res, rows, cols, geom: { xs, ys, pitch: (gx.pitch + gy.pitch) / 2, dbg } };
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

/**
 * 存进数据库的拼豆板记录。locks：Map(格子→类序号)，存成 [[格子, 色号], …]（色号比序号稳：清单顺序可能变）
 */
export function boardRecord(res, imageId, extra = {}, locks = null) {
  const { xs, ys } = res.geom;
  const lk = locks ? [...locks].map(([i, k]) => [i, k ? res.codes[k - 1] : '']) : [];
  return {
    v: 2, rows: res.rows, cols: res.cols, codes: res.codes, cells: packCells(res.cells),
    stats: res.stats, imageId,
    geom: { x0: xs[0], y0: ys[0], x1: xs[xs.length - 1], y1: ys[ys.length - 1], xs: xs.map(Math.round), ys: ys.map(Math.round) },
    review: boardReview(res, { cols: res.cols, locks }),
    locks: lk,
    createdAt: Date.now(), edits: 0, ...extra,
  };
}

/** 记录里的锁定格子 → Map(格子→类序号)，按当前 refs 的顺序（refs 里没有的色号丢掉） */
export function locksFor(board, refs) {
  if (!board?.locks?.length) return null;
  const m = new Map();
  for (const [i, code] of board.locks) {
    if (i >= board.rows * board.cols) continue;
    const k = code ? refs.findIndex(r => r.code === code) + 1 : 0;
    if (code && !k) continue;
    m.set(i, k);
  }
  return m.size ? m : null;
}
