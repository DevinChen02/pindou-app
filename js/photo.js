// 普通图片 → 拼豆图纸：把一张图（照片、插画、像素画）缩成 cols × rows 格，每格换成色卡里的一个色号。
//   1) 每格取色：格子里像素的中位色附近的平均（边上压着线条的格子不会被平均成脏颜色）；像素画按原来的像素格只取每格中间；
//   2) 背景：透明的地方不放豆子；四周一大片同色（白底等）可以去掉；
//   3) 换成色号：CIEDE2000 色差，在允许的色号里选；限制颜色数时先贪心地去掉“去掉了损失最小”的颜色，
//      再像 k-means 一样（中心只能是色卡里的颜色）交替调整，直到不再变好；
//   4) 可选：抖动（误差扩散，照片的颜色过渡更自然）、去掉零星杂点。
// 纯函数，浏览器主线程、Web Worker、Node（测试）都能用。img = { data: RGBA, width, height }。
// 色卡由调用方传进来（pal：[[色号, r, g, b], …]）：Worker 里没有用户自定义的色卡。
import { rgbToLab } from './palette.js';
import { de2000 } from './cells.js';

const OPA = 128;

// ---------- 像素画：找原来的像素格 ----------

function pixDiff(d, i, j) {
  const o1 = d[i + 3] >= OPA, o2 = d[j + 3] >= OPA;
  if (!o1 && !o2) return 0;
  if (o1 !== o2) return 255;
  return Math.max(Math.abs(d[i] - d[j]), Math.abs(d[i + 1] - d[j + 1]), Math.abs(d[i + 2] - d[j + 2]));
}

/** 每一列（行）左边（上边）那条缝上，有多大比例的行（列）颜色突变 */
function edgeProfiles(img, T = 24) {
  const { data: d, width: W, height: H } = img;
  const ex = new Float32Array(W), ey = new Float32Array(H);
  const sy = Math.max(1, Math.floor(H / 600)), sx = Math.max(1, Math.floor(W / 600));
  let nr = 0, nc = 0;
  for (let y = 0; y < H; y += sy) {
    nr++;
    const row = y * W * 4;
    for (let x = 1; x < W; x++) if (pixDiff(d, row + (x - 1) * 4, row + x * 4) > T) ex[x]++;
  }
  for (let x = 0; x < W; x += sx) {
    nc++;
    for (let y = 1; y < H; y++) if (pixDiff(d, ((y - 1) * W + x) * 4, (y * W + x) * 4) > T) ey[y]++;
  }
  for (let x = 0; x < W; x++) ex[x] /= nr;
  for (let y = 0; y < H; y++) ey[y] /= nc;
  return { ex, ey };
}

/**
 * 一个方向上的像素格：突变的位置都落在 o + k·p 上。p 可以不是整数（截图时缩放过）。
 * 相邻两条突变之间的距离都是 p 的整数倍：从较小的几个间距猜 p，最小二乘细调，再看所有突变是不是都对得上。
 * 对得上的里面取最大的 p（p/2、p/3 也“对得上”，但那不是原来的像素）。
 */
export function axisPeriod(e, n) {
  const vals = Float32Array.from(e).sort();
  const top = vals[Math.floor(vals.length * 0.97)];
  if (!(top > 0.02)) return null;
  const th = top * 0.3;
  let strong = 0, cur = null;
  const runs = [];
  for (let x = 1; x < n; x++) {
    if (!(e[x] > th)) continue;
    strong++;
    if (cur && x - cur.last <= 1) { cur.sw += e[x]; cur.sx += e[x] * x; cur.last = x; }
    else { cur = { sw: e[x], sx: e[x] * x, last: x }; runs.push(cur); }
  }
  // 照片：到处都是突变；像素画：只在像素边上
  if (strong > 0.5 * n || runs.length < 3) return null;
  const cs = runs.map(r => r.sx / r.sw), ws = runs.map(r => r.sw);
  const gaps = [];
  for (let i = 1; i < cs.length; i++) gaps.push(cs[i] - cs[i - 1]);
  const sg = [...gaps].sort((a, b) => a - b);
  const seeds = [...new Set([0.1, 0.25, 0.5].map(q => sg[Math.floor((sg.length - 1) * q)]))];
  const totW = ws.reduce((a, b) => a + b, 0);
  let best = null;
  for (const g0 of seeds) {
    for (let k = 1; k <= 4; k++) {
      let p = g0 / k;
      if (p < 1.6) break;
      for (let it = 0; it < 4; it++) {
        let num = 0, den = 0;
        for (const g of gaps) { const m = Math.round(g / p); if (m >= 1) { num += g * m; den += m * m; } }
        if (!den) break;
        p = num / den;
      }
      if (!(p >= 1.6) || p > n / 4) continue;
      // 每条突变是第几格（从第一条数起），对整排位置做直线拟合 c = o + k·p（跨度大，比只看间距准）
      let o = cs[0];
      for (let it = 0; it < 2; it++) {
        const ks = [0];
        for (let i = 1; i < cs.length; i++) ks.push(ks[i - 1] + Math.max(1, Math.round((cs[i] - cs[i - 1]) / p)));
        let sw = 0, sk = 0, sc0 = 0, skk = 0, skc = 0;
        for (let i = 0; i < cs.length; i++) { const w = ws[i]; sw += w; sk += w * ks[i]; sc0 += w * cs[i]; skk += w * ks[i] * ks[i]; skc += w * ks[i] * cs[i]; }
        const den = sw * skk - sk * sk;
        if (!(den > 0)) break;
        const p2 = (sw * skc - sk * sc0) / den;
        if (!(p2 >= 1.6)) break;
        p = p2; o = (sc0 - p * sk) / sw;
      }
      if (!(p >= 1.6) || p > n / 4) continue;
      o = ((o % p) + p) % p;
      const tol = Math.max(0.6, 0.1 * p);
      let hit = 0;
      for (let i = 0; i < cs.length; i++) { const t = (cs[i] - o) / p; if (Math.abs(t - Math.round(t)) * p <= tol) hit += ws[i]; }
      const S = hit / totW;
      if (S >= 0.9 && (!best || p > best.p * 1.02)) best = { p, o, S };
    }
  }
  return best;
}

