// 在后台线程里数字化拼豆板（找网格 + 逐格归类要一两秒，不卡界面）
import { digitize, classifyGrid } from './board.js';

self.onmessage = e => {
  const { id, op, img, args } = e.data;
  try {
    const out = op === 'digitize' ? digitize(img, args) : classifyGrid(img, args.xs, args.ys, args.refs, args.opt);
    self.postMessage({ id, out });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
