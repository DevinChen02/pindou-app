// 把各种识别方法的结果统一成“核对会话”里的条目。
import { vlmExtract } from './vlm.js';
import { ocrExtract } from './ocr.js';
import { parseLegendText } from './text.js';
import { normalizeCode, deltaE, rgbOf, nearestCodes, isCode } from '../palette.js';
import { cropCanvas, toDataURL, swatchCandidates, estimateTextHeightInBoxes, thumbnail, guessLegendRect } from '../image.js';
import { putImage } from '../store.js';

let seq = 0;
export const newId = () => `i${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 为核对页保存一张“参考图”（清单区域），条目的框换算到这张图上 */
function makeDisplay(canvas, rect, pad = 12) {
  const r = {
    x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad),
    w: Math.min(canvas.width, rect.x + rect.w + pad) - Math.max(0, rect.x - pad),
    h: Math.min(canvas.height, rect.y + rect.h + pad) - Math.max(0, rect.y - pad),
  };
  const k = Math.min(2, 1400 / r.w, 2400 / r.h);
  const view = cropCanvas(canvas, r, k);
  return { dataUrl: toDataURL(view, 0.9), rect: r, k, w: view.width, h: view.height };
}

/**
 * 把整张图纸（去掉黑边）存进数据库，核对时和以后都能放大看。
 * 返回 { fullId, fw, fh, fullMap }，fullMap 把“清单参考图”上的坐标换算到整张图上：
 *   full = display × k + (ox, oy)
 */
async function saveFullImage(work, disp) {
  const c = work.content;
  // iPhone 截图（约 1320×2868）保持原尺寸：拼豆板要读每格里的小字，缩小了会读不准。
  // 几张拼成的大图也尽量保持原大小（长边到 8192、总共 1200 万像素）
  const k = work.merged ? Math.min(1, 8192 / Math.max(c.w, c.h), Math.sqrt(12e6 / (c.w * c.h)))
    : Math.min(1, 3000 / Math.max(c.w, c.h), Math.sqrt(6e6 / (c.w * c.h)));
  const view = cropCanvas(work.canvas, c, k);
  const fullId = await putImage({ dataUrl: toDataURL(view, 0.9), w: view.width, h: view.height, name: work.name });
  return {
    fullId, fw: view.width, fh: view.height,
    fullMap: disp ? { k: k / disp.k, ox: (disp.rect.x - c.x) * k, oy: (disp.rect.y - c.y) * k } : null,
  };
}

function toDisplayBox(b, disp) {
  if (!b) return null;
  return {
    x0: (b.x0 - disp.rect.x) * disp.k, y0: (b.y0 - disp.rect.y) * disp.k,
    x1: (b.x1 - disp.rect.x) * disp.k, y1: (b.y1 - disp.rect.y) * disp.k,
  };
}

/**
 * 识别一张图（云端大模型 / 离线 OCR）。
 * work: { name, canvas, content, rect }（rect 为手动框选的清单区域，可空）
 */
export async function extractImage(method, settings, work, imgIndex, { onStatus, signal } = {}) {
  let res, legendRect;
  if (method === 'vlm') {
    res = await vlmExtract(settings.methods.vlm, work.canvas, work.content, work.rect, { onStatus, signal });
    legendRect = res.legendRect;
  } else if (method === 'ocr') {
    legendRect = work.rect || work.content;
    res = await ocrExtract(settings.methods.ocr, work.canvas, legendRect, { onStatus, signal });
  } else {
    throw new Error('未知识别方法 ' + method);
  }
  const disp = makeDisplay(work.canvas, legendRect);
  let lowRes = res.lowRes;
  if (lowRes == null) {
    try {
      const hc = estimateTextHeightInBoxes(work.canvas, res.items.map(i => i.box).filter(Boolean));
      lowRes = hc != null && hc < 10;
    } catch { lowRes = false; }
  }
  const items = res.items.map(it => {
    const code = it.code !== undefined ? it.code : normalizeCode(it.rawCode);
    // 清单色块的颜色（候选几种）：核对时比色卡，生成拼豆板时直接当这一色在图上的参考色
    let swatch = null;
    if (it.box) {
      try { swatch = swatchCandidates(work.canvas, it.box, method === 'vlm' ? 0.2 : 0.1); } catch { swatch = null; }
    }
    const rgb = swatch?.[0] || null;
    return {
      id: newId(), img: imgIndex,
      code: code || null, rawCode: it.rawCode || '', count: it.count ?? null,
      box: toDisplayBox(it.box, disp), countBox: toDisplayBox(it.countBox || null, disp), rgb, swatch,
      uncertain: !!it.uncertain || lowRes,
      // 字太糊、按色卡逐个色号挑出来的：另外几个也比较像的色号（核对时给按钮）
      alts: Array.isArray(it.alts) && it.alts.length ? it.alts.slice(0, 3) : undefined,
      verified: false,
      orig: { code: code || null, count: it.count ?? null },
    };
  });
  let full = {};
  try { full = await saveFullImage(work, disp); } catch (e) { console.warn('保存原图失败', e); }
  return {
    image: {
      name: work.name, display: disp.dataUrl, dw: disp.w, dh: disp.h,
      thumb: thumbnail(cropCanvas(work.canvas, work.content), 320),
      lowRes, statedTotal: res.statedTotal || null, statedColors: res.statedColors || null,
      ...full,
    },
    items,
  };
}

/** 纯文字（实况文本 / 快捷指令） */
export function extractText(text) {
  const r = parseLegendText(text);
  return {
    items: r.items.map(it => ({
      id: newId(), img: null,
      code: it.code, rawCode: it.raw, count: it.count, box: null, rgb: null,
      uncertain: !!it.uncertain, note: it.note || '', verified: false,
      orig: { code: it.code, count: it.count },
    })),
    statedTotal: r.statedTotal, statedColors: r.statedColors,
  };
}

/** 只作参考的截图（文字方法时可选附带） */
export async function referenceImage(work) {
  // 只显示猜出来的清单区域，字更大、更好对照；整张图另存，可放大看
  let rect = work.content;
  try { rect = guessLegendRect(work.canvas, work.content); } catch { /* 用整张图 */ }
  const disp = makeDisplay(work.canvas, rect, 0);
  let full = {};
  try { full = await saveFullImage(work, disp); } catch (e) { console.warn('保存原图失败', e); }
  return {
    name: work.name, display: disp.dataUrl, dw: disp.w, dh: disp.h,
    thumb: thumbnail(cropCanvas(work.canvas, work.content), 320), lowRes: false,
    statedTotal: null, statedColors: null, ...full,
  };
}

// ---------- 核对时的检查 ----------

/** 颜色核对：图中取色 vs 色号标准色 */
export function colorCheck(item) {
  if (!item.rgb) return null;
  const suggestions = nearestCodes(item.rgb, 4).map(s => s.code);
  if (!item.code || !isCode(item.code)) return { status: 'unknown', de: null, suggestions };
  const de = deltaE(item.rgb, rgbOf(item.code));
  const status = de <= 12 ? 'match' : de <= 25 ? 'near' : 'mismatch';
  return { status, de, suggestions: suggestions.filter(c => c !== item.code) };
}

/** 一条记录的问题列表（用于标黄/标红） */
export function itemIssues(item, session) {
  const out = [];
  if (!item.code) out.push({ level: 'error', text: item.rawCode ? `“${item.rawCode}” 不在当前色卡里，请选择正确色号` : '色号没读出来，请选择色号' });
  if (item.count == null || !(item.count > 0)) out.push({ level: 'error', text: '数量没读出来，请填写' });
  if (item.code) {
    const dup = session.items.filter(o => o.code === item.code && o.img === item.img);
    if (dup.length > 1) out.push({ level: 'warn', text: '同一张图里这个色号出现了不止一次' });
  }
  const cc = colorCheck(item);
  if (cc?.status === 'mismatch') out.push({ level: 'warn', text: '图中色块的颜色和这个色号的标准色差别很大' });
  const img = item.img != null ? session.images[item.img] : null;
  if (img?.lowRes) out.push({ level: 'warn', text: '这张截图的清单字很小、有点糊，机器和人都容易看错。请在“照片”里打开原图放大对照，或向作者要高清图。' });
  else if (item.uncertain) out.push({ level: 'warn', text: '识别把握不大，请仔细看' });
  if (item.note) out.push({ level: 'warn', text: item.note });
  return out;
}

/** 多张图时，图上写明的总数相加（有一张没写就不比了） */
export function statedFromImages(images) {
  if (!images.length) return { statedTotal: null, statedColors: null };
  const allTotals = images.every(im => im.statedTotal);
  return {
    statedTotal: allTotals ? images.reduce((s, im) => s + im.statedTotal, 0) : null,
    statedColors: images.length === 1 ? images[0].statedColors || null : null,
  };
}

/** 汇总：合计颗数、色数，与图上写明的数字对比 */
export function totalsCheck(session) {
  const valid = session.items.filter(i => i.code && i.count > 0);
  const sum = valid.reduce((s, i) => s + i.count, 0);
  const colors = new Set(valid.map(i => i.code)).size;
  const st = session.statedTotal || null, sc = session.statedColors || null;
  return {
    sum, colors, statedTotal: st, statedColors: sc,
    totalOk: st ? st === sum : null,
    colorsOk: sc ? sc === colors : null,
  };
}