/** 按找到的像素格，每格中间那一块是不是一个颜色（像素画是；照片、渐变不是） */
function blockUniformity(img, gx, gy) {
  const { data: d, width: W, height: H } = img;
  const nbx = Math.floor((W - gx.o) / gx.p), nby = Math.floor((H - gy.o) / gy.p);
  if (nbx < 4 || nby < 4) return 0;
  const sx = Math.max(1, Math.floor(nbx / 30)), sy = Math.max(1, Math.floor(nby / 30));
  let good = 0, tot = 0;
  const R = [], G = [], B = [];
  for (let j = 0; j < nby; j += sy) for (let i = 0; i < nbx; i += sx) {
    const x0 = Math.ceil(gx.o + (i + 0.25) * gx.p), x1 = Math.floor(gx.o + (i + 0.75) * gx.p);
    const y0 = Math.ceil(gy.o + (j + 0.25) * gy.p), y1 = Math.floor(gy.o + (j + 0.75) * gy.p);
    R.length = G.length = B.length = 0;
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, Math.max(y0, y1)); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, Math.max(x0, x1)); x++) {
        const q = (y * W + x) * 4;
        if (d[q + 3] < OPA) { R.push(-1); G.push(-1); B.push(-1); } else { R.push(d[q]); G.push(d[q + 1]); B.push(d[q + 2]); }
      }
    }
    if (!R.length) continue;
    const med = a => [...a].sort((u, v) => u - v)[a.length >> 1];
    const mr = med(R), mg = med(G), mb = med(B);
    for (let k = 0; k < R.length; k++) {
      tot++;
      if (Math.max(Math.abs(R[k] - mr), Math.abs(G[k] - mg), Math.abs(B[k] - mb)) <= 32) good++;
    }
  }
  return tot ? good / tot : 0;
}

/**
 * 这张图是不是放大过的像素画（每个“像素”是一个 p×p 的同色小方块）。
 * 是的话返回 { px, ox, py, oy, U }：像素格的边长、起点，U = 每格中间同色的比例；不是返回 null。
 */
export function detectPixelGrid(img) {
  const { width: W, height: H } = img;
  if (W < 24 || H < 24) return null;
  const { ex, ey } = edgeProfiles(img);
  const gx = axisPeriod(ex, W), gy = axisPeriod(ey, H);
  if (!gx || !gy) return null;
  if (Math.abs(gx.p - gy.p) > 0.06 * Math.max(gx.p, gy.p)) return null; // 像素应该是正方形
  const U = blockUniformity(img, gx, gy);
  if (U < 0.8) return null;
  return { px: gx.p, ox: gx.o, py: gy.p, oy: gy.o, U };
}

/** 把一个框对齐到像素格（一格至少六成在框里才算）：{ x, y, w, h, cols, rows } */
export function snapToGrid(g, rect) {
  const ax = (o, p, a, b) => {
    const k0 = Math.ceil((a - o) / p - 0.4), k1 = Math.floor((b - o) / p - 0.6);
    return { s: o + k0 * p, n: Math.max(0, k1 - k0 + 1) };
  };
  const X = ax(g.ox, g.px, rect.x, rect.x + rect.w), Y = ax(g.oy, g.py, rect.y, rect.y + rect.h);
  return { x: X.s, y: Y.s, w: X.n * g.px, h: Y.n * g.py, cols: X.n, rows: Y.n };
}

/** 不透明部分的范围（透明背景的 PNG 只框有东西的地方） */
export function opaqueBounds(img) {
  const { data: d, width: W, height: H } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] < OPA) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function hasTransparency(img) {
  const d = img.data;
  const step = Math.max(1, Math.floor(d.length / 4 / 200000)) * 4;
  for (let i = 3; i < d.length; i += step) if (d[i] < OPA) return true;
  return false;
}

// ---------- 每格取色 ----------

