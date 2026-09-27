// 拼豆计数器 · 云端大模型代理（Cloudflare Worker）
// 作用：API Key 只保存在 Worker 的机密变量里，手机上只存一个口令。
// 手机请求  https://<你的worker>/anthropic/v1/messages
//          https://<你的worker>/openai/v1/chat/completions
//          https://<你的worker>/gemini/v1beta/models/<模型>:generateContent
// 需要在 Cloudflare 里设置的机密变量（Settings → Variables and Secrets，类型选 Secret）：
//   PROXY_TOKEN        自己想一个长一点的口令，填到 App 设置里
//   ANTHROPIC_API_KEY  用 Claude 时填
//   OPENAI_API_KEY     用 OpenAI 时填
//   GEMINI_API_KEY     用 Gemini 时填
// 可选普通变量：ALLOWED_ORIGIN = 你的 App 网址（如 https://xxx.github.io），不填则允许任意来源（仍需口令）

const UPSTREAM = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

function cors(env, req) {
  const origin = req.headers.get('origin') || '*';
  const allow = env.ALLOWED_ORIGIN ? (origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN) : origin;
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-proxy-token, anthropic-version',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default {
  async fetch(req, env) {
    const headers = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { ...headers, 'content-type': 'application/json' } });
    if (req.method !== 'POST') return json({ error: { message: '只接受 POST' } }, 405);
    if (!env.PROXY_TOKEN || !safeEqual(req.headers.get('x-proxy-token') || '', env.PROXY_TOKEN)) {
      return json({ error: { message: '口令不对（x-proxy-token）' } }, 401);
    }
    const url = new URL(req.url);
    const [, provider, ...rest] = url.pathname.split('/');
    const base = UPSTREAM[provider];
    if (!base) return json({ error: { message: '路径应以 /anthropic、/openai 或 /gemini 开头' } }, 404);
    const path = '/' + rest.join('/');
    const allowed = { anthropic: /^\/v1\/messages$/, openai: /^\/v1\/chat\/completions$/, gemini: /^\/v1beta\/models\/[\w.\-]+:generateContent$/ };
    if (!allowed[provider].test(path)) return json({ error: { message: '不支持的接口 ' + path } }, 404);

    const out = new Headers({ 'content-type': 'application/json' });
    if (provider === 'anthropic') {
      if (!env.ANTHROPIC_API_KEY) return json({ error: { message: 'Worker 没有设置 ANTHROPIC_API_KEY' } }, 500);
      out.set('x-api-key', env.ANTHROPIC_API_KEY);
      out.set('anthropic-version', req.headers.get('anthropic-version') || '2023-06-01');
    } else if (provider === 'openai') {
      if (!env.OPENAI_API_KEY) return json({ error: { message: 'Worker 没有设置 OPENAI_API_KEY' } }, 500);
      out.set('authorization', 'Bearer ' + env.OPENAI_API_KEY);
    } else {
      if (!env.GEMINI_API_KEY) return json({ error: { message: 'Worker 没有设置 GEMINI_API_KEY' } }, 500);
      out.set('x-goog-api-key', env.GEMINI_API_KEY);
    }
    const body = await req.text();
    if (body.length > 20 * 1024 * 1024) return json({ error: { message: '图片太大' } }, 413);
    const res = await fetch(base + path, { method: 'POST', headers: out, body });
    return new Response(res.body, { status: res.status, headers: { ...headers, 'content-type': res.headers.get('content-type') || 'application/json' } });
  },
};
