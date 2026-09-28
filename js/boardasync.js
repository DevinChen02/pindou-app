// 拼豆板计算放到 Web Worker 里跑；Worker 用不了（老系统、加载失败）就在主线程算
let w = null;
let seq = 0;
const pending = new Map();

async function local(op, img, args) {
  const m = await import('./board.js');
  return op === 'digitize' ? m.digitize(img, args) : m.classifyGrid(img, args.xs, args.ys, args.refs, args.opt);
}

function getWorker() {
  if (w !== null) return w || null;
  try {
    w = new Worker(new URL('./boardworker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.out);
    };
    w.onerror = () => {
      // Worker 起不来：改在主线程算，已经发出去的也在主线程重算
      w = false;
      for (const [id, p] of pending) { pending.delete(id); local(p.op, p.img, p.args).then(p.resolve, p.reject); }
    };
  } catch { w = false; }
  return w || null;
}

/** op: 'digitize'（args = { region, refs, locks }）或 'classify'（args = { xs, ys, refs, opt }） */
export function runBoard(op, img, args) {
  const wk = getWorker();
  const plain = { data: img.data, width: img.width, height: img.height };
  if (!wk) return local(op, plain, args);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, op, img: plain, args });
    wk.postMessage({ id, op, img: plain, args });
  });
}
export const _workerState = () => (w === null ? 'unused' : w ? 'worker' : 'main-thread');
