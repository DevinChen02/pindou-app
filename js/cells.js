// 逐格归类：给网格里的每一格定色号（或空）。三路证据合在一起，一次解出最优：
//   1) 颜色：色卡颜色先按“这张图”校准（稳健仿射拟合），再用 CIEDE2000 色差比；
//   2) 格子里印的字：从这张图自己学每个色号的字形模板（封闭集模板匹配），白豆和空格、颜色几乎一样的两种豆子都靠它分；
//   3) 清单颗数：带软约束的最小费用流（负环消去），精确最优，不是近似。
// 纯函数，浏览器和 Node（测试）都能用。img = { data: RGBA, width, height }
import { rgbToLab, rgbOf, isCode, nearestCodes } from './palette.js';

// ---------- CIEDE2000 ----------
const RAD = Math.PI / 180, P25_7 = 25 ** 7;
export function de2000(a, b) {
  const [L1, a1, b1] = a, [L2, a2, b2] = b;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const Cm7 = Cm ** 7, G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + P25_7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  let h1p = Math.atan2(b1, a1p) / RAD; if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) / RAD; if (h2p < 0) h2p += 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 * RAD);
  const Lm = (L1 + L2) / 2, Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p) { if (Math.abs(h1p - h2p) > 180) hm += h1p + h2p < 360 ? 360 : -360; hm /= 2; }
  const T = 1 - 0.17 * Math.cos((hm - 30) * RAD) + 0.24 * Math.cos(2 * hm * RAD) + 0.32 * Math.cos((3 * hm + 6) * RAD) - 0.2 * Math.cos((4 * hm - 63) * RAD);
  const dTh = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Cmp7 = Cmp ** 7, RC = 2 * Math.sqrt(Cmp7 / (Cmp7 + P25_7));
  const SL = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cmp, SH = 1 + 0.015 * Cmp * T;
  const RT = -Math.sin(2 * dTh * RAD) * RC;
  const x = dLp / SL, y = dCp / SC, z = dHp / SH;
  return Math.sqrt(x * x + y * y + z * z + RT * y * z);
}

// ---------- 每格的特征：底色、字的多少、字形 ----------
export const GW = 24, GH = 14, GD = GW * GH;
const HR = new Uint32Array(256), HG = new Uint32Array(256), HB = new Uint32Array(256);

/**
 * 每格：底色（各通道中位数附近的平均）、有字的像素比例 ink、字形向量 glyph（GW×GH，每点 0~1 = 和底色差多少）。
 * 字形按全图平均字形对齐（±2/±1 格），消掉网格线取整带来的一两个像素偏移。
 */
