// PP-OCRv5（PaddleOCR 第 5 代，mobile 版）在浏览器里跑：文字检测（DB）+ 文字识别（SVTR/CTC）。
// 纯 JS 前后处理，ONNX Runtime 由调用方注入（浏览器用 onnxruntime-web，测试时 Node 也能跑）。
// 模型：Apache-2.0，来自 PaddleOCR 官方导出的 ONNX。

/** img: { data: RGBA Uint8ClampedArray, width, height } → 双线性缩放后的 CHW Float32（BGR，按 mean/std 归一化） */
function toTensorData(img, sx, sy, sw, sh, W, H, mean, std) {
  const out = new Float32Array(3 * W * H);
  const { data, width, height } = img;
  const fx = sw / W, fy = sh / H;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(height - 1.001, Math.max(0, sy + (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(gy), ty = gy - y0, y1 = Math.min(height - 1, y0 + 1);
    for (let x = 0; x < W; x++) {
      const gx = Math.min(width - 1.001, Math.max(0, sx + (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(gx), tx = gx - x0, x1 = Math.min(width - 1, x0 + 1);
      const p00 = (y0 * width + x0) * 4, p01 = (y0 * width + x1) * 4, p10 = (y1 * width + x0) * 4, p11 = (y1 * width + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (data[p00 + c] * (1 - tx) + data[p01 + c] * tx) * (1 - ty) + (data[p10 + c] * (1 - tx) + data[p11 + c] * tx) * ty;
        // 模型按 BGR 训练：输出通道 0=B,1=G,2=R
        const oc = 2 - c;
        out[oc * W * H + y * W + x] = (v / 255 - mean[oc]) / std[oc];
      }
    }
  }
  return out;
}

/**
 * recMinW：识别时把一行字的张量补宽到至少这么宽（PP-OCRv6 按 48×320 训练，短的一行字右边补 0 更准；v5 mobile 不需要）
 */
export async function createPPOCR({ ort, det, rec, dict, recMinW = 0 }) {
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [detS, recS] = await Promise.all([
    det ? ort.InferenceSession.create(det, opts) : null,
    ort.InferenceSession.create(rec, opts),
  ]);
  // 字典：0 = CTC 空白，1..n = 字典里的字，n+1 = 空格
  const chars = ['', ...dict.split(/\r?\n/).filter((c, i, a) => !(i === a.length - 1 && c === '')), ' '];
  const index = new Map(chars.map((c, i) => [c, i]));

  /** 检测文字框。返回 [{ x0, y0, x1, y1, score }]（原图坐标） */
  async function detect(img, { region = null, maxSide = 1280, thresh = 0.3, boxThresh = 0.5, unclip = 1.6 } = {}) {
    if (!detS) throw new Error('没有加载检测模型');
    const R = region || { x: 0, y: 0, w: img.width, h: img.height };
    const k = Math.min(1, maxSide / Math.max(R.w, R.h));
    const W = Math.max(32, Math.round(R.w * k / 32) * 32), H = Math.max(32, Math.round(R.h * k / 32) * 32);
    const t = new ort.Tensor('float32', toTensorData(img, R.x, R.y, R.w, R.h, W, H, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), [1, 3, H, W]);
    const out = (await detS.run({ [detS.inputNames[0]]: t }))[detS.outputNames[0]];
    const P = out.data; // 1×1×H×W 概率图
    // 连通域（4 邻接）→ 外接矩形
    const lab = new Int32Array(W * H).fill(-1);
    const boxes = [];
    const stack = [];
    for (let i = 0; i < W * H; i++) {
      if (P[i] <= thresh || lab[i] >= 0) continue;
      let x0 = W, y0 = H, x1 = -1, y1 = -1, sum = 0, n = 0;
      lab[i] = boxes.length; stack.push(i);
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j / W) | 0;
        sum += P[j]; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const q of [j - 1, j + 1, j - W, j + W]) {
          if (q < 0 || q >= W * H || lab[q] >= 0 || P[q] <= thresh) continue;
          if ((q === j - 1 && x === 0) || (q === j + 1 && x === W - 1)) continue;
          lab[q] = boxes.length; stack.push(q);
        }
      }
      const score = sum / n;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (score < boxThresh || Math.min(bw, bh) < 3) { boxes.push(null); continue; }
      // DB 的“膨胀”：按 面积×比例/周长 往外扩
      const d = bw * bh * unclip / (2 * (bw + bh));
      boxes.push({
        x0: R.x + Math.max(0, x0 - d) / W * R.w, y0: R.y + Math.max(0, y0 - d) / H * R.h,
        x1: R.x + Math.min(W, x1 + 1 + d) / W * R.w, y1: R.y + Math.min(H, y1 + 1 + d) / H * R.h, score,
      });
    }
    return boxes.filter(Boolean);
  }

  /**
   * 识别一个框里的一行字。allow：只允许这些字（其余字的概率置零，“封闭字表”）。
   * 返回 { text, conf, chars:[{ ch, x, p }], logp（每帧对数概率，给 lexiconScore 用）, T, C }
   */
  async function recognize(img, box, { allow = null, keepLogits = false } = {}) {
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const H = 48;
    const W = Math.max(16, Math.min(1600, Math.round(H * bw / bh / 8) * 8));
    let data = toTensorData(img, box.x0, box.y0, bw, bh, W, H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), Wt = W;
    if (recMinW > W) {
      // 右边补 0（归一化后的 0，也就是中灰），和训练时的做法一样
      Wt = recMinW;
      const pad = new Float32Array(3 * H * Wt);
      for (let c = 0; c < 3; c++) for (let y = 0; y < H; y++) pad.set(data.subarray((c * H + y) * W, (c * H + y + 1) * W), (c * H + y) * Wt);
      data = pad;
    }
    const t = new ort.Tensor('float32', data, [1, 3, H, Wt]);
    const out = (await recS.run({ [recS.inputNames[0]]: t }))[recS.outputNames[0]];
    const [, T, C] = out.dims;
    const A = out.data;
    const allowIdx = allow ? [0, ...[...new Set(allow)].map(c => index.get(c)).filter(i => i != null)] : null;
    let text = '', ps = [], prev = 0;
    const cs = [];
    for (let t2 = 0; t2 < T; t2++) {
      const row = t2 * C;
      let bi = 0, bv = -1;
      if (allowIdx) { for (const i of allowIdx) if (A[row + i] > bv) { bv = A[row + i]; bi = i; } }
      else for (let i = 0; i < C; i++) if (A[row + i] > bv) { bv = A[row + i]; bi = i; }
      if (bi && bi !== prev) { text += chars[bi]; ps.push(bv); cs.push({ ch: chars[bi], x: box.x0 + Math.min(bw, (t2 + 0.5) / T * Wt / W * bw), p: bv }); }
      prev = bi;
    }
    const conf = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    const res = { text, conf, chars: cs };
    if (keepLogits) { res.probs = A; res.T = T; res.C = C; }
    return res;
  }

  /** CTC：给定一串字，算它的对数概率（前向算法）。用于“在几个候选色号里挑最像的” */
  function lexiconScore(r, word) {
    const { probs: A, T, C } = r;
    const lab = [0];
    for (const ch of word) { const i = index.get(ch); if (i == null) return -Infinity; lab.push(i, 0); }
    const S = lab.length;
    const lp = (t, s) => Math.log(Math.max(1e-12, A[t * C + lab[s]]));
    let a = new Float64Array(S).fill(-Infinity);
    a[0] = lp(0, 0); if (S > 1) a[1] = lp(0, 1);
    const lse = (x, y) => (x === -Infinity ? y : y === -Infinity ? x : Math.max(x, y) + Math.log1p(Math.exp(-Math.abs(x - y))));
    for (let t = 1; t < T; t++) {
      const b = new Float64Array(S).fill(-Infinity);
      for (let s = 0; s < S; s++) {
        let v = a[s];
        if (s > 0) v = lse(v, a[s - 1]);
        if (s > 1 && lab[s] !== 0 && lab[s] !== lab[s - 2]) v = lse(v, a[s - 2]);
        b[s] = v + lp(t, s);
      }
      a = b;
    }
    return lse(a[S - 1], S > 1 ? a[S - 2] : -Infinity);
  }

  return { detect, recognize, lexiconScore, chars };
}
