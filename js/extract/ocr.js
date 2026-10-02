// 离线 OCR：自研的分词 / 配对 + 文字识别引擎。识别引擎两种，都随应用部署、首次加载后可离线使用：
//   PP-OCR：PP-OCRv5 mobile（vendor/ppocr + vendor/ort，约 19 MB）——示例图上明显更准，默认
//   （读拼豆板格子上的色号另外可选 PP-OCRv6 small，见 REC_MODELS）
//   Tesseract：（vendor/tesseract，约 7 MB）——PP-OCR 加载失败时自动退回
import { readLegend, refineCodes, mergeReads, wordImage, OCR_ATTEMPTS, plausibleToken, lengthMatches } from './ocr-core.js';
import { normalizeCode, ocrWhitelist, CODES, rgbOf, deltaE } from '../palette.js';
import { getImageData, makeCanvas } from '../image.js';

let workerPromise = null;
let loadedBase = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('加载 OCR 引擎失败：' + src));
    document.head.appendChild(s);
  });
}

export async function getWorker(basePath, onProgress) {
  const base = new URL(basePath.endsWith('/') ? basePath : basePath + '/', location.href).href;
  if (workerPromise && loadedBase === base) return workerPromise;
  loadedBase = base;
  workerPromise = (async () => {
    await loadScript(base + 'tesseract.min.js');
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core/',
      langPath: base + 'lang/',
      gzip: true,
      logger: m => onProgress?.(m),
    });
    await worker.setParameters({
      tessedit_char_whitelist: ocrWhitelist(),
      tessedit_pageseg_mode: '7',
      debug_file: '/dev/null',
    });
    return worker;
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

/**
 * 识字模型（都随应用部署在 vendor/ppocr/，第一次用时下载，之后离线可用；两个模型共用 dict.txt）
 *   v5m 标准：PP-OCRv5 mobile。读清单一直用它（实测读清单比 v6 small 更准）
 *   v6s 高精度：PP-OCRv6 small。读拼豆板格子上的色号明显更准（实测逐格读对 91% → 98%），慢约三成
 */
export const REC_MODELS = {
  v5m: { name: '标准', model: 'PP-OCRv5 mobile', file: 'rec.onnx', mb: 7.7 },
  v6s: { name: '高精度', model: 'PP-OCRv6 small', file: 'rec_v6s.onnx', mb: 12.2 },
};
export const ORT_MB = 11.3; // ONNX Runtime（WASM），两个模型共用，只下载一次
export const DEFAULT_CELL_MODEL = 'v6s';
/** 设置里选的“读格子色号”的模型 */
export const cellModelOf = settings => (REC_MODELS[settings?.cellModel] ? settings.cellModel : DEFAULT_CELL_MODEL);

const ppCache = new Map();
/** 按块读取，报告下载进度 */
async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败：${url}（${res.status}）`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress?.(got / total);
  }
  const out = new Uint8Array(got);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 加载识字模型（ONNX Runtime Web，单线程 WASM：GitHub Pages 没有跨域隔离，用不了多线程）。id：REC_MODELS 的键 */
export function getPP(onProgress, id = 'v5m') {
  if (!REC_MODELS[id]) id = 'v5m';
  if (ppCache.has(id)) return ppCache.get(id);
  const m = REC_MODELS[id];
  const pr = (async () => {
    const ortBase = new URL('./vendor/ort/', location.href).href;
    const ppBase = new URL('./vendor/ppocr/', location.href).href;
    const ort = await import(/* @vite-ignore */ ortBase + 'ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = ortBase;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const [rec, dict] = await Promise.all([
      fetchBytes(ppBase + m.file, p => onProgress?.({ status: `下载${m.name}识字模型`, progress: p })),
      fetch(ppBase + 'dict.txt').then(r => r.text()),
    ]);
    const { createPPOCR } = await import('./ppocr.js');
    return createPPOCR({ ort, rec, dict });
  })();
  ppCache.set(id, pr);
  pr.catch(() => ppCache.delete(id));
  return pr;
}

/** 用这个模型还要下载多少 MB（模型和 ONNX Runtime 已经缓存过的不算；0 = 已下载，离线也能用） */
export async function downloadMB(id) {
  const m = REC_MODELS[id] || REC_MODELS.v5m;
  if (!('caches' in self)) return m.mb + ORT_MB;
  const has = async f => { try { return !!(await caches.match(new URL(f, location.href).href)); } catch { return false; } };
  const [a, b] = await Promise.all([has('./vendor/ppocr/' + m.file), has('./vendor/ort/ort-wasm-simd-threaded.wasm')]);
  return Math.round(((a ? 0 : m.mb) + (b ? 0 : ORT_MB)) * 10) / 10;
}

function toCanvas(img) {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

/** 高精度模型读清单时补宽到多宽（PP-OCRv6 按 48×320 训练，短的字补宽后更准） */
const HP_MIN_W = 320;
/** 读得干净：每项都有有把握的色号、色号不重复 */
function legendClean(pairs) {
  const c = pairs.filter(p => p.count != null), codes = c.map(p => p.code).filter(Boolean);
  return c.length > 0 && c.every(p => p.code && !p.uncertain) && new Set(codes).size === codes.length;
}

/**
 * 识别 canvas 上 rect 区域里的色号清单。
 * 返回 { items: [{ code, rawCode, count, box(原图坐标), uncertain }], lowRes }
 */
export async function ocrExtract(settings, canvas, rect, { onStatus, signal } = {}) {
  let pp = null, worker = null, engine = settings.engine || 'ppocr';
  if (engine === 'ppocr') {
    onStatus?.('加载识别引擎（PP-OCR）…');
    try {
      pp = await getPP(m => { if (m.progress < 1) onStatus?.(`首次使用，下载识别模型…${Math.round(m.progress * 100)}%`); });
    } catch (e) {
      console.warn('PP-OCRv5 加载失败，改用 Tesseract', e);
      onStatus?.('PP-OCR 加载失败，改用 Tesseract…');
      engine = 'tesseract';
    }
  }
  if (!pp) {
    onStatus?.('加载离线 OCR 引擎…');
    worker = await getWorker(settings.basePath, m => {
      if (m.status && m.progress != null && m.progress < 1) onStatus?.(`加载离线 OCR 引擎…${Math.round(m.progress * 100)}%`);
    });
    await worker.setParameters({ tessedit_char_whitelist: ocrWhitelist() }); // 色卡可能被改过
  }
  onStatus?.('分析清单区域…');
  const img = getImageData(canvas, rect);
  const allow = [...new Set(ocrWhitelist() + ' ')];
  // 每个词怎么读：PP-OCR 直接读原图上这个词的位置（四周留一点边，analyze 放大过的话换回原图坐标）；
  // Tesseract 读按字高放大、二值化后的小图，换几种参数试
  const check = () => { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); };
  const ppRead = (P, minW) => async (ana, wd) => {
    check();
    const s = ana.scale || 1, pad = Math.round((wd.hc || ana.hc) * 0.35);
    const b = {
      x0: Math.max(0, (wd.x0 - pad) / s), y0: Math.max(0, (wd.y0 - pad) / s),
      x1: Math.min(img.width, (wd.x1 + pad) / s), y1: Math.min(img.height, (wd.y1 + pad) / s),
    };
    const r = await P.recognize(img, b, { allow, minW });
    return { text: r.text.replace(/\s+/g, ''), conf: r.conf * 100 };
  };
  const tessRead = async (ana, wd) => {
    check();
    let best = null;
    for (const att of OCR_ATTEMPTS) {
      await worker.setParameters({ tessedit_pageseg_mode: att.psm });
      const wi = wordImage(ana, wd, att.th, att.T ?? ana.T, att.blur, att.spread || 0);
      const { data } = await worker.recognize(toCanvas(wi));
      const r = { text: (data.text || '').trim(), conf: data.confidence, ok: plausibleToken(data.text, normalizeCode), len: lengthMatches(data.text, wd.n) };
      const rank = x => (x.ok ? 2 : 0) + (x.len ? 1 : 0);
      if (!best || rank(r) > rank(best) || (rank(r) === rank(best) && r.conf > best.conf)) best = r;
      if (r.ok && r.len && r.conf >= 75) break;
    }
    return { text: best.text, conf: best.conf };
  };
  const src = { data: img.data, width: img.width, height: img.height };
  // 字很小时原图、放大两倍各读一遍，取读得好的那次（见 readLegend；只用于 PP-OCR）
  const progress = label => {
    let pass = 0;
    return (i, n) => { if (i === 1) pass++; onStatus?.(`${label}${i}/${n}${pass > 1 ? '（字太小，放大再读一遍）' : ''}…`); };
  };
  const first = await readLegend(src, pp ? ppRead(pp) : tessRead, normalizeCode, { upscale: !!pp, onWord: progress('识别文字 ') });
  let { ana, pairs } = first;
  let s = ana.scale || 1; // pairs 的坐标是 ana 里的（放大过就是放大后的）
  // 有读不清的（色号没读出来、读得没把握、同一个色号出现两次）：换高精度模型（PP-OCRv6 small）再读一遍，
  // 色号位置上的字再按色卡里的每个色号逐个比“像不像”（加一点色块颜色），挑最像的。慢几倍，但小字、糊图读对的多很多
  if (pp && !legendClean(pairs)) {
    let hp = null;
    try {
      onStatus?.('有几项读不清，换高精度模型再读一遍…');
      hp = await getPP(m => { if (m.progress < 1) onStatus?.(`下载高精度识字模型…${Math.round(m.progress * 100)}%`); }, 'v6s');
    } catch (e) { console.warn('高精度模型加载失败，用标准模型的结果', e); }
    if (hp) {
      const b = await readLegend(src, ppRead(hp, HP_MIN_W), normalizeCode, { onWord: progress('高精度模型再读 ') });
      const codeChars = [...new Set(CODES.join('') + ' ')];
      const scoreCodes = async box => {
        check();
        const r = await hp.recognize(img, box, { allow: codeChars, keepLogits: true, minW: HP_MIN_W });
        return new Map(CODES.map(c => [c, hp.lexiconScore(r, c)]));
      };
      await refineCodes(img, b.ana, b.pairs, scoreCodes, { rgbOf, deltaE, onItem: (i, n) => onStatus?.(`逐个色号比对读不清的字 ${i}/${n}…`) });
      // 两遍合起来：以高精度这遍为主，标准模型读到、它读丢了的项补回来（合并后是原图坐标）
      pairs = mergeReads(first, b);
      ana = b.ana; s = 1;
    }
  }
  const map = b => b && { x0: rect.x + b.x0 / s, y0: rect.y + b.y0 / s, x1: rect.x + b.x1 / s, y1: rect.y + b.y1 / s };
  const items = pairs.map(p => {
    // 色块区域：色号字周围扩一圈（字在色块中间）
    const cb = map(p.codeBox);
    const h = cb.y1 - cb.y0;
    return {
      code: p.code, rawCode: p.rawCode, count: p.count, uncertain: p.uncertain, alts: p.alts,
      box: { x0: cb.x0 - h * 0.5, y0: cb.y0 - h * 0.5, x1: cb.x1 + h * 0.5, y1: cb.y1 + h * 0.5 },
      textBox: cb, countBox: map(p.countBox),
    };
  });
  const hc = ana.hc / (ana.scale || 1);
  return { items, lowRes: hc < 10, charHeight: hc, engine };
}

/** 设置页自检：画一张小图让 OCR 读，确认引擎和语言包都能加载 */
export async function testOcr(settings, onProgress) {
  const worker = (settings.engine || 'ppocr') === 'ppocr' ? await getPP(onProgress) : await getWorker(settings.basePath, onProgress);
  const c = makeCanvas(360, 140);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 360, 140);
  g.fillStyle = '#FFDD99'; g.fillRect(20, 20, 140, 50);
  g.fillStyle = '#111'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center';
  g.fillText('A11', 90, 56);
  g.fillText('x68', 90, 115);
  g.fillStyle = '#000'; g.fillRect(200, 20, 140, 50);
  g.fillStyle = '#fff'; g.fillText('H7', 270, 56);
  g.fillStyle = '#111'; g.fillText('x522', 270, 115);
  const res = await ocrExtract(settings, c, { x: 0, y: 0, w: 360, h: 140 });
  const got = res.items.map(i => `${i.code || i.rawCode}×${i.count}`).join('、');
  return { ok: /A11×68/.test(got) && /H7×522/.test(got) && res.engine === (settings.engine || 'ppocr'), got, worker: !!worker, engine: res.engine };
}