export function cellFeatures(img, xs, ys) {
  const { data, width, height } = img;
  const rows = ys.length - 1, cols = xs.length - 1, N = rows * cols;
  const rgb = new Float32Array(N * 3), lab = new Float32Array(N * 3), ink = new Float32Array(N);
  const glyph = new Float32Array(N * GD), energy = new Float32Array(N);
  // 每格最多 3 团颜色（底色、字、被水印/遮挡的一块）：[r,g,b,占比] × 3，用来算“这一格里有多少像素是某种颜色”
  const modes = new Float32Array(N * 12);
  const buf = new Int16Array(3 * 4096);
  const px = (x, y) => (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const w = xs[c + 1] - xs[c], h = ys[r + 1] - ys[r];
      // 底色：去掉四边 20%（格线、相邻格的影响）
      const x0 = Math.round(xs[c] + Math.max(1, w * 0.2)), x1 = Math.round(xs[c + 1] - Math.max(1, w * 0.2) + 1);
      const y0 = Math.round(ys[r] + Math.max(1, h * 0.2)), y1 = Math.round(ys[r + 1] - Math.max(1, h * 0.2) + 1);
      HR.fill(0); HG.fill(0); HB.fill(0);
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = px(x, y); HR[data[p]]++; HG[data[p + 1]]++; HB[data[p + 2]]++; n++; }
      let bg = [255, 255, 255];
      if (n) {
        const med = H => { let s = 0; for (let v = 0; v < 256; v++) { s += H[v]; if (s * 2 >= n) return v; } return 255; };
        const m = [med(HR), med(HG), med(HB)];
        let sr = 0, sg = 0, sb = 0, sn = 0, dark = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const p = px(x, y);
          const dr = data[p] - m[0], dg = data[p + 1] - m[1], db = data[p + 2] - m[2];
          const dd = dr * dr + dg * dg + db * db;
          if (dd < 900) { sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; sn++; } else if (dd > 4900) dark++;
        }
        bg = sn ? [sr / sn, sg / sn, sb / sn] : m;
        ink[i] = dark / n;
        // 颜色团：先是底色，剩下的像素里再取中位数找第二团、第三团
        let cnt = 0;
        for (let y = y0; y < y1 && cnt < 4096; y++) for (let x = x0; x < x1 && cnt < 4096; x++) { const p = px(x, y); buf[cnt * 3] = data[p]; buf[cnt * 3 + 1] = data[p + 1]; buf[cnt * 3 + 2] = data[p + 2]; cnt++; }
        let center = bg, left = cnt, mi = 0;
        const used = new Uint8Array(cnt);
        while (left > 0 && mi < 3) {
          if (mi) {
            const rest = [[], [], []];
            for (let j = 0; j < cnt; j++) if (!used[j]) { rest[0].push(buf[j * 3]); rest[1].push(buf[j * 3 + 1]); rest[2].push(buf[j * 3 + 2]); }
            center = rest.map(a => a.sort((u, v) => u - v)[a.length >> 1]);
          }
          let s0 = 0, s1 = 0, s2 = 0, k = 0;
          for (let j = 0; j < cnt; j++) {
            if (used[j]) continue;
            const d = (buf[j * 3] - center[0]) ** 2 + (buf[j * 3 + 1] - center[1]) ** 2 + (buf[j * 3 + 2] - center[2]) ** 2;
            if (d < 900) { used[j] = 1; s0 += buf[j * 3]; s1 += buf[j * 3 + 1]; s2 += buf[j * 3 + 2]; k++; }
          }
          if (!k) break;
          modes.set([s0 / k, s1 / k, s2 / k, k / cnt], i * 12 + mi * 4);
          left -= k; mi++;
        }
      }
      rgb.set(bg, i * 3);
      lab.set(rgbToLab(bg), i * 3);
      // 字形：内框（左右各留 10%，上下各留 15%），每点 3×3 取样
      const gx0 = xs[c] + w * 0.1, gy0 = ys[r] + h * 0.15, sw = w * 0.8 / GW, sh = h * 0.7 / GH;
      let e = 0;
      for (let gy = 0; gy < GH; gy++) {
        for (let gx = 0; gx < GW; gx++) {
          let s = 0;
          for (let yy = 0; yy < 3; yy++) {
            const y = Math.floor(gy0 + (gy + (yy + 0.5) / 3) * sh);
            for (let xx = 0; xx < 3; xx++) {
              const p = px(Math.floor(gx0 + (gx + (xx + 0.5) / 3) * sw), y);
              const d = Math.sqrt((data[p] - bg[0]) ** 2 + (data[p + 1] - bg[1]) ** 2 + (data[p + 2] - bg[2]) ** 2);
              s += d <= 18 ? 0 : d >= 68 ? 1 : (d - 18) / 50;
            }
          }
          const v = s / 9;
          glyph[i * GD + gy * GW + gx] = v; e += v;
        }
      }
      energy[i] = e / GD;
    }
  }
  // 对齐：和全图平均字形做互相关，找最好的平移
  const mean = new Float32Array(GD);
  let nm = 0;
  for (let i = 0; i < N; i++) if (energy[i] > 0.02) { nm++; for (let j = 0; j < GD; j++) mean[j] += glyph[i * GD + j]; }
  if (nm >= 3) {
    const tmp = new Float32Array(GD);
    for (let i = 0; i < N; i++) {
      if (energy[i] <= 0.02) continue;
      const o = i * GD;
      let best = -1, bdx = 0, bdy = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
        let s = 0;
        for (let y = Math.max(0, -dy); y < Math.min(GH, GH - dy); y++) {
          const ro = o + (y + dy) * GW, mo = y * GW;
          for (let x = Math.max(0, -dx); x < Math.min(GW, GW - dx); x++) s += glyph[ro + x + dx] * mean[mo + x];
        }
        if (s > best) { best = s; bdx = dx; bdy = dy; }
      }
      if (!bdx && !bdy) continue;
      tmp.fill(0);
      for (let y = 0; y < GH; y++) {
        const sy = y + bdy; if (sy < 0 || sy >= GH) continue;
        for (let x = 0; x < GW; x++) { const sx = x + bdx; if (sx >= 0 && sx < GW) tmp[y * GW + x] = glyph[o + sy * GW + sx]; }
      }
      glyph.set(tmp, o);
    }
  }
  return { N, rows, cols, rgb, lab, ink, glyph, energy, modes };
}

// ---------- 颜色校准：色卡色 → 这张图上的实际颜色（稳健仿射） ----------
function solve4(M, b) {
  const A = M.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 4; i++) {
    let p = i;
    for (let j = i + 1; j < 4; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let j = 0; j < 4; j++) if (j !== i) { const f = A[j][i] / A[i][i]; for (let k = i; k <= 4; k++) A[j][k] -= f * A[i][k]; }
  }
  return A.map((r, i) => r[4] / r[i]);
}
/** 加权最小二乘：Y ≈ A·[X;1]。点太少时只拟合平移 */
function fitAffine(X, Y, w) {
  const n = X.length;
  const sw = w.reduce((a, b) => a + b, 0) || 1;
  const offset = () => { const o = [0, 1, 2].map(c => X.reduce((a, x, i) => a + w[i] * (Y[i][c] - x[c]), 0) / sw); return [[1, 0, 0, o[0]], [0, 1, 0, o[1]], [0, 0, 1, o[2]]]; };
  if (n < 6) return offset();
  const M = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const B = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const x = [X[i][0], X[i][1], X[i][2], 1];
    for (let a = 0; a < 4; a++) { for (let b = 0; b < 4; b++) M[a][b] += w[i] * x[a] * x[b]; for (let c = 0; c < 3; c++) B[c][a] += w[i] * x[a] * Y[i][c]; }
  }
  // 轻微拉向“只平移”（ridge），颜色集中在一小块时也不会拟合出离谱的变换
  const lam = sw * 2;
  for (let a = 0; a < 3; a++) { M[a][a] += lam; B[a][a] += lam; }
  const rows = B.map(b => solve4(M, b));
  return rows.some(r => !r) ? offset() : rows;
}
const applyAffine = (A, x) => A.map(r => Math.max(0, Math.min(255, r[0] * x[0] + r[1] * x[1] + r[2] * x[2] + r[3])));
function robustAffine(X, Y, w0) {
  let w = [...w0], A = fitAffine(X, Y, w);
  for (let it = 0; it < 6; it++) {
    const res = X.map((x, i) => Math.hypot(...applyAffine(A, x).map((v, c) => v - Y[i][c])));
    w = w0.map((v, i) => v * (res[i] <= 3 ? 1 : 3 / res[i])); // Huber
    A = fitAffine(X, Y, w);
  }
  return A;
}