/**
 * 每格的颜色：格子里（像素画只看每格中间一半）的像素取各通道中位数，再把和中位色差不多的像素平均。
 * mask（可选，和 img 一样大）：线条上的像素。给了的话每格分开算：线条像素占多少（lineFrac）、线条的颜色（lineRgb），
 * 底色还是用所有像素的代表色（中位数附近，线条只占一小部分时不会被拉暗）。
 * 返回 { rgb: Float32Array(N×3), alpha: Float32Array(N), lineFrac?, lineRgb? }（alpha = 不透明像素的比例）
 */
export function sampleCells(img, rect, cols, rows, { inner = false, mask = null } = {}) {
  const { data: d, width: W, height: H } = img;
  const N = cols * rows;
  const rgb = new Float32Array(N * 3), alpha = new Float32Array(N);
  const lineFrac = mask ? new Float32Array(N) : null, lineRgb = mask ? new Float32Array(N * 3) : null;
  const fx = rect.w / cols, fy = rect.h / rows, sh = inner ? 0.25 : 0;
  const MAXS = 1600;
  const R = new Uint8Array(MAXS), G = new Uint8Array(MAXS), B = new Uint8Array(MAXS);
  const LR = new Uint8Array(MAXS), LG = new Uint8Array(MAXS), LB = new Uint8Array(MAXS);
  const span = (a, b, n) => {
    let i0 = Math.ceil(a - 0.5), i1 = Math.ceil(b - 0.5) - 1;
    if (i1 < i0) i0 = i1 = Math.floor((a + b) / 2);
    return [Math.max(0, Math.min(n - 1, i0)), Math.max(0, Math.min(n - 1, i1))];
  };
  /** 一堆像素的代表色：各通道中位数附近的平均；中位数拼出了一个没有的颜色时取“最有代表性”的那个像素 */
  const typical = (R, G, B, n) => {
    const mr = R.slice(0, n).sort()[n >> 1], mg = G.slice(0, n).sort()[n >> 1], mb = B.slice(0, n).sort()[n >> 1];
    const near = (r0, g0, b0) => {
      let sr = 0, sgc = 0, sb = 0, k = 0;
      for (let j = 0; j < n; j++) {
        if (Math.max(Math.abs(R[j] - r0), Math.abs(G[j] - g0), Math.abs(B[j] - b0)) > 40) continue;
        sr += R[j]; sgc += G[j]; sb += B[j]; k++;
      }
      return k ? [sr / k, sgc / k, sb / k, k] : null;
    };
    let m = near(mr, mg, mb);
    if (!m || m[3] < n * 0.3) {
      // 各通道的中位数拼出了一个格子里没有的颜色（两种颜色差不多各占一半时，比如红 + 蓝 → 紫）：
      // 改取“离其他像素最近”的那个像素的颜色（中心点），只在格子里本来就有的颜色里选
      const step = Math.max(1, Math.floor(n / 64));
      let bj = 0, bv = Infinity;
      for (let a = 0; a < n; a += step) {
        let t = 0;
        for (let c2 = 0; c2 < n; c2 += step) t += Math.max(Math.abs(R[a] - R[c2]), Math.abs(G[a] - G[c2]), Math.abs(B[a] - B[c2]));
        if (t < bv) { bv = t; bj = a; }
      }
      m = near(R[bj], G[bj], B[bj]) || [R[bj], G[bj], B[bj]];
    }
    return m;
  };
  for (let r = 0; r < rows; r++) {
    const [y0, y1] = span(rect.y + (r + sh) * fy, rect.y + (r + 1 - sh) * fy, H);
    const stY = Math.max(1, Math.round((y1 - y0 + 1) / 16));
    for (let c = 0; c < cols; c++) {
      const [x0, x1] = span(rect.x + (c + sh) * fx, rect.x + (c + 1 - sh) * fx, W);
      const stX = Math.max(1, Math.round((x1 - x0 + 1) / 16));
      let n = 0, nl = 0, all = 0;
      for (let y = y0; y <= y1; y += stY) {
        for (let x = x0; x <= x1; x += stX) {
          all++;
          const q = (y * W + x) * 4;
          if (d[q + 3] < OPA || n + nl >= MAXS) continue;
          if (mask && mask[y * W + x]) { LR[nl] = d[q]; LG[nl] = d[q + 1]; LB[nl] = d[q + 2]; nl++; }
          else { R[n] = d[q]; G[n] = d[q + 1]; B[n] = d[q + 2]; n++; }
        }
      }
      const i = r * cols + c;
      alpha[i] = all ? (n + nl) / all : 0;
      if (!n && !nl) continue;
      if (mask) {
        lineFrac[i] = nl / (n + nl);
        if (nl) { const t = typical(LR, LG, LB, nl); lineRgb[i * 3] = t[0]; lineRgb[i * 3 + 1] = t[1]; lineRgb[i * 3 + 2] = t[2]; }
      }
      // 底色：所有像素的代表色（中位数附近：只压了一点线条的格子不会被拉暗；线条格另外用 lineRgb）
      if (nl) { for (let j = 0; j < nl; j++) { R[n + j] = LR[j]; G[n + j] = LG[j]; B[n + j] = LB[j]; } }
      const m = typical(R, G, B, n + nl);
      rgb[i * 3] = m[0]; rgb[i * 3 + 1] = m[1]; rgb[i * 3 + 2] = m[2];
    }
  }
  return { rgb, alpha, lineFrac, lineRgb };
}

