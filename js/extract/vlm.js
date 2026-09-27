// 云端视觉大模型：Anthropic Claude / OpenAI / Google Gemini。
// 两种连接方式：
//   direct —— 手机直接调用服务商 API，API Key 存在手机本地
//   proxy  —— 调用你自己部署的 Cloudflare Worker，由 Worker 保管 API Key（见 worker/ 目录）
import { cropCanvas, fitCanvas, toJpegBase64, makeCanvas } from '../image.js';
import { codeRuleText } from '../palette.js';

const MAX_SIDE = 1568; // Claude 超过这个长边会被缩小；另外两家也足够

const legendRules = () => `This is a screenshot of a perler / fuse bead pattern (拼豆图纸).
Somewhere in it there is a color legend (色号清单): a list of entries, each with a bead color code and the number of beads needed.
Color codes are a letter prefix followed by digits (e.g. A11, H7, M15, P23, R8). Valid codes in the user's palette: ${codeRuleText()}.
Counts may be printed as "x68", "×68", "(2606)", "68", or under / beside the color swatch.
Rules:
- Read ONLY the legend entries. Ignore codes printed inside the pattern grid cells, row/column index numbers, watermarks, page numbers ("1/5"), author names.
- Ignore non-color entries such as 空 (empty cells), 全 / 全部 / 总计 / 合计 (totals).
- Copy codes and counts exactly as printed. Never invent entries. If a code or number is hard to read, give your best reading and set "uncertain": true.
- If the image states a total bead count (e.g. "共696颗", "878 豆") or a number of colors (e.g. "12色", "8 色号"), report them; otherwise use 0.`;

function boxNote(provider) {
  return provider === 'gemini'
    ? 'For each entry, "box" is the bounding box of that entry\'s color swatch as [ymin, xmin, ymax, xmax], normalized to 0-1000 of this image.'
    : 'For each entry, "box" is the bounding box of that entry\'s color swatch as [x0, y0, x1, y1], normalized to 0-1000 of this image (x to the right, y downward).';
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          count: { type: 'integer' },
          box: { type: 'array', items: { type: 'integer' } },
          uncertain: { type: 'boolean' },
        },
        required: ['code', 'count', 'box', 'uncertain'],
        additionalProperties: false,
      },
    },
    stated_total: { type: 'integer' },
    stated_colors: { type: 'integer' },
  },
  required: ['items', 'stated_total', 'stated_colors'],
  additionalProperties: false,
};

const LOCATE_SCHEMA = {
  type: 'object',
  properties: {
    legend_box: { type: 'array', items: { type: 'integer' } },
    stated_total: { type: 'integer' },
    stated_colors: { type: 'integer' },
  },
  required: ['legend_box', 'stated_total', 'stated_colors'],
  additionalProperties: false,
};

function toGeminiSchema(s) {
  const map = { object: 'OBJECT', array: 'ARRAY', string: 'STRING', integer: 'INTEGER', boolean: 'BOOLEAN', number: 'NUMBER' };
  const out = { type: map[s.type] };
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.required = s.required;
  }
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

export class ApiError extends Error {
  constructor(message, status, detail) { super(message); this.status = status; this.detail = detail; }
}

function explain(status, body) {
  const msg = body?.error?.message || body?.message || (typeof body === 'string' ? body.slice(0, 200) : '');
  if (status === 401 || status === 403) return `鉴权失败（${status}）：API Key 或 Worker 口令不对。${msg}`;
  if (status === 404) return `找不到模型或地址（404）：检查模型名称 / Worker 地址。${msg}`;
  if (status === 429) return `请求太频繁或额度用完（429）。${msg}`;
  if (status === 400) return `请求被拒绝（400）：${msg}`;
  return `服务返回错误 ${status}：${msg}`;
}

async function postJSON(url, headers, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('连不上服务：请检查网络；若用 Worker 代理，检查地址是否正确、是否已部署。', 0, String(e));
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) throw new ApiError(explain(res.status, json || text), res.status, json || text);
  return json;
}

