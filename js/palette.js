// 色卡（色号 → 标准色 HEX）。
// 内置：MARD 280 色 —— A–H、M 共 221 色 + P 珠光 23 + R 果冻 28 + Y 夜光 5 + Q 温变 2（Q2、Q5）+ T 透明闪片 1。
// HEX 来源：拼豆图鉴 pd.anqstar.com/colors、Pixelbead MARD 色卡（两处数值一致）；A–H、M 已用示例图纸的色块取色核对，
// 各系列编号已对照 images/ 里的官方色卡照片核对。
// 用户可在“设置 → 色卡管理”里增删改，自定义色卡存在本机数据库里，启动时用 setPalette() 载入。
//
// 每行：系列: 依次为 1 号、2 号 … 的 HEX；“5=76CEDE” 表示指定编号（编号不连续时用）。
const RAW = `
A: FAF4C8 FFFFD5 FEFF8B FBED56 F4D738 FEAC4C FE8B4C FFDA45 FF995B F77C31 FFDD99 FE9F72 FFC365 FD543D FFF365 FFFF9F FFE36E FEBE7D FD7C72 FFD568 FFE395 F4F57D E6C9B7 F7F8A2 FFD67D FFC830
B: E6EE31 63F347 9EF780 5DE035 35E352 65E2A6 3DAF80 1C9C4F 27523A 95D3C2 5D722A 166F41 CAEB7B ADE946 2E5132 C5ED9C 9BB13A E6EE49 24B88C C2F0CC 156A6B 0B3C43 303A21 EEFCA5 4E846D 8D7A35 CCE1AF 9EE5B9 C5E254 E2FCB1 B0E792 9CAB5A
C: E8FFE7 A9F9FC A0E2FB 41CCFF 01ACEB 50AAF0 3677D2 0F54C0 324BCA 3EBCE2 28DDDE 1C334D CDE8FF D5FDFF 22C4C6 1557A8 04D1F6 1D3344 1887A2 176DAF BEDDFF 67B4BE C8E2FF 7CC4FF A9E5E5 3CAED8 D3DFFA BBCFED 34488E
D: AEB4F2 858EDD 2F54AF 182A84 B843C5 AC7BDE 8854B3 E2D3FF D5B9F8 361851 B9BAE1 DE9AD4 B90095 8B279B 2F1F90 E3E1EE C4D4F6 A45EC7 D8C3D7 9C32B2 9A009B 333A95 EBDAFC 7786E5 494FC7 DFC2F8
E: FDD3CC FEC0DF FFB7E7 E8649E F551A2 F13D74 C63478 FFDBE9 E970CC D33793 FCDDD2 F78FC3 B5006D FFD1BA F8C7C9 FFF3EB FFE2EA FFC7DB FEBAD5 D8C7D1 BD9DA1 B785A1 937A8D E1BCE8
F: FD957B FC3D46 F74941 FC283C E7002F 943630 971937 BC0028 E2677A 8A4526 5A2121 FD4E6A F35744 FFA9AD D30022 FEC2A6 E69C79 D37C46 C1444A CD9391 F7B4C6 FDC0D0 F67E66 E698AA E54B4F
G: FFE2CE FFC4AA F4C3A5 E1B383 EDB045 E99C17 9D5B3E 753832 E6B483 D98C39 E0C593 FFC890 B7714A 8D614C FCF9E0 F2D9BA 78524B FFE4CC E07935 A94023 B88558
H: FDFBFF FEFFFF B6B1BA 89858C 48464E 2F2B2F 000000 E7D6DB EDEDED EEE9EA CECDD5 FFF5ED F5ECD2 CFD7D3 98A6A8 1D1414 F1EDED FFFDF0 F6EFE2 949FA3 FFFBE1 CACAD4 9A9D94
M: BCC6B8 8AA386 697D80 E3D2BC D0CCAA B0A782 B4A497 B38281 A58767 C5B2BC 9F7594 644749 D19066 C77362 757D78
P: FCF7F8 B0A9AC AFDCAB FEA49F EE8C3E 5FD0A7 EB9270 F0D958 D9D9D9 D9C7EA F3ECC9 E6EEF2 AACBEF 337680 668575 FEBF45 FEA324 FEB89F FFFEEC FEBECF ECBEBF E4A89F A56268
R: D50D21 F92F83 FD8324 F8EC31 35C75B 238891 19779D 1A60C3 9A56B4 FFDB4C FFEBFA D8D5CE 55514C 9FE4DF 77CEE9 3ECFCA 4A867A 7FCD9D CDE55D E8C7B4 AD6F3C 6C372F FEB872 F3C1C0 C9675E D293BE EA8CB1 9C87D6
Y: FD6FB4 FEB481 D7FAA0 8BDBFA E987EA
Q: 2=E9EC91 5=76CEDE
T: FFFFFF
`;