// ---------- 线条 ----------

/** 一维滑动最大 / 最小（单调队列，O(n)），半径 r */
function slide(src, dst, n, stride, off, r, isMax) {
  const q = new Int32Array(n);
  let h = 0, t = 0;
  const better = isMax ? (a, b) => a >= b : (a, b) => a <= b;
  for (let i = 0; i < n + r; i++) {
    if (i < n) {
      const v = src[off + i * stride];
      while (t > h && better(v, src[off + q[t - 1] * stride])) t--;
      q[t++] = i;
    }
    const c = i - r;
    if (c >= 0) {
      while (q[h] < c - r) h++;
      dst[off + c * stride] = src[off + q[h] * stride];
    }
  }
}
function morph(L, W, H, r, isMax) {
  const a = new Float32Array(W * H), b = new Float32Array(W * H);
  for (let y = 0; y < H; y++) slide(L, a, W, 1, y * W, r, isMax);
  for (let x = 0; x < W; x++) slide(a, b, H, W, x, r, isMax);
  return b;
}

/**
 * 线条（轮廓线、描边）：比两边都暗、宽度不到一格左右的细长结构（灰度“闭运算 − 原图”，也叫黑帽变换）。
 * 太小的、不够长的一点点（纹理、噪点）不算。cellPx：一格多少像素。返回 Uint8Array（1 = 线条上的像素）
 */
export function lineMask(img, cellPx, { T = 40 } = {}) {
  const { data: d, width: W, height: H } = img;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const q = i * 4;
    // 透明的地方当成白色：透明背景上的深色描边也算线条
    L[i] = d[q + 3] < OPA ? 255 : 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
  }
  const r = Math.max(1, Math.round(cellPx * 0.6));
  const close = morph(morph(L, W, H, r, true), W, H, r, false);
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (close[i] - L[i] > T) mask[i] = 1;
  // 去掉小点点：面积不到半格、也不够长的连通块
  const seen = new Uint8Array(W * H), stack = [], comp = [];
  const minArea = cellPx * cellPx * 0.6, minLen = cellPx * 2.5;
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    comp.length = 0; stack.push(s0); seen[s0] = 1;
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    while (stack.length) {
      const i = stack.pop(); comp.push(i);
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length < minArea || Math.max(x1 - x0, y1 - y0) + 1 < minLen) for (const i of comp) mask[i] = 0;
  }
  return mask;
}

/**
 * 格子级的线条：线条像素占到一定比例的格子；同一条线压在两排格子上时，留压得多的那排（不让线条变成两格粗），
 * 但不能把线条拆断（只去掉“去掉后周围的线条格还连着”的格子）。
 */
export function lineCells(frac, active, cols, rows, th = 0.15) {
  const N = cols * rows, isL = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (active[i] && frac[i] >= th) isL[i] = 1;
  const OFF = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const simple = (r, c) => {
    // 周围 8 格里的线条格（8 连通）只有一块，而且至少有 2 格（不是线头）
    const on = OFF.map(([dx, dy]) => { const rr = r + dy, cc = c + dx; return rr >= 0 && cc >= 0 && rr < rows && cc < cols && isL[rr * cols + cc]; });
    const cnt = on.filter(Boolean).length;
    if (cnt < 2) return false;
    const seen = new Array(8).fill(false);
    let comps = 0;
    for (let k = 0; k < 8; k++) {
      if (!on[k] || seen[k]) continue;
      comps++;
      const st = [k]; seen[k] = true;
      while (st.length) {
        const a = st.pop();
        for (let b = 0; b < 8; b++) {
          if (!on[b] || seen[b]) continue;
          if (Math.max(Math.abs(OFF[a][0] - OFF[b][0]), Math.abs(OFF[a][1] - OFF[b][1])) === 1) { seen[b] = true; st.push(b); }
        }
      }
    }
    return comps === 1;
  };
  for (let pass = 0; pass < 3; pass++) {
    const order = [];
    for (let i = 0; i < N; i++) if (isL[i]) order.push(i);
    order.sort((a, b) => frac[a] - frac[b]);
    let changed = false;
    for (const i of order) {
      const r = (i / cols) | 0, c = i % cols;
      let stronger = false;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const rr = r + dy, cc = c + dx;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        // 一条线压在两排格子上：旁边那格压得不比这格少、两格加起来也不到一格半（线本来不到一格半粗），
        // 而且这一格的另一边不是线条 → 这格是两排里多出来的那排（线本来就粗的，两格都压满了，不动）
        if (isL[j] && frac[j] >= frac[i] && frac[i] + frac[j] < 1.4) {
          const or = r - dy, oc = c - dx;
          if (!(or >= 0 && oc >= 0 && or < rows && oc < cols && isL[or * cols + oc])) stronger = true;
        }
      }
      if (stronger && simple(r, c)) { isL[i] = 0; changed = true; }
    }
    if (!changed) break;
  }
  // 只有一两格的“线条”不算线条（照片里毛发、纹理的一小段）
  const seen = new Uint8Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (!isL[s0] || seen[s0]) continue;
    const comp = [s0]; seen[s0] = 1;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q], r = (i / cols) | 0, c = i % cols;
      for (const [dx, dy] of OFF) {
        const rr = r + dy, cc = c + dx;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        if (isL[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
      }
    }
    if (comp.length < 3) for (const i of comp) isL[i] = 0;
  }
  return isL;
}