/** 从模型文字输出里抠出 JSON（兜底用） */
export function extractJSON(text) {
  if (!text) throw new Error('模型没有返回内容');
  const t = text.replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('模型返回的不是 JSON：' + text.slice(0, 120));
  return JSON.parse(t.slice(a, b + 1));
}

function endpoint(cfg, provider, model) {
  const proxy = cfg.mode === 'proxy';
  const base = proxy ? cfg.workerUrl.replace(/\/+$/, '') + '/' + provider : null;
  const key = cfg.apiKeys?.[provider] || '';
  const tokenHeader = proxy ? { 'x-proxy-token': cfg.workerToken } : {};
  if (provider === 'anthropic') {
    return {
      url: (proxy ? base : 'https://api.anthropic.com') + '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01', ...(proxy ? tokenHeader : { 'x-api-key': key, 'anthropic-dangerous-direct-browser-access': 'true' }) },
    };
  }
  if (provider === 'openai') {
    return {
      url: (proxy ? base : 'https://api.openai.com') + '/v1/chat/completions',
      headers: proxy ? tokenHeader : { authorization: `Bearer ${key}` },
    };
  }
  if (provider === 'gemini') {
    return {
      url: (proxy ? base : 'https://generativelanguage.googleapis.com') + `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: proxy ? tokenHeader : { 'x-goog-api-key': key },
    };
  }
  throw new Error('未知服务商 ' + provider);
}

/** 调一次模型：一张图 + 一段提示词，返回解析好的 JSON */
export async function callVision(cfg, { b64, prompt, schema, signal }) {
  const provider = cfg.provider;
  const model = (cfg.models?.[provider] || '').trim();
  if (!model) throw new Error('请在设置里填写模型名称');
  const { url, headers } = endpoint(cfg, provider, model);
  if (provider === 'anthropic') {
    const body = {
      model, max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: prompt + '\nRespond with JSON only.' },
      ] }],
      output_config: { format: { type: 'json_schema', schema } },
    };
    let json;
    try {
      json = await postJSON(url, headers, body, signal);
    } catch (e) {
      // 老模型不支持结构化输出：去掉后重试，从文字里抠 JSON
      if (e.status === 400 && /output_config|format|schema/i.test(e.message)) {
        delete body.output_config;
        json = await postJSON(url, headers, body, signal);
      } else throw e;
    }
    const text = (json.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return extractJSON(text);
  }
  if (provider === 'openai') {
    const body = {
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } },
      ] }],
      response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
    };
    const json = await postJSON(url, headers, body, signal);
    const msg = json.choices?.[0]?.message;
    if (msg?.refusal) throw new Error('模型拒绝了请求：' + msg.refusal);
    return extractJSON(msg?.content || '');
  }
  // gemini
  const body = {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
  };
  const json = await postJSON(url, headers, body, signal);
  const parts = json.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
  if (!text && json.promptFeedback?.blockReason) throw new Error('请求被 Gemini 拦截：' + json.promptFeedback.blockReason);
  return extractJSON(text);
}

/** 把模型给的 0–1000 框换成图上像素框 */
function toPixelBox(box, provider, w, h) {
  if (!Array.isArray(box) || box.length !== 4 || box.some(v => typeof v !== 'number')) return null;
  let [x0, y0, x1, y1] = provider === 'gemini' ? [box[1], box[0], box[3], box[2]] : box;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const c = v => Math.max(0, Math.min(1000, v)) / 1000;
  const r = { x0: c(x0) * w, y0: c(y0) * h, x1: c(x1) * w, y1: c(y1) * h };
  return (r.x1 - r.x0 < 2 || r.y1 - r.y0 < 2) ? null : r;
}

/**
 * 识别一张图。
 * canvas: 原图；content: 去黑边后的内容区；legendRect: 用户手动框的清单区域（可空）
 * 返回 { legendRect, items: [{ code(raw), count, box(原图坐标), uncertain }], statedTotal, statedColors }
 */
export async function vlmExtract(cfg, canvas, content, legendRect, { onStatus, signal } = {}) {
  let rect = legendRect;
  let statedTotal = 0, statedColors = 0;
  if (!rect && cfg.twoPass) {
    onStatus?.('第 1 步：让模型找到色号清单的位置…');
    const view = fitCanvas(cropCanvas(canvas, content), MAX_SIDE);
    const loc = await callVision(cfg, {
      b64: toJpegBase64(view), schema: LOCATE_SCHEMA, signal,
      prompt: `${legendRules()}\n\nTask: locate the color legend. Return "legend_box" = the bounding box that contains ALL legend entries (swatches, codes and counts), as ${cfg.provider === 'gemini' ? '[ymin, xmin, ymax, xmax]' : '[x0, y0, x1, y1]'} normalized to 0-1000 of this image. Also return stated_total and stated_colors (0 if not stated).`,
    });
    statedTotal = loc.stated_total || 0;
    statedColors = loc.stated_colors || 0;
    const b = toPixelBox(loc.legend_box, cfg.provider, content.w, content.h);
    if (b) {
      const padX = content.w * 0.02, padY = Math.max(content.h * 0.015, (b.y1 - b.y0) * 0.08);
      const x0 = Math.max(0, b.x0 - padX), y0 = Math.max(0, b.y0 - padY);
      const x1 = Math.min(content.w, b.x1 + padX), y1 = Math.min(content.h, b.y1 + padY);
      rect = { x: content.x + x0, y: content.y + y0, w: x1 - x0, h: y1 - y0 };
    }
  }
  if (!rect) rect = content;
  onStatus?.(legendRect || rect !== content ? '第 2 步：放大读取色号和数量…' : '正在读取色号和数量…');
  const k = Math.min(2, MAX_SIDE / Math.max(rect.w, rect.h));
  const view = cropCanvas(canvas, rect, k);
  const res = await callVision(cfg, {
    b64: toJpegBase64(view, 0.92), schema: EXTRACT_SCHEMA, signal,
    prompt: `${legendRules()}\n\nTask: extract every legend entry in reading order (left to right, top to bottom).\n${boxNote(cfg.provider)}`,
  });
  const items = (res.items || []).map(it => {
    const pb = toPixelBox(it.box, cfg.provider, view.width, view.height);
    return {
      rawCode: String(it.code ?? '').trim(),
      count: Number.isFinite(+it.count) && +it.count > 0 ? Math.round(+it.count) : null,
      box: pb ? { x0: rect.x + pb.x0 / k, y0: rect.y + pb.y0 / k, x1: rect.x + pb.x1 / k, y1: rect.y + pb.y1 / k } : null,
      uncertain: !!it.uncertain,
    };
  });
  return {
    legendRect: rect, items,
    statedTotal: res.stated_total || statedTotal || null,
    statedColors: res.stated_colors || statedColors || null,
  };
}

/** 设置页“测试连接”：画一张小清单图让模型读，确认 Key、模型、网络都通 */
export async function testConnection(cfg) {
  const c = makeCanvas(420, 150);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 420, 150);
  const chips = [['H7', '#000000', '#fff', 'x68'], ['A11', '#FFDD99', '#111', 'x5'], ['G14', '#8D614C', '#fff', 'x120']];
  g.font = 'bold 26px sans-serif'; g.textAlign = 'center';
  chips.forEach(([code, bg, fg, n], i) => {
    const x = 30 + i * 130;
    g.fillStyle = bg; g.strokeStyle = '#ccc'; g.fillRect(x, 20, 100, 60); g.strokeRect(x, 20, 100, 60);
    g.fillStyle = fg; g.fillText(code, x + 50, 60);
    g.fillStyle = '#222'; g.fillText(n, x + 50, 120);
  });
  const t0 = performance.now();
  const res = await callVision(cfg, {
    b64: toJpegBase64(c), schema: EXTRACT_SCHEMA,
    prompt: `${legendRules()}\n\nTask: extract every legend entry.\n${boxNote(cfg.provider)}`,
  });
  const got = (res.items || []).map(i => `${i.code}×${i.count}`).join('、');
  const ok = /H7/i.test(got) && /A11/i.test(got) && /G14/i.test(got);
  return { ok, got, ms: Math.round(performance.now() - t0) };
}
