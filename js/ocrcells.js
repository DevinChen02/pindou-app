// 逐格读色号：用识字模型（设置里选：PP-OCRv6 small 高精度 / PP-OCRv5 mobile 标准）把拼豆板格子上印的色号一格一格读出来。
// 每格给出“这张图纸的每个色号 + 空”的对数概率，交给归类（cells.js 的 opt.ocr）和颜色一起判断。
import { getPP } from './extract/ocr.js';

/** 格子中间那一条（去掉上下左右的边，只留印字的地方） */
export function cellTextBox(xs, ys, i) {
  const cols = xs.length - 1, r = Math.floor(i / cols), c = i % cols;
  const w = xs[c + 1] - xs[c], h = ys[r + 1] - ys[r];
  return { x0: xs[c] + w * 0.12, y0: ys[r] + h * 0.28, x1: xs[c + 1] - w * 0.12, y1: ys[r + 1] - h * 0.28 };
}

/**
 * 读 idx 里的这些格子。lex：色号（顺序和归类用的清单一样）。
 * 返回长度 = 格子数的数组：读过的格子是 [每个色号…, 空] 的对数概率，没读的是 null。
 * onProgress({ phase: 'model'|'read', done, total, progress })；signal.aborted 为真时提前停（返回已读的部分）。
 * model：REC_MODELS 的键（v6s / v5m）
 */
export async function readCells(img, xs, ys, idx, lex, { onProgress, signal, model = 'v6s' } = {}) {
  const pp = await getPP(m => onProgress?.({ phase: 'model', progress: m.progress || 0 }), model);
  const allow = [...new Set(lex.join('') + ' ')];
  const n = (xs.length - 1) * (ys.length - 1);
  const scores = new Array(n).fill(null);
  let done = 0;
  for (const i of idx) {
    if (signal?.aborted) break;
    const rec = await pp.recognize(img, cellTextBox(xs, ys, i), { allow, keepLogits: true });
    scores[i] = [...lex, ''].map(code => Math.round(pp.lexiconScore(rec, code) * 100) / 100);
    done++;
    if (done % 16 === 0) {
      onProgress?.({ phase: 'read', done, total: idx.length });
      await new Promise(r => setTimeout(r, 0)); // 让界面喘口气（进度条、停止按钮）
    }
  }
  onProgress?.({ phase: 'read', done, total: idx.length });
  return { scores, done };
}

/**
 * 读到的色号跟着拼豆板存下来（以后核对、重新认颜色时照样用上，读字的结果不会被冲掉）。
 * 每格存“每个色号比最像的那个差多少”（0–8，和归类里的上限一样），一格一串字符，很省地方。
 */
export function packOcr(scores, idx, codes) {
  const K1 = codes.length + 1, ii = [];
  let d = '';
  for (const i of idx) {
    const sc = scores[i];
    if (!sc) continue;
    let mx = -Infinity; for (const v of sc) if (v > mx) mx = v;
    ii.push(i);
    for (let k = 0; k < K1; k++) d += String.fromCharCode(35 + Math.round(Math.min(8, mx - sc[k]) * 10));
  }
  return ii.length ? { codes: [...codes], idx: ii, d } : null;
}

/** 存下来的读字结果 → 归类用的 opt.ocr（按现在的颜色清单顺序；清单里后加的颜色当“不像”） */
export function ocrOpt(board, refs) {
  const o = board?.ocr;
  if (!o?.idx?.length) return null;
  const K1o = o.codes.length + 1;
  const scores = new Array(board.rows * board.cols).fill(null);
  const map = refs.map(r => o.codes.indexOf(r.code));
  o.idx.forEach((i, j) => {
    if (i >= scores.length) return;
    const g = k => (o.d.charCodeAt(j * K1o + k) - 35) / 10;
    scores[i] = [...map.map(m => (m >= 0 ? -g(m) : -8)), -g(K1o - 1)];
  });
  return { scores, w: 8, early: true };
}