/** 内置色卡（不可变的默认值）：[{ code, hex }] */
export const DEFAULT_ENTRIES = [];
for (const line of RAW.trim().split('\n')) {
  const [s, rest] = line.split(':');
  let n = 0;
  for (const tok of rest.trim().split(/\s+/)) {
    const m = tok.match(/^(\d+)=([0-9A-F]{6})$/i);
    n = m ? +m[1] : n + 1;
    DEFAULT_ENTRIES.push({ code: s + n, hex: '#' + (m ? m[2] : tok).toUpperCase() });
  }
}
export const DEFAULT_HEX = new Map(DEFAULT_ENTRIES.map(e => [e.code, e.hex]));

const SERIES_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M', 'P', 'R', 'Y', 'Q', 'T'];
export const SERIES_NAMES = { P: '珠光', R: '果冻', Y: '夜光', Q: '温变', T: '透明闪片' };
/** 基础色（A–H、M，MARD 基础 221 色），和 280 色里的 A–M 完全重合 */
export const BASE_SERIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'];

// 当前色卡（运行时可替换；这几个对象本身不换，只改内容，别的模块 import 后一直有效）
export const PALETTE = new Map();   // code → { code, series, num, hex, rgb, lab, name }
export const CODES = [];            // 排好序的色号
export const SERIES = [];           // 排好序的系列前缀

/** 色号格式：1–3 个大写字母 + 1–3 位数字，如 H7、P23、ZG1 */
export const CODE_RE = /^[A-Z]{1,3}\d{1,3}$/;
export function seriesOf(code) { return (String(code).match(/^[A-Z]+/) || [''])[0]; }
function numOf(code) { return parseInt((String(code).match(/\d+$/) || ['0'])[0], 10); }

function seriesRank(s) {
  const i = SERIES_ORDER.indexOf(s);
  return i >= 0 ? i : 100;
}

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [0, 2, 4].map(k => parseInt(h.slice(k, k + 2), 16));
}