// ---------- 带颗数软约束的最优归类（最小费用流） ----------
/**
 * cost：N×K1（第 0 类 = 空，不限个数）；target[k]（k≥1）：清单颗数；rho：每多/少一颗的罚分。
 * 目标：Σ cost + rho·Σ|n_k − target_k|。从“各选最便宜”出发，在“类别图”上反复找负环并消去，直到没有负环 = 全局最优。
 * 类别图的边 u→v：把 u 里挪得最便宜的一格改成 v 的代价；T（汇点）连着各类，表示颗数罚分的边际变化。
 * 返回 { assign, pot }，pot 是最优时的对偶势（用来算每格的“把握”）。
 */
export function solveCounts(cost, N, K1, target, rho, init = null, skip = null) {
  const assign = new Int16Array(N);
  const cnt = new Int32Array(K1);
  for (let i = 0; i < N; i++) {
    let b = 0;
    if (init && !skip?.[i]) b = init[i];
    else { let bv = cost[i * K1]; for (let k = 1; k < K1; k++) if (cost[i * K1 + k] < bv) { bv = cost[i * K1 + k]; b = k; } }
    assign[i] = b;
    if (!skip?.[i]) cnt[b]++;
  }
  const V = K1 + 1, T = K1;
  const W = new Float64Array(V * V), arg = new Int32Array(K1 * K1);
  const dist = new Float64Array(V), pred = new Int32Array(V);
  // skip：被遮挡、不像任何颜色的格子（界面浮层、贴纸）不参与凑颗数，只取自己最像的类
  const members = () => { const m = Array.from({ length: K1 }, () => []); for (let i = 0; i < N; i++) if (!skip?.[i]) m[assign[i]].push(i); return m; };
  let mem = members();
  const buildEdges = () => {
    W.fill(Infinity);
    for (let u = 0; u < K1; u++) {
      const list = mem[u];
      if (!list.length) continue;
      for (let v = 0; v < K1; v++) {
        if (v === u) continue;
        let best = Infinity, bi = -1;
        for (const i of list) { const d = cost[i * K1 + v] - cost[i * K1 + u]; if (d < best) { best = d; bi = i; } }
        W[u * V + v] = best; arg[u * K1 + v] = bi;
      }
      // T→u：从 u 拿走一颗；u→T：给 u 加一颗（边际罚分）
      W[T * V + u] = u === 0 ? 0 : cnt[u] > target[u] ? -rho : rho;
    }
    for (let v = 0; v < K1; v++) W[v * V + T] = v === 0 ? 0 : cnt[v] < target[v] ? -rho : rho;
  };
  const EPS = 1e-7;
  let guard = 0;
  for (; guard < 20000; guard++) {
    buildEdges();
    // Bellman-Ford（虚拟源点连所有点，距离 0）找负环
    dist.fill(0); pred.fill(-1);
    let x = -1;
    for (let pass = 0; pass < V; pass++) {
      x = -1;
      for (let u = 0; u < V; u++) {
        for (let v = 0; v < V; v++) {
          const wv = W[u * V + v];
          if (wv === Infinity) continue;
          if (dist[u] + wv < dist[v] - EPS) { dist[v] = dist[u] + wv; pred[v] = u; x = v; }
        }
      }
      if (x < 0) break;
    }
    if (x < 0) break; // 没有负环：最优
    for (let i = 0; i < V; i++) x = pred[x];
    const cyc = [];
    for (let v = x; ; v = pred[v]) { cyc.push(v); if (v === x && cyc.length > 1) break; if (cyc.length > V + 1) break; }
    cyc.reverse(); // 按边的方向：cyc[j] → cyc[j+1]
    const moves = [];
    for (let j = 0; j + 1 < cyc.length; j++) {
      const u = cyc[j], v = cyc[j + 1];
      if (u === T || v === T) continue;
      moves.push([arg[u * K1 + v], u, v]);
    }
    if (!moves.length) break;
    for (const [i, u, v] of moves) { assign[i] = v; cnt[u]--; cnt[v]++; }
    mem = members();
  }
  return { assign, pot: Float64Array.from(dist.subarray(0, K1)), cnt };
}

// ---------- 主流程 ----------
const labOf = rgb => rgbToLab(rgb);

/** 空格的颜色（可能不止一种：比如棋盘格底纹）：没字/离清单色都远的格子里最常见的一两种颜色 */
function emptyColors(F, printed, refLab) {
  const pool = [];
  for (let i = 0; i < F.N; i++) {
    const l = [F.lab[i * 3], F.lab[i * 3 + 1], F.lab[i * 3 + 2]];
    if (printed ? F.ink[i] <= 0.02 : Math.min(...refLab.map(r => de2000(l, r))) > 8) pool.push(l);
  }
  if (!pool.length) return [[98, 0, 0]];
  const bins = new Map();
  for (const l of pool) {
    const k = `${Math.round(l[0] / 3)},${Math.round(l[1] / 3)},${Math.round(l[2] / 3)}`;
    const b = bins.get(k) || { n: 0, s: [0, 0, 0] };
    b.n++; b.s[0] += l[0]; b.s[1] += l[1]; b.s[2] += l[2];
    bins.set(k, b);
  }
  const top = [...bins.values()].sort((a, b) => b.n - a.n);
  const out = [top[0].s.map(v => v / top[0].n)];
  // 第二种空格颜色：够多、而且和第一种明显不同（棋盘格）
  const second = top.find(b => b.n >= Math.max(5, top[0].n * 0.25) && de2000(b.s.map(v => v / b.n), out[0]) > 3);
  if (second) out.push(second.s.map(v => v / second.n));
  return out;
}

/**
 * 归类。refs：[{ code, count, rgb? }]。返回
 *   { codes, cells(Uint8Array，0=空，i+1=codes[i]), counts, margin(Float32Array，每格的把握，越小越可疑),
 *     stats: { printed, exact, total, diff, beads, want, freeCounts, calibrated, textUsed }, suspects }
 */
