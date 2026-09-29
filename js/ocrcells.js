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