// ---------- 忽略细节 ----------

/** 细节多少：精细（原样）/ 适中 / 简洁。smooth：格子级保边平滑几遍；minArea：小于这么多格的同色小块并到周围；maxDE：差多少以内才并 */
export function detailParams(detail, N) {
  const a = Math.round(2 + Math.sqrt(N) / 40);
  if (detail === 'fine') return { smooth: 0, sig: 0, minArea: 0, maxDE: 0 };
  if (detail === 'simple') return { smooth: 2, sig: 10, minArea: a * 2, maxDE: 38 };
  return { smooth: 1, sig: 8, minArea: a, maxDE: 30 };
}

/** 格子级的保边平滑（双边滤波，Lab）：一片里细小的明暗变化抹平，颜色分界不动；线条格不参与 */
function smoothCells(lab, active, isL, cols, rows, sig, passes) {
  const N = cols * rows;
  let cur = lab;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(cur);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!active[i] || isL[i]) continue;
      let w0 = 0, s0 = 0, s1 = 0, s2 = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const rr = r + dy, cc = c + dx;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        if (!active[j] || isL[j]) continue;
        const e0 = cur[j * 3] - cur[i * 3], e1 = cur[j * 3 + 1] - cur[i * 3 + 1], e2 = cur[j * 3 + 2] - cur[i * 3 + 2];
        const w = Math.exp(-(e0 * e0 + e1 * e1 + e2 * e2) / (2 * sig * sig) - (dx * dx + dy * dy) / 4.5);
        w0 += w; s0 += w * cur[j * 3]; s1 += w * cur[j * 3 + 1]; s2 += w * cur[j * 3 + 2];
      }
      out[i * 3] = s0 / w0; out[i * 3 + 1] = s1 / w0; out[i * 3 + 2] = s2 / w0;
    }
    cur = out;
  }
  return cur;
}

/**
 * 小于 minArea 格的同色小块（4 连通，线条格不算）并到周围接得最多的那种颜色（颜色差 maxDE 以内才并：
 * 一片里的杂色、细碎的明暗都并掉；眼睛、高光这种和周围差得多的留着）。pick：每格的色号序号（-1 = 空），就地改
 */
export function mergeSmall(pick, active, isL, cols, rows, palLab, minArea, maxDE) {
  if (!minArea) return;
  const N = cols * rows;
  for (let pass = 0; pass < 3; pass++) {
    const comp = new Int32Array(N).fill(-1), comps = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (comp[s0] >= 0 || pick[s0] < 0 || isL[s0]) continue;
      const k = pick[s0], cells = [s0], id = comps.length;
      comp[s0] = id;
      for (let q = 0; q < cells.length; q++) {
        const i = cells[q], r = (i / cols) | 0, c = i % cols;
        for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]) {
          if (j < 0 || comp[j] >= 0 || isL[j] || pick[j] !== k) continue;
          comp[j] = id; cells.push(j);
        }
      }
      comps.push({ k, cells });
    }
    comps.sort((a, b) => a.cells.length - b.cells.length);
    let changed = false;
    for (const cp of comps) {
      if (cp.cells.length >= minArea) break;
      const k = pick[cp.cells[0]];
      const inC = new Set(cp.cells), cnt = new Map();
      for (const i of cp.cells) {
        const r = (i / cols) | 0, c = i % cols;
        for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]) {
          if (j < 0 || inC.has(j) || pick[j] < 0 || isL[j] || pick[j] === k) continue;
          cnt.set(pick[j], (cnt.get(pick[j]) || 0) + 1);
        }
      }
      let t = -1, tn = 0, te = Infinity;
      for (const [m, n] of cnt) {
        const e = de2000(palLab[k], palLab[m]);
        if (n > tn || (n === tn && e < te)) { t = m; tn = n; te = e; }
      }
      if (t < 0 || te > maxDE) continue;
      for (const i of cp.cells) pick[i] = t;
      changed = true;
    }
    if (!changed) break;
  }
}

// ---------- 背景 ----------

/**
 * 四周一大片同一个颜色（白底、纯色底）：返回 { mask, n, rgb }（mask = 和四边连着、颜色和背景差不多的格子）。
 * 四边没有一半以上是同一个颜色，或者“背景”占了几乎整张图时返回 null。
 */