export function classifyFeatures(F, refs, opt = {}) {
  const { rho = 16, textWeight = 1, colorCap = 12, iters = 3, coverW = 12, textCap = 8, outlierDE = 20 } = opt;
  const codes = refs.map(r => r.code);
  const K = codes.length, K1 = K + 1, N = F.N;
  const target = Int32Array.from([0, ...refs.map(r => r.count || 0)]);
  const total = target.reduce((a, b) => a + b, 0);
  const src = refs.map(r => (isCode(r.code) ? rgbOf(r.code) : r.rgb || [160, 160, 160]));
  const labs = Array.from({ length: N }, (_, i) => [F.lab[i * 3], F.lab[i * 3 + 1], F.lab[i * 3 + 2]]);
  const inkCells = F.ink.reduce((a, v) => a + (v > 0.04 ? 1 : 0), 0);
  const printed = inkCells > Math.min(N * 0.25, total * 0.5);
  const INK = printed ? 8 : 0;

  let refLab = src.map(labOf);
  let emptyLab = emptyColors(F, printed, refLab);
  const colorCost = new Float32Array(N * K1);
  // “覆盖率”：这一格里有多大比例的像素就是这个颜色。豆子几乎铺满整格（除了字）；
  // 水印、半透明遮挡的格子中位色会偏，但覆盖率一看就不像任何一种豆子
  const cover = (i, rgbs) => {
    let c = 0;
    for (let m = 0; m < 3; m++) {
      const o = i * 12 + m * 4, f = F.modes[o + 3];
      if (!f) break;
      let best = 0;
      for (const r of rgbs) {
        const d = Math.sqrt((F.modes[o] - r[0]) ** 2 + (F.modes[o + 1] - r[1]) ** 2 + (F.modes[o + 2] - r[2]) ** 2);
        const s = d <= 8 ? 1 : d >= 20 ? 0 : (20 - d) / 12;
        if (s > best) best = s;
      }
      c += f * best;
    }
    return c;
  };
  const labToRgb = l => { // 近似：参考色的 RGB（用于覆盖率）
    const fy = (l[0] + 16) / 116, fx = fy + l[1] / 500, fz = fy - l[2] / 200;
    const g = t => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
    const X = g(fx) * 0.95047, Y = g(fy), Z = g(fz) * 1.08883;
    const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
    return lin.map(v => 255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  };
  const fillColor = () => {
    const refRgb = refLab.map(labToRgb), emRgb = emptyLab.map(labToRgb);
    // 同色格子很多：按 Lab（保留一位小数）缓存色差
    const memo = new Map();
    for (let i = 0; i < N; i++) {
      const l = labs[i], key = `${Math.round(l[0] * 10)},${Math.round(l[1] * 10)},${Math.round(l[2] * 10)}`;
      let de = memo.get(key);
      if (!de) {
        de = new Float32Array(K1);
        let e = Infinity;
        for (const el of emptyLab) e = Math.min(e, de2000(l, el));
        de[0] = Math.min(colorCap, e);
        for (let k = 0; k < K; k++) de[k + 1] = Math.min(colorCap, de2000(l, refLab[k]));
        memo.set(key, de);
      }
      colorCost[i * K1] = de[0] + coverW * Math.max(0, 1 - cover(i, emRgb) / 0.7);
      for (let k = 0; k < K; k++) colorCost[i * K1 + k + 1] = de[k + 1] + coverW * Math.max(0, 1 - cover(i, [refRgb[k]]) / 0.7);
    }
  };
  const cost = new Float32Array(N * K1);
  const inkCost = () => {
    for (let i = 0; i < N; i++) {
      const has = F.ink[i] > 0.04;
      for (let k = 0; k < K1; k++) cost[i * K1 + k] = colorCost[i * K1 + k] + (has === (k === 0) ? INK : 0);
    }
  };
  // 离所有颜色（含空格颜色）都很远的格子：界面浮层、贴纸、大块遮挡。不拿它们凑颗数
  const outlier = new Uint8Array(N);
  const markOutliers = () => {
    let n = 0;
    for (let i = 0; i < N; i++) {
      let m = Infinity;
      for (const el of emptyLab) m = Math.min(m, de2000(labs[i], el));
      for (let k = 0; k < K && m > outlierDE; k++) m = Math.min(m, de2000(labs[i], refLab[k]));
      outlier[i] = m > outlierDE && !locks?.has(i) ? 1 : 0; n += outlier[i];
    }
    return n;
  };
  // 锁定的格子（用户改过的、识字核对过的）：只能是那一类
  const locks = opt.locks || null; // Map(格子序号 → 类序号 0..K)
  const applyLocks = () => {
    if (!locks) return;
    for (const [i, k] of locks) for (let j = 0; j < K1; j++) if (j !== k) cost[i * K1 + j] += 1000;
  };
  const solve = (init) => { applyLocks(); return solveCounts(cost, N, K1, target, total > 0 ? rho : 0, init, outlier); };
  const medianRgb = (assign, k) => {
    const v = [];
    for (let i = 0; i < N; i++) if (assign[i] === k && !outlier[i]) v.push(i);
    if (v.length < 3) return null;
    const med = c => { const a = v.map(i => F.rgb[i * 3 + c]).sort((x, y) => x - y); return a[a.length >> 1]; };
    return { rgb: [med(0), med(1), med(2)], n: v.length };
  };

  // 第 1 轮：原始色卡色
  fillColor(); inkCost();
  let sol = solve();
  // 校准：用各类格子的中位色拟合“色卡 → 本图”的仿射变换（稳健：认错的类当离群点）
  let calibrated = false;
  {
    const X = [], Y = [], w = [];
    for (let k = 0; k < K; k++) { const m = medianRgb(sol.assign, k + 1); if (m) { X.push(src[k]); Y.push(m.rgb); w.push(Math.sqrt(m.n)); } }
    if (X.length >= 2) {
      const A = robustAffine(X, Y, w);
      refLab = src.map(s => labOf(applyAffine(A, s)));
      calibrated = true;
    }
  }
  // 锁定格子的颜色就是这一类在图上的真实颜色：直接当锚点
  if (locks) {
    const byK = new Map();
    for (const [i, k] of locks) if (k) (byK.get(k) || byK.set(k, []).get(k)).push(labs[i]);
    for (const [k, ls] of byK) { const med = c => ls.map(l => l[c]).sort((a, b) => a - b)[ls.length >> 1]; refLab[k - 1] = [med(0), med(1), med(2)]; }
  }
  const calLab = refLab.map(l => [...l]);
  emptyLab = emptyColors(F, printed, refLab);
  markOutliers();
  fillColor(); inkCost();
  sol = solve();
  // 各类参考色换成本类格子的中位色（离“锚点”太远就不换，防止整类漂到别的颜色上）。
  // 锚点 = 校准后的色卡色；如果在图上找到了这个色号“自己的那一团颜色”，锚点就换成那一团
  const anchor = calLab.map(l => [...l]);
  const updateRefs = (assign) => {
    for (let k = 0; k < K; k++) {
      const m = medianRgb(assign, k + 1);
      if (!m) { refLab[k] = anchor[k]; continue; }
      const l = labOf(m.rgb);
      refLab[k] = de2000(l, anchor[k]) < 6 ? l : anchor[k];
    }
  };
  updateRefs(sol.assign);
  let nOut = markOutliers();
  fillColor(); inkCost();
  sol = solve(sol.assign);
  // 颜色团：渲染出来的同一种豆子颜色几乎完全一样。找出“没有被任何色号认领”的颜色团，
  // 分给“图上找不到自己颜色”的色号（常见于色卡和出图软件的色表不一致、又只有几颗的颜色）
  const clusters = colorClusters(labs, outlier);
  const orphanedCodes = [];
  const orphanFix = () => {
    const confirmed = new Float64Array(K1);
    const orphans = [];
    for (const cl of clusters) {
      // 一团可以同时“证实”好几个色号（比如白豆和白底几乎同色）
      let hit = emptyLab.some(e => de2000(cl.centre, e) < 4);
      for (let k = 0; k < K; k++) if (de2000(cl.centre, refLab[k]) < 3) { confirmed[k + 1] += cl.cells.length; hit = true; }
      if (!hit) orphans.push(cl);
    }
    const need = [];
    for (let k = 1; k < K1; k++) if (target[k] > 0 && confirmed[k] < target[k] * 0.5) need.push(k);
    const pairs = [];
    for (const k of need) for (const cl of orphans) {
      const d = de2000(cl.centre, calLab[k - 1]);
      if (d < 12) pairs.push([d + 4 * Math.abs(Math.log((cl.cells.length + 1) / (target[k] - confirmed[k] + 1))), k, cl]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedK = new Set(), usedC = new Set();
    let changed = 0;
    for (const [, k, cl] of pairs) {
      if (usedK.has(k) || usedC.has(cl)) continue;
      usedK.add(k); usedC.add(cl);
      anchor[k - 1] = cl.centre; refLab[k - 1] = cl.centre; changed++;
      orphanedCodes.push(codes[k - 1]);
    }
    return changed;
  };
  if (orphanFix()) {
    fillColor(); inkCost();
    sol = solve(sol.assign);
    updateRefs(sol.assign);
    fillColor(); inkCost();
    sol = solve(sol.assign);
  }

  // 字形模板（有印色号时）
  let textUsed = false;
  let tcostOut = null;
  if (printed && textWeight > 0) {
    const tcost = new Float32Array(N * K1);
    tcostOut = tcost;
    const T = new Float32Array(K1 * GD), has = new Uint8Array(K1);
    for (let it = 0; it < iters; it++) {
      // 模板 = 当前归到这类的格子的平均字形
      T.fill(0); has.fill(0);
      const n = new Int32Array(K1);
      for (let i = 0; i < N; i++) { if (outlier[i]) continue; const k = sol.assign[i]; n[k]++; const o = i * GD, to = k * GD; for (let j = 0; j < GD; j++) T[to + j] += F.glyph[o + j]; }
      const generic = new Float32Array(GD); let ng = 0;
      for (let k = 0; k < K1; k++) {
        if (n[k] >= 2) { has[k] = 1; for (let j = 0; j < GD; j++) T[k * GD + j] /= n[k]; }
        if (k && n[k] >= 2) { ng += n[k]; for (let j = 0; j < GD; j++) generic[j] += T[k * GD + j] * n[k]; }
      }
      if (ng) for (let j = 0; j < GD; j++) generic[j] /= ng;
      for (let k = 0; k < K1; k++) if (!has[k] && k) T.set(generic, k * GD); // 格子太少的色号：用“有字”的通用模板
      if (!has[0]) T.fill(0, 0, GD);
      // 每格和每个模板的均方差
      const best = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const o = i * GD;
        let bmin = Infinity;
        for (let k = 0; k < K1; k++) {
          const to = k * GD;
          let s = 0;
          for (let j = 0; j < GD; j++) { const d = F.glyph[o + j] - T[to + j]; s += d * d; }
          s /= GD;
          tcost[i * K1 + k] = s;
          if (s < bmin) bmin = s;
        }
        best[i] = bmin;
      }
      // 归一化：除以“对的那类”的典型残差（图越糊，字的证据越弱）
      const sorted = Array.from(best).filter((v, i) => F.energy[i] > 0.02).sort((a, b) => a - b);
      const s0 = Math.max(1e-4, sorted.length ? sorted[sorted.length >> 1] : 1e-3);
      for (let i = 0; i < N * K1; i++) cost[i] = colorCost[i] + textWeight * Math.min(textCap, tcost[i] / s0);
      sol = solve(sol.assign);
      updateRefs(sol.assign);
      fillColor();
      for (let i = 0; i < N * K1; i++) cost[i] = colorCost[i] + textWeight * Math.min(textCap, tcost[i] / s0);
      sol = solve(sol.assign);
      if (opt.debug) opt.debug.s0 = s0;
    }
    textUsed = true;
  }

  // ---- 输出 ----
  const assign = sol.assign, pot = sol.pot;
  if (opt.debug) Object.assign(opt.debug, { cost, colorCost, pot, refLab, emptyLab });
  const cntArr = new Int32Array(K1);
  for (let i = 0; i < N; i++) cntArr[assign[i]]++;
  // 每格的“把握”：换成别的类要多花多少（含对偶势，也就是颗数约束的影响）；越小越可疑
  const margin = new Float32Array(N);
  const second = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    const a = assign[i];
    let m = Infinity, b = 0;
    for (let v = 0; v < K1; v++) {
      if (v === a) continue;
      const d = cost[i * K1 + v] - cost[i * K1 + a] + pot[a] - pot[v];
      if (d < m) { m = d; b = v; }
    }
    margin[i] = locks?.has(i) ? 99 : outlier[i] ? 0 : m; second[i] = b;
  }
  // 不带颗数约束时，图上看起来每种颜色有几格（交叉核对清单用）
  const freeCounts = {};
  for (let i = 0; i < N; i++) {
    let b = 0, bv = cost[i * K1];
    for (let k = 1; k < K1; k++) if (cost[i * K1 + k] < bv) { bv = cost[i * K1 + k]; b = k; }
    if (b) freeCounts[codes[b - 1]] = (freeCounts[codes[b - 1]] || 0) + 1;
  }
  // 每类的“贴合度”：归到这类的格子和参考色差多少（中位数）。差得多 = 这类其实没找到自己的颜色
  const fit = codes.map((c, k) => {
    const d = [];
    for (let i = 0; i < N; i++) if (assign[i] === k + 1 && !outlier[i]) d.push(de2000(labs[i], refLab[k]));
    d.sort((a, b) => a - b);
    return d.length ? d[d.length >> 1] : 0;
  });
  const counts = Object.fromEntries(codes.map((c, k) => [c, cntArr[k + 1]]));
  const diff = codes.map((c, k) => ({ code: c, want: target[k + 1], got: cntArr[k + 1] })).filter(x => x.want !== x.got);
  const suspects = findSuspects(F, labs, refLab, emptyLab, printed, assign);
  return {
    codes, cells: Uint8Array.from(assign), counts, margin, second,
    refLab, calLab, // 各类最终的参考色 / 色卡校准色（Lab）
    orphaned: orphanedCodes, // 靠“没人认领的颜色团”找到颜色的色号（身份没有被颜色证实）
    fit,
    textCost: tcostOut, // 每格和每类字形模板的差距（N×(K+1)），核对身份时用来“找藏起来的格子”
    cost, // 每格每类的总代价（N×(K+1)），列候选用
    stats: {
      printed, exact: codes.length - diff.length, total: codes.length, diff,
      beads: cntArr.reduce((a, b, k) => a + (k ? b : 0), 0), want: total, freeCounts, calibrated, textUsed, outliers: nOut,
    },
    suspects,
  };
}

/**
 * 颜色团（quick-shift）：每格往“附近格子更密”的方向挂，树根就是一团。
 * 只保留紧凑的团（≥2 格）。返回 [{ centre: Lab, cells: [索引] }]
 */
export function colorClusters(labs, skip, h = 1.5) {
  // 先按 h/2 的小格合并（同色的格子成百上千，合并后点数少得多），再在小格上做 quick-shift
  const q = h / 2;
  const bins = new Map();
  for (let i = 0; i < labs.length; i++) {
    if (skip?.[i]) continue;
    const l = labs[i], key = `${Math.floor(l[0] / q)},${Math.floor(l[1] / q)},${Math.floor(l[2] / q)}`;
    let b = bins.get(key);
    if (!b) { b = { bx: Math.floor(l[0] / q), by: Math.floor(l[1] / q), bz: Math.floor(l[2] / q), s: [0, 0, 0], cells: [] }; bins.set(key, b); }
    b.s[0] += l[0]; b.s[1] += l[1]; b.s[2] += l[2]; b.cells.push(i);
  }
  const B = [...bins.values()];
  for (const b of B) { b.m = b.s.map(v => v / b.cells.length); b.dens = 0; b.parent = null; }
  const R = Math.ceil((2 * h) / q);
  const around = b => {
    const out = [];
    for (let x = b.bx - R; x <= b.bx + R; x++) for (let y = b.by - R; y <= b.by + R; y++) for (let z = b.bz - R; z <= b.bz + R; z++) {
      const o = bins.get(`${x},${y},${z}`);
      if (o) out.push([o, Math.hypot(b.m[0] - o.m[0], b.m[1] - o.m[1], b.m[2] - o.m[2])]);
    }
    return out;
  };
  const nb = new Map();
  for (const b of B) { const a = around(b); nb.set(b, a); for (const [o, d] of a) if (d < h) b.dens += o.cells.length * Math.exp(-(d * d) / (2 * (h / 2) ** 2)); }
  for (const b of B) {
    let best = null, bd = Infinity;
    for (const [o, d] of nb.get(b)) if (o !== b && d < 2 * h && (o.dens > b.dens || (o.dens === b.dens && o.cells[0] < b.cells[0])) && d < bd) { bd = d; best = o; }
    b.parent = best;
  }
  const root = b => { while (b.parent) b = b.parent; return b; };
  const groups = new Map();
  for (const b of B) { const r = root(b); (groups.get(r) || groups.set(r, []).get(r)).push(b); }
  const out = [];
  for (const [r, bs] of groups) {
    const tight = [];
    for (const b of bs) if (Math.hypot(b.m[0] - r.m[0], b.m[1] - r.m[1], b.m[2] - r.m[2]) < 2 * h) tight.push(...b.cells);
    if (tight.length < 2) continue;
    const med = c => tight.map(i => labs[i][c]).sort((a, b) => a - b)[tight.length >> 1];
    out.push({ centre: [med(0), med(1), med(2)], cells: tight });
  }
  return out;
}

/**
 * 清单里可能漏了的颜色：颜色离清单里每种颜色（和空格颜色）都远、自己又很集中的一团格子。
 * 返回 [{ n, rgb, near: [{code, de}], cells: [索引] }]
 */
function findSuspects(F, labs, refLab, emptyLab, printed, assign) {
  const far = [];
  for (let i = 0; i < F.N; i++) {
    if (printed && F.ink[i] <= 0.04) continue;
    let m = Infinity;
    for (const r of refLab) m = Math.min(m, de2000(labs[i], r));
    for (const e of emptyLab) m = Math.min(m, de2000(labs[i], e));
    // 离清单里最近的颜色也有 10 以上（比这更近的，多半是被水印/遮挡染了一层的已有颜色）
    if (m > 10) far.push(i);
  }
  const groups = [];
  for (const i of far) {
    let g = groups.find(g => de2000(g.lab, labs[i]) < 3);
    if (!g) { g = { lab: labs[i], cells: [] }; groups.push(g); }
    g.cells.push(i);
  }
  const out = [];
  for (const g of groups) {
    if (g.cells.length < 4) continue;
    // 团内颜色要集中（水印、半遮挡的格子颜色很散，不算）
    const rgb = [0, 1, 2].map(c => g.cells.reduce((a, i) => a + F.rgb[i * 3 + c], 0) / g.cells.length);
    const lab = rgbToLab(rgb);
    const spread = g.cells.reduce((a, i) => a + de2000(labs[i], lab), 0) / g.cells.length;
    if (spread > 1.8) continue;
    out.push({ n: g.cells.length, rgb: rgb.map(Math.round), near: nearestCodes(rgb.map(Math.round), 3), cells: g.cells });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** 从网格线直接归类（自动找到的网格、手动校准的网格都走这里） */
export function classifyGrid(img, xs, ys, refs, opt) {
  const F = cellFeatures(img, xs, ys);
  const res = classifyFeatures(F, refs, opt);
  return { rows: F.rows, cols: F.cols, ...res, geom: { xs, ys } };
}

// ---------- 身份核对：颜色分不清的色号，读几格上印的字来确认 ----------
/**
 * 哪些色号只靠颜色定不下来：和别的色号颜色很近（相近色），或者图上的颜色和色卡差得多（出图软件色表不同）。
 * 返回 [{ k(1..K), code, partners: [code], reason: 'close'|'drift' }]
 */
export function identityRisks(res, { close = 6, drift = 5 } = {}) {
  const { codes, refLab, calLab, counts, orphaned = [], fit = [] } = res;
  const out = new Map();
  const add = (k, j, reason) => {
    const e = out.get(k) || { k: k + 1, code: codes[k], partners: new Set(), reason };
    if (j != null) e.partners.add(codes[j]);
    out.set(k, e);
  };
  for (let a = 0; a < codes.length; a++) {
    if (!counts[codes[a]]) continue;
    for (let b = a + 1; b < codes.length; b++) {
      if (!counts[codes[b]]) continue;
      if (de2000(refLab[a], refLab[b]) < close) { add(a, b, 'close'); add(b, a, 'close'); }
    }
    if (de2000(refLab[a], calLab[a]) > drift || orphaned.includes(codes[a]) || fit[a] > 4) {
      // 这团颜色更像哪几个色号的色卡色
      const near = codes.map((c, j) => [j, de2000(refLab[a], calLab[j])]).filter(([j]) => j !== a).sort((x, y) => x[1] - y[1]).slice(0, 2);
      add(a, null, 'drift');
      for (const [j] of near) add(a, j, 'drift');
    }
  }
  return [...out.values()].map(e => ({ ...e, partners: [...e.partners] }));
}

/** 每个要核对的色号挑几格最典型的（把握最大、彼此隔开） */
export function probeCells(res, k, n = 6, cols = 1) {
  const idx = [];
  for (let i = 0; i < res.cells.length; i++) if (res.cells[i] === k) idx.push(i);
  idx.sort((a, b) => res.margin[b] - res.margin[a]);
  const out = [];
  for (const i of idx) {
    if (out.length >= n) break;
    if (out.some(j => Math.abs((j % cols) - (i % cols)) <= 1 && Math.abs(Math.floor(j / cols) - Math.floor(i / cols)) <= 1)) continue;
    out.push(i);
  }
  return out;
}

/**
 * 用“读字器”核对：reader(box, lexicon) → { text, margin }（text 是 lexicon 里最像的一个，'' = 没字）。
 * 返回 { locks: Map(格子→类), report: [{ code, reads: {读到: 次数}, verdict }] }。
 * 一类里多数格子（≥60%，至少 2 格）都读成同一个色号 X，才采信：这些格子锁成 X。
 */
export async function verifyIdentities(res, xs, ys, reader, { n = 6, risks = null, maxHunt = 120 } = {}) {
  const cols = xs.length - 1;
  const lexicon = res.codes;
  const locks = new Map(), report = [];
  for (const r of risks || identityRisks(res)) {
    const cells = probeCells(res, r.k, n, cols);
    const reads = [];
    for (const i of cells) {
      const row = Math.floor(i / cols), c = i % cols;
      const w = xs[c + 1] - xs[c], h = ys[row + 1] - ys[row];
      const box = { x0: xs[c] + w * 0.12, y0: ys[row] + h * 0.28, x1: xs[c + 1] - w * 0.12, y1: ys[row + 1] - h * 0.28 };
      const rd = await reader(box, lexicon);
      reads.push({ i, ...rd });
    }
    const good = reads.filter(x => x.text && x.margin >= 2);
    const tally = {};
    for (const x of good) tally[x.text] = (tally[x.text] || 0) + 1;
    const [top, cnt] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    let verdict = 'unsure';
    if (top && cnt >= 2 && cnt >= reads.length * 0.6) {
      verdict = top === r.code ? 'ok' : top;
      const k = res.codes.indexOf(top) + 1;
      for (const x of good) if (x.text === top) locks.set(x.i, k);
    }
    report.push({ code: r.code, reason: r.reason, reads: tally, verdict, partners: r.partners });
  }
  // 身份不对的色号：它真正的格子多半混在相近的色号里（颜色一样、字不一样）。
  // 在那些色号的格子里，挑“字和本类模板最不像”的一批读一读
  const K1 = res.codes.length + 1;
  const hunted = new Set();
  for (const rep of report) {
    if (rep.verdict === 'ok' || rep.verdict === 'unsure') continue;
    const k = res.codes.indexOf(rep.code) + 1;
    const want = (res.counts[rep.code] || 0);
    const pool = new Set([...rep.partners, ...(rep.verdict !== 'unsure' ? [rep.verdict] : [])]);
    for (const pc of pool) {
      const p = res.codes.indexOf(pc) + 1;
      if (p <= 0 || hunted.has(p)) continue;
      hunted.add(p);
      const idx = [];
      for (let i = 0; i < res.cells.length; i++) if (res.cells[i] === p && !locks.has(i)) idx.push(i);
      if (!res.textCost) continue;
      idx.sort((a, b) => res.textCost[b * K1 + p] - res.textCost[a * K1 + p]);
      const m = Math.min(idx.length, Math.max(8, Math.min(maxHunt, want * 2 + 6)));
      for (const i of idx.slice(0, m)) {
        const row = Math.floor(i / cols), c = i % cols;
        const w = xs[c + 1] - xs[c], h = ys[row + 1] - ys[row];
        const rd = await reader({ x0: xs[c] + w * 0.12, y0: ys[row] + h * 0.28, x1: xs[c + 1] - w * 0.12, y1: ys[row + 1] - h * 0.28 }, lexicon);
        // 只认“就是要找的那个色号”（读错的代价大：锁定是硬约束）
        if (rd.text === rep.code && rd.margin >= 4) locks.set(i, k);
      }
    }
  }
  return { locks, report };
}

// ---------- 给“核对拼豆板”用的摘要（存进数据库，不含大数组） ----------
/** 一格最可能的几个类（含“空”），按代价从低到高 */
export function candidatesOf(res, i, n = 3) {
  const K1 = res.codes.length + 1;
  const order = [...Array(K1).keys()].sort((a, b) => res.cost[i * K1 + a] - res.cost[i * K1 + b]);
  return order.slice(0, n).map(k => (k ? res.codes[k - 1] : ''));
}

/**
 * 需要人看一眼的地方：
 *   risks：只靠颜色定不下来的色号，每个给一格“最典型的”让人确认；
 *   hunt：每个有风险的色号，在相近色号里“字最不像”的一批格子（身份认错时，让人点出真正的格子）；
 *   uncertain：把握最小的一些格子（带候选）；
 *   suspects：清单里可能漏了的颜色；free：不按清单约束时每种颜色的格数。
 */
export function boardReview(res, { cols, locks = null, maxUncertain = 30, huntN = 24 } = {}) {
  const K1 = res.codes.length + 1;
  const locked = i => locks?.has(i);
  const risks = identityRisks(res).map(r => {
    const probe = probeCells(res, r.k, 3, cols).filter(i => !locked(i));
    // 相近色号里、和“那个色号的字形模板”最不像的格子
    const hunt = [];
    if (res.textCost) {
      for (const pc of r.partners) {
        const p = res.codes.indexOf(pc) + 1;
        for (let i = 0; i < res.cells.length; i++) if (res.cells[i] === p && !locked(i)) hunt.push([i, res.textCost[i * K1 + p]]);
      }
      hunt.sort((a, b) => b[1] - a[1]);
    }
    return { code: r.code, reason: r.reason, partners: r.partners, probe, hunt: hunt.slice(0, huntN).map(x => x[0]) };
  });
  const riskCodes = new Set(risks.map(r => r.code));
  const idx = [];
  for (let i = 0; i < res.cells.length; i++) if (!locked(i) && res.margin[i] < 3) idx.push(i);
  idx.sort((a, b) => res.margin[a] - res.margin[b]);
  const uncertain = idx.slice(0, maxUncertain).map(i => ({ i, cand: candidatesOf(res, i, 3) }));
  const suspects = (res.suspects || []).slice(0, 5).map(s => ({ n: s.n, rgb: s.rgb, near: s.near.map(x => x.code), cells: s.cells.slice(0, 6) }));
  return { risks, uncertain, suspects, free: res.stats.freeCounts, riskCodes: [...riskCodes] };
}
