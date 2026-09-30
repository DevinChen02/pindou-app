// iPhone ↔ iPad 用二维码传东西：拼豆板（iPhone → iPad）、打勾进度（iPad → iPhone）。不经过任何服务器。
// 内容转成 JSON → 压缩（deflate）→ 太长就切成几段，每段一张二维码，轮流显示；扫的一方把几段拼回来。
// 每张二维码开头 7 个字节：'P' 'D'、种类、这一次的编号（2 字节，区分不同的几次）、第几段、一共几段。

export const KIND = { board: 1, progress: 2 };
const HEAD = 7;
/** 每张二维码最多带多少字节：纠错 M 级大约 version 15，屏幕拍屏幕也扫得稳（大的拼豆板分几张轮流显示） */
export const CHUNK = 380;

async function through(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** 打包：1 字节标志（0 = 没压缩，1 = deflate-raw）+ 内容 */
export async function packPayload(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  let z = null;
  try { if (typeof CompressionStream !== 'undefined') z = await through(json, new CompressionStream('deflate-raw')); } catch { z = null; }
  const body = z && z.length < json.length ? z : json;
  const out = new Uint8Array(body.length + 1);
  out[0] = body === z ? 1 : 0;
  out.set(body, 1);
  return out;
}

export async function unpackPayload(bytes) {
  const body = bytes.subarray(1);
  let raw = body;
  if (bytes[0] === 1) {
    if (typeof DecompressionStream === 'undefined') throw new Error('这台设备的系统太旧，解不开压缩的二维码（需要 iOS 16.4 以上）');
    raw = await through(body, new DecompressionStream('deflate-raw'));
  } else if (bytes[0] !== 0) throw new Error('二维码内容看不懂（可能是新版本 App 生成的，更新一下再扫）');
  return JSON.parse(new TextDecoder().decode(raw));
}

/** 切成几段二维码（每段是一串字节） */
export function toFrames(kind, payload, chunk = CHUNK) {
  const n = Math.max(1, Math.ceil(payload.length / chunk));
  if (n > 255) throw new Error('内容太大，二维码传不过去');
  const size = Math.ceil(payload.length / n); // 每段一样长：每张二维码一样大，轮流显示时不跳
  const id = (Math.random() * 65536) | 0;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const part = payload.subarray(i * size, Math.min(payload.length, (i + 1) * size));
    const f = new Uint8Array(HEAD + part.length);
    f.set([0x50, 0x44, kind, id >> 8, id & 255, i, n]);
    f.set(part, HEAD);
    frames.push(f);
  }
  return frames;
}

/**
 * 扫码的一方：一段一段收，齐了拼回完整内容。
 * add(bytes) → { err } | { got, total, payload（齐了才有） }
 * kind：想要的种类；扫到别的种类会给出提示（比如在 iPad 上扫了 iPad 自己的进度码）
 */
export function collector(kind) {
  let id = -1, total = 0, parts = [];
  return {
    get got() { return parts.filter(Boolean).length; },
    get total() { return total; },
    add(bytes) {
      if (!bytes || bytes.length < HEAD || bytes[0] !== 0x50 || bytes[1] !== 0x44) return { err: 'notours' };
      if (bytes[2] !== kind) return { err: 'kind', kind: bytes[2] };
      const fid = (bytes[3] << 8) | bytes[4], i = bytes[5], n = bytes[6];
      if (!n || i >= n) return { err: 'notours' };
      // 换了一次新的（手机上重新打开了二维码）：从头收
      if (fid !== id || n !== total) { id = fid; total = n; parts = new Array(n).fill(null); }
      if (!parts[i]) parts[i] = bytes.slice(HEAD);
      const got = parts.filter(Boolean).length;
      if (got < total) return { got, total };
      const len = parts.reduce((a, p) => a + p.length, 0);
      const payload = new Uint8Array(len);
      let o = 0;
      for (const p of parts) { payload.set(p, o); o += p.length; }
      return { got, total, payload };
    },
  };
}

/** 二维码里的字节 → qrcode-generator 要的“每个字符一个字节”的字符串 */
export function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
