// 离线 OCR：自研的分词 / 配对 + 文字识别引擎。识别引擎两种，都随应用部署、首次加载后可离线使用：
//   高精度：PP-OCRv5（vendor/ppocr + vendor/ort，约 19 MB）——示例图上明显更准，默认
//   轻量：  Tesseract（vendor/tesseract，约 7 MB）——高精度引擎加载失败时自动退回
import { analyze, wordImage, pairWords, OCR_ATTEMPTS, plausibleToken, lengthMatches } from './ocr-core.js';
import { normalizeCode, ocrWhitelist } from '../palette.js';
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

let ppPromise = null;
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

/** 加载 PP-OCRv5（ONNX Runtime Web，单线程 WASM：GitHub Pages 没有跨域隔离，用不了多线程） */
export function getPP(onProgress) {
  if (ppPromise) return ppPromise;
  ppPromise = (async () => {
    const ortBase = new URL('./vendor/ort/', location.href).href;
    const ppBase = new URL('./vendor/ppocr/', location.href).href;
    const ort = await import(/* @vite-ignore */ ortBase + 'ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = ortBase;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const [rec, dict] = await Promise.all([
      fetchBytes(ppBase + 'rec.onnx', p => onProgress?.({ status: '下载高精度识别模型', progress: p })),
      fetch(ppBase + 'dict.txt').then(r => r.text()),
    ]);
    const { createPPOCR } = await import('./ppocr.js');
    return createPPOCR({ ort, rec, dict });
  })();
  ppPromise.catch(() => { ppPromise = null; });
  return ppPromise;
}

function toCanvas(img) {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

/**
 * 识别 canvas 上 rect 区域里的色号清单。
 * 返回 { items: [{ code, rawCode, count, box(原图坐标), uncertain }], lowRes }
 */
export async function ocrExtract(settings, canvas, rect, { onStatus, signal } = {}) {
  let pp = null, worker = null, engine = settings.engine || 'ppocr';
  if (engine === 'ppocr') {
    onStatus?.('加载高精度识别引擎（PP-OCRv5）…');
    try {
      pp = await getPP(m => { if (m.progress < 1) onStatus?.(`首次使用，下载高精度识别模型…${Math.round(m.progress * 100)}%`); });
    } catch (e) {
      console.warn('PP-OCRv5 加载失败，改用 Tesseract', e);
      onStatus?.('高精度引擎加载失败，改用轻量引擎…');
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
  const ana = analyze({ data: img.data, width: img.width, height: img.height });
  const allow = [...new Set(ocrWhitelist() + ' ')];
  const words = [];
  for (let i = 0; i < ana.words.length; i++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    onStatus?.(`识别文字 ${i + 1}/${ana.words.length}…`);
    const wd = ana.words[i];
    if (pp) {
      // PP-OCRv5：直接读原图上这个词的位置（四周留一点边），只允许清单里会出现的字
      const s = ana.scale || 1, pad = Math.round((wd.hc || ana.hc) * 0.35);
      const b = {
        x0: Math.max(0, (wd.x0 - pad) / s), y0: Math.max(0, (wd.y0 - pad) / s),
        x1: Math.min(img.width, (wd.x1 + pad) / s), y1: Math.min(img.height, (wd.y1 + pad) / s),
      };
      const r = await pp.recognize(img, b, { allow });
      words.push({ ...wd, text: r.text.replace(/\s+/g, ''), conf: r.conf * 100 });
      continue;
    }
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
    words.push({ ...wd, text: best.text, conf: best.conf });
  }
  const pairs = pairWords(words, normalizeCode);
  const s = ana.scale;
  const map = b => b && { x0: rect.x + b.x0 / s, y0: rect.y + b.y0 / s, x1: rect.x + b.x1 / s, y1: rect.y + b.y1 / s };
  const items = pairs.map(p => {
    // 色块区域：色号字周围扩一圈（字在色块中间）
    const cb = map(p.codeBox);
    const h = cb.y1 - cb.y0;
    return {
      code: p.code, rawCode: p.rawCode, count: p.count, uncertain: p.uncertain,
      box: { x0: cb.x0 - h * 0.5, y0: cb.y0 - h * 0.5, x1: cb.x1 + h * 0.5, y1: cb.y1 + h * 0.5 },
      textBox: cb, countBox: map(p.countBox),
    };
  });
  return { items, lowRes: ana.hc / s < 10, charHeight: ana.hc / s, engine };
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