export function findBackground(lab, rgb, active, cols, rows) {
  const border = [];
  let edge = 0;
  const add = i => { edge++; if (active[i]) border.push(i); };
  for (let c = 0; c < cols; c++) { add(c); if (rows > 1) add((rows - 1) * cols + c); }
  for (let r = 1; r < rows - 1; r++) { add(r * cols); if (cols > 1) add(r * cols + cols - 1); }
  // 四周大多是透明的：透明就是背景，不用再找
  if (border.length < 8 || border.length < edge * 0.6) return null;
  const L = i => [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
  const step = Math.max(1, Math.floor(border.length / 160));
  let best = -1, bestN = 0;
  for (let a = 0; a < border.length; a += step) {
    const la = L(border[a]);
    let n = 0;
    for (const j of border) if (de2000(la, L(j)) < 6) n++;
    if (n > bestN) { bestN = n; best = border[a]; }
  }
  if (bestN < border.length * 0.5) return null;
  const ref = L(best);
  let s0 = 0, s1 = 0, s2 = 0, r0 = 0, r1 = 0, r2 = 0, m = 0;
  for (const j of border) {
    if (de2000(ref, L(j)) >= 6) continue;
    s0 += lab[j * 3]; s1 += lab[j * 3 + 1]; s2 += lab[j * 3 + 2];
    r0 += rgb[j * 3]; r1 += rgb[j * 3 + 1]; r2 += rgb[j * 3 + 2]; m++;
  }
  const bg = [s0 / m, s1 / m, s2 / m];
  const N = cols * rows, mask = new Uint8Array(N), q = [];
  const near = i => active[i] && !mask[i] && de2000(bg, L(i)) < 10;
  for (const j of border) if (near(j)) { mask[j] = 1; q.push(j); }
  while (q.length) {
    const i = q.pop(), r = (i / cols) | 0, c = i % cols;
    const nb = [];
    if (c > 0) nb.push(i - 1); if (c < cols - 1) nb.push(i + 1); if (r > 0) nb.push(i - cols); if (r < rows - 1) nb.push(i + cols);
    for (const j of nb) if (near(j)) { mask[j] = 1; q.push(j); }
  }
  let n = 0, act = 0;
  for (let i = 0; i < N; i++) { if (mask[i]) n++; if (active[i]) act++; }
  if (n > act * 0.9) return null;
  return { mask, n, rgb: [r0 / m, r1 / m, r2 / m].map(Math.round) };
}

// ---------- 换成色号 ----------

/**
 * 主函数。o：{
 *   rect, cols, rows,        要转的区域（原图坐标）和格数
 *   inner,                   像素画：只取每格中间
 *   via: { cols, rows },     像素画换成别的尺寸：rect 是原来的像素格，先按它取出每个像素
 *   pal: [[色号, r, g, b]],  能用的颜色
 *   maxColors,               最多几种颜色（0 = 不限）
 *   bg, dither,              去背景、抖动
 *   lines,                   保留线条（默认开；像素画不用）
 *   detail,                  细节多少：'fine' 精细 / 'mid' 适中（默认）/ 'simple' 简洁（旧的 clean:false 当 fine）
 *   replace: [[原色号, 换成]] 选好之后整种颜色换掉（换成的可以不在 pal 里）
 * }
 * 返回 { cols, rows, codes（颗数多的在前）, cells（Uint8Array，0 = 空，k = codes[k-1]）, counts, beads, bgFound, bgRemoved, transparent, err（平均色差） }
 */
export function convertPhoto(img, o) {
  const { cols, rows } = o;
  const N = cols * rows;
  let src = img, rect = o.rect;
  if (o.via) {
    // 像素画换成别的尺寸：先取出原来的每个像素（一格一色），再从这张小图缩放——不会在像素边上混出中间色
    const v = sampleCells(img, o.rect, o.via.cols, o.via.rows, { inner: true });
    const d = new Uint8ClampedArray(o.via.cols * o.via.rows * 4);
    for (let i = 0; i < o.via.cols * o.via.rows; i++) {
      d[i * 4] = v.rgb[i * 3]; d[i * 4 + 1] = v.rgb[i * 3 + 1]; d[i * 4 + 2] = v.rgb[i * 3 + 2]; d[i * 4 + 3] = v.alpha[i] >= 0.5 ? 255 : 0;
    }
    src = { data: d, width: o.via.cols, height: o.via.rows };
    rect = { x: 0, y: 0, w: o.via.cols, h: o.via.rows };
  }
  // 照片、插画（不是像素画）：先找出线条（轮廓线、描边），线条格保持线条本来的颜色、连成一条；其余格子按“细节多少”抹掉细碎的东西
  const photo = !o.inner && !o.via;
  const cellPx = Math.min(rect.w / cols, rect.h / rows);
  const wantLines = photo && o.lines !== false && cellPx >= 3;
  const detail = !photo ? 'fine' : o.detail || (o.clean === false ? 'fine' : 'mid');
  const DP = { ...detailParams(detail, N), ...(o.dp || {}) };
  const s = sampleCells(src, rect, cols, rows, { inner: !!o.inner, mask: wantLines ? lineMask(src, cellPx) : null });
  const lab = new Float32Array(N * 3), active = new Uint8Array(N);
  let transparent = 0;
  for (let i = 0; i < N; i++) {
    if (s.alpha[i] < 0.5) { transparent++; continue; }
    active[i] = 1;
  }
  const isL = wantLines ? lineCells(s.lineFrac, active, cols, rows) : new Uint8Array(N);
  const rgbC = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    const src3 = isL[i] ? s.lineRgb : s.rgb;
    rgbC[i * 3] = src3[i * 3]; rgbC[i * 3 + 1] = src3[i * 3 + 1]; rgbC[i * 3 + 2] = src3[i * 3 + 2];
    const L = rgbToLab([rgbC[i * 3], rgbC[i * 3 + 1], rgbC[i * 3 + 2]]);
    lab[i * 3] = L[0]; lab[i * 3 + 1] = L[1]; lab[i * 3 + 2] = L[2];
  }
  const bgInfo = findBackground(lab, rgbC, active, cols, rows);
  let bgRemoved = 0;
  if (bgInfo && o.bg) for (let i = 0; i < N; i++) if (bgInfo.mask[i]) { active[i] = 0; isL[i] = 0; bgRemoved++; }
  let nLine = 0;
  for (let i = 0; i < N; i++) nLine += isL[i];
  // 忽略细节：格子级保边平滑（细碎的明暗变化抹平，颜色分界、线条不动）
  if (DP.smooth) lab.set(smoothCells(lab, active, isL, cols, rows, DP.sig, DP.smooth));
  const base = { cols, rows, bgFound: !!bgInfo, bgRgb: bgInfo?.rgb || null, bgRemoved, transparent, lineCells: nLine, detail };
  let nAct = 0;
  for (let i = 0; i < N; i++) nAct += active[i];
  if (!nAct) return { ...base, error: transparent === N ? '图上全是透明的，没有可以拼的部分' : '去掉背景后什么都不剩了（可以关掉“去掉背景”）', codes: [], cells: new Uint8Array(N), counts: [], beads: 0 };
  const pal = o.pal || [];
  if (!pal.length) throw new Error('没有可以用的颜色');
  const M = pal.length;
  const palLab = pal.map(p => rgbToLab([p[1], p[2], p[3]]));

  // 一样（差不多一样）的颜色只算一次（Lab 每 3 个单位一档；线条格单独一档）。
  // 线条格的权重大一些：限颜色数时线条的颜色（往往只有几十格）也留得住
  const LW = 4;
  const bin = new Map(), cellU = new Int32Array(N).fill(-1);
  const uacc = [];
  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    const key = `${isL[i]}|${Math.round(lab[i * 3] / 3)}|${Math.round(lab[i * 3 + 1] / 3)}|${Math.round(lab[i * 3 + 2] / 3)}`;
    let u = bin.get(key);
    if (u == null) { u = uacc.length; bin.set(key, u); uacc.push([0, 0, 0, 0, 0]); }
    const a = uacc[u];
    a[0] += lab[i * 3]; a[1] += lab[i * 3 + 1]; a[2] += lab[i * 3 + 2]; a[3]++; a[4] += isL[i] ? LW : 1;
    cellU[i] = u;
  }
  const U = uacc.length;
  const ulab = uacc.map(a => [a[0] / a[3], a[1] / a[3], a[2] / a[3]]), uw = uacc.map(a => a[4]);
  // 每个颜色到每个色号的色差（平方）
  const D = new Float32Array(U * M);
  for (let u = 0; u < U; u++) for (let m = 0; m < M; m++) { const e = de2000(ulab[u], palLab[m]); D[u * M + m] = e * e; }

  const nearestIn = (u, S) => { let b = -1, bv = Infinity; for (const m of S) { const v = D[u * M + m]; if (v < bv) { bv = v; b = m; } } return b; };
  let S = new Set();
  const all = Array.from({ length: M }, (_, m) => m);
  for (let u = 0; u < U; u++) S.add(nearestIn(u, all));

  const K = o.maxColors > 0 ? o.maxColors : 0;
  if (!K) {
    // 不限颜色数：几乎一样的两个色号（比如两种白）只留用得多的那个；
    // 差一点点、又只有零星几颗的（压缩噪点让几格偏到隔壁色号）也并过去
    const wOf = new Map();
    for (let u = 0; u < U; u++) { const m = nearestIn(u, S); wOf.set(m, (wOf.get(m) || 0) + uw[u]); }
    const order = [...S].sort((a, b) => (wOf.get(a) || 0) - (wOf.get(b) || 0));
    for (const a of order) {
      if (S.size <= 1) break;
      const wa = wOf.get(a) || 0;
      for (const b of S) {
        if (b === a) continue;
        const wb = wOf.get(b) || 0, e = de2000(palLab[a], palLab[b]);
        if ((e < 3.2 && wb >= wa) || (e < 5 && wa < wb * 0.2)) { S.delete(a); wOf.set(b, wb + wa); break; }
      }
    }
  } else if (S.size > K) {
    // 贪心：每次去掉“去掉了总误差增加最少”的颜色
    const b1 = new Int32Array(U), b2 = new Int32Array(U);
    const two = u => {
      let a = -1, av = Infinity, b = -1, bv = Infinity;
      for (const m of S) { const v = D[u * M + m]; if (v < av) { b = a; bv = av; a = m; av = v; } else if (v < bv) { b = m; bv = v; } }
      b1[u] = a; b2[u] = b;
    };
    for (let u = 0; u < U; u++) two(u);
    const cost = new Float64Array(M);
    while (S.size > K) {
      cost.fill(0);
      for (let u = 0; u < U; u++) cost[b1[u]] += uw[u] * (D[u * M + b2[u]] - D[u * M + b1[u]]);
      let rm = -1, rv = Infinity;
      for (const m of S) if (cost[m] < rv) { rv = cost[m]; rm = m; }
      S.delete(rm);
      for (let u = 0; u < U; u++) if (b1[u] === rm || b2[u] === rm) two(u);
    }
  }
  if (K) {
    // 交替调整：每一类换成让这一类误差最小的色号（只能是色卡里的颜色），再重新分类
    for (let it = 0; it < 12; it++) {
      const list = [...S], idx = new Map(list.map((m, k) => [m, k]));
      const acc = new Float64Array(list.length * M);
      for (let u = 0; u < U; u++) {
        const k = idx.get(nearestIn(u, list)), w = uw[u], row = u * M, base2 = k * M;
        for (let m = 0; m < M; m++) acc[base2 + m] += w * D[row + m];
      }
      let changed = false;
      const next = new Set(list);
      for (let k = 0; k < list.length; k++) {
        const cur = list[k];
        let b = cur, bv = acc[k * M + cur];
        for (let m = 0; m < M; m++) if (!next.has(m) && acc[k * M + m] < bv - 1e-6) { bv = acc[k * M + m]; b = m; }
        if (b !== cur) { next.delete(cur); next.add(b); changed = true; }
      }
      S = next;
      if (!changed) break;
    }
  }

  // 每格定色号
  const Sl = [...S];
  const pick = new Int32Array(N).fill(-1);
  if (o.dither) {
    // 误差扩散（Floyd–Steinberg，蛇形扫描，在 Lab 里算；误差打个折、限个幅，免得一片都是噪点）
    const err = new Float32Array(N * 3);
    const lim = v => Math.max(-30, Math.min(30, v));
    for (let r = 0; r < rows; r++) {
      const rev = r & 1;
      for (let cc = 0; cc < cols; cc++) {
        const c = rev ? cols - 1 - cc : cc, i = r * cols + c;
        if (!active[i]) continue;
        // 线条格不掺：直接取最接近的色号，误差也不往外扩散
        if (isL[i]) { pick[i] = nearestIn(cellU[i], Sl); continue; }
        const t = [lab[i * 3] + lim(err[i * 3]), lab[i * 3 + 1] + lim(err[i * 3 + 1]), lab[i * 3 + 2] + lim(err[i * 3 + 2])];
        let b = Sl[0], bv = Infinity;
        for (const m of Sl) { const v = de2000(t, palLab[m]); if (v < bv) { bv = v; b = m; } }
        pick[i] = b;
        const e = [0, 1, 2].map(k => (t[k] - palLab[b][k]) * 0.8);
        const dx = rev ? -1 : 1;
        const spread = (rr, c2, f) => {
          if (rr >= rows || c2 < 0 || c2 >= cols) return;
          const j = rr * cols + c2;
          if (!active[j] || isL[j]) return;
          err[j * 3] += e[0] * f; err[j * 3 + 1] += e[1] * f; err[j * 3 + 2] += e[2] * f;
        };
        spread(r, c + dx, 7 / 16); spread(r + 1, c - dx, 3 / 16); spread(r + 1, c, 5 / 16); spread(r + 1, c + dx, 1 / 16);
      }
    }
  } else {
    const best = new Int32Array(U);
    for (let u = 0; u < U; u++) best[u] = nearestIn(u, Sl);
    for (let i = 0; i < N; i++) if (active[i]) pick[i] = best[cellU[i]];
    // 忽略细节：小块的同色并到周围（线条格不动）
    mergeSmall(pick, active, isL, cols, rows, palLab, DP.minArea, DP.maxDE);
  }

  // 平均色差（看效果用）
  let es = 0, en = 0;
  for (let i = 0; i < N; i++) if (pick[i] >= 0) { es += de2000([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]], palLab[pick[i]]); en++; }

  // 色号、整种颜色替换、按颗数排
  const repl = new Map(o.replace || []);
  const codeOfCell = new Array(N).fill(null);
  const cnt = new Map();
  for (let i = 0; i < N; i++) {
    if (pick[i] < 0) continue;
    let code = pal[pick[i]][0];
    for (let g = 0; g < 4 && repl.has(code); g++) code = repl.get(code);
    codeOfCell[i] = code;
    cnt.set(code, (cnt.get(code) || 0) + 1);
  }
  const codes = [...cnt].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(x => x[0]);
  const at = new Map(codes.map((c, k) => [c, k + 1]));
  const cells = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (codeOfCell[i]) cells[i] = at.get(codeOfCell[i]);
  const counts = codes.map(c => cnt.get(c));
  return { ...base, codes, cells, counts, beads: counts.reduce((a, b) => a + b, 0), err: en ? es / en : 0 };
}

/** 选好的尺寸（最长边几颗）→ 列数、行数 */
export function gridSize(rect, longSide) {
  const L = Math.max(1, Math.round(longSide));
  if (rect.w >= rect.h) return { cols: L, rows: Math.max(1, Math.round(L * rect.h / rect.w)) };
  return { rows: L, cols: Math.max(1, Math.round(L * rect.w / rect.h)) };
}