/** 用一组条目替换当前色卡。entries: [{ code, hex, name? }] */
export function setPalette(entries) {
  PALETTE.clear();
  for (const e of entries) {
    const code = String(e.code).toUpperCase();
    if (!CODE_RE.test(code) || !/^#?[0-9A-Fa-f]{6}$/.test(e.hex)) continue;
    const hex = ('#' + e.hex.replace('#', '')).toUpperCase();
    const rgb = hexToRgb(hex);
    PALETTE.set(code, { code, series: seriesOf(code), num: numOf(code), hex, rgb, lab: rgbToLab(rgb), name: e.name || '' });
  }
  const sorted = [...PALETTE.keys()].sort(codeCompare);
  CODES.splice(0, CODES.length, ...sorted);
  const ser = [...new Set(sorted.map(seriesOf))];
  SERIES.splice(0, SERIES.length, ...ser);
}
setPalette(DEFAULT_ENTRIES);

export function paletteEntries() {
  return CODES.map(c => { const p = PALETTE.get(c); return { code: c, hex: p.hex, ...(p.name ? { name: p.name } : {}) }; });
}

export function isCode(code) { return PALETTE.has(code); }
export function hexOf(code) { return PALETTE.get(code)?.hex || '#cccccc'; }
export function rgbOf(code) { return PALETTE.get(code)?.rgb || null; }
export function seriesLabel(s) { return SERIES_NAMES[s] ? `${s} ${SERIES_NAMES[s]}` : s; }

export function codeCompare(a, b) {
  const sa = seriesOf(a), sb = seriesOf(b);
  if (sa !== sb) return seriesRank(sa) - seriesRank(sb) || sa.localeCompare(sb);
  return numOf(a) - numOf(b) || String(a).localeCompare(String(b));
}

/** 文字在该颜色上用黑还是白更清楚 */
export function inkFor(hexOrRgb) {
  const rgb = Array.isArray(hexOrRgb) ? hexOrRgb : hexToRgb(hexOrRgb);
  const l = rgbToLab(rgb)[0];
  return l > 62 ? '#111' : '#fff';
}

export function rgbToLab([r, g, b]) {
  const f = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = f(r), G = f(g), B = f(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const h = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = h(X), fy = h(Y), fz = h(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(rgb1, rgb2) {
  const a = rgbToLab(rgb1), b = rgbToLab(rgb2);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 按颜色找最接近的色号 */
export function nearestCodes(rgb, n = 3) {
  const lab = rgbToLab(rgb);
  return [...PALETTE.values()]
    .map(p => ({ code: p.code, de: Math.hypot(lab[0] - p.lab[0], lab[1] - p.lab[1], lab[2] - p.lab[2]) }))
    .sort((x, y) => x.de - y.de)
    .slice(0, n);
}

const FULLWIDTH = /[！-～]/g;
export function toHalfWidth(s) {
  return String(s).replace(FULLWIDTH, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}

// OCR 常见混淆：系列字母位 / 数字位
const LETTER_FIX = { '6': 'G', '8': 'B', '0': 'D', 'O': 'D', 'N': 'H', 'W': 'M' };
const DIGIT_FIX = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', '|': '1', '!': '1', J: '1', T: '7', Z: '2', S: '5', B: '8', G: '6', A: '4' };

function fixDigits(rest) {
  let d = '';
  for (const ch of rest) {
    if (/\d/.test(ch)) d += ch;
    else if (DIGIT_FIX[ch]) d += DIGIT_FIX[ch];
    else return null;
  }
  return d ? String(parseInt(d, 10)) : null;
}

/**
 * 把识别出的原始文字规整成当前色卡里的色号；对应不上时返回 null。
 * 例：'h7'→'H7'，'G1O'→'G10'，'H07'→'H7'，'6G'→'G6'，'zg1'→'ZG1'
 */
export function normalizeCode(raw) {
  if (raw == null) return null;
  const s = toHalfWidth(raw).toUpperCase().replace(/[\s\-_.·•:]/g, '');
  if (s.length < 2 || s.length > 6) return null;
  const direct = s.replace(/^([A-Z]+)0+(\d)/, '$1$2');
  if (PALETTE.has(direct)) return direct;
  // 先按“已有系列前缀 + 数字”解析（长前缀优先，如 ZG 先于 Z）
  const prefixes = [...SERIES].sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (!s.startsWith(p)) continue;
    const d = fixDigits(s.slice(p.length));
    if (d != null && PALETTE.has(p + d)) return p + d;
  }
  // 首字符是被读成数字的字母（6→G、8→B…）
  const first = LETTER_FIX[s[0]];
  if (first && SERIES.includes(first)) {
    const d = fixDigits(s.slice(1));
    if (d != null && PALETTE.has(first + d)) return first + d;
  }
  return null;
}

/** OCR 白名单：当前色卡用到的字母 + 数字 + x() */
export function ocrWhitelist() {
  const letters = new Set('ABCDEFGHM'.split(''));
  for (const s of SERIES) for (const ch of s) letters.add(ch);
  return [...letters].sort().join('') + 'x0123456789()';
}

/** 给大模型的色号规则说明 */
export function codeRuleText() {
  return SERIES.map(s => {
    const codes = CODES.filter(c => seriesOf(c) === s);
    const nums = codes.map(numOf);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    return hi - lo + 1 === nums.length && nums.length > 2 ? `${s}${lo}–${s}${hi}` : codes.join('/');
  }).join(', ');
}
