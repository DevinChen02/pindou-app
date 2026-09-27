// MARD 221 色色卡（色号 → 标准色 HEX）。
// 数据来源：拼豆图鉴 pd.anqstar.com/colors（Mard 221），并已用示例图纸的色块取色核对（色差 ΔE 多在 0.7–6.5）。
// 每行：系列字母: 依次为 1 号、2 号 … 的 HEX。
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
`;

export const SERIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'];
export const PALETTE = new Map();
export const CODES = [];

for (const line of RAW.trim().split('\n')) {
  const [s, rest] = line.split(':');
  rest.trim().split(/\s+/).forEach((hex, i) => {
    const code = s + (i + 1);
    const rgb = [0, 2, 4].map(k => parseInt(hex.slice(k, k + 2), 16));
    PALETTE.set(code, { code, series: s, num: i + 1, hex: '#' + hex, rgb, lab: rgbToLab(rgb) });
    CODES.push(code);
  });
}

export function isCode(code) { return PALETTE.has(code); }
export function hexOf(code) { return PALETTE.get(code)?.hex || '#cccccc'; }
export function rgbOf(code) { return PALETTE.get(code)?.rgb || null; }

export function codeCompare(a, b) {
  const pa = PALETTE.get(a), pb = PALETTE.get(b);
  if (pa && pb) return SERIES.indexOf(pa.series) - SERIES.indexOf(pb.series) || pa.num - pb.num;
  if (pa) return -1;
  if (pb) return 1;
  return String(a).localeCompare(String(b));
}

/** 文字在该颜色上用黑还是白更清楚 */
export function inkFor(hexOrRgb) {
  const rgb = Array.isArray(hexOrRgb) ? hexOrRgb : [1, 3, 5].map(k => parseInt(String(hexOrRgb).slice(k, k + 2), 16));
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

const FULLWIDTH = /[\uFF01-\uFF5E]/g;
export function toHalfWidth(s) {
  return String(s).replace(FULLWIDTH, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
}

// OCR 常见混淆：系列字母位 / 数字位
const LETTER_FIX = { '6': 'G', '8': 'B', '0': 'D', 'O': 'D', 'Q': 'D', 'N': 'H', 'W': 'M' };
const DIGIT_FIX = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', '|': '1', '!': '1', J: '1', T: '7', Z: '2', S: '5', B: '8', G: '6', A: '4', Y: '4' };

/**
 * 把识别出的原始文字规整成色号；无法对应到色卡时返回 null。
 * 例：'h7'→'H7'，'G1O'→'G10'，'H07'→'H7'，'6G'→'G6'
 */
export function normalizeCode(raw) {
  if (raw == null) return null;
  let s = toHalfWidth(raw).toUpperCase().replace(/[\s\-_.·•:]/g, '');
  if (s.length < 2 || s.length > 3) return null;
  const direct = s.replace(/^([A-Z])0+(\d)/, '$1$2');
  if (PALETTE.has(direct)) return direct;
  let first = s[0];
  if (!SERIES.includes(first)) first = LETTER_FIX[first];
  if (!first) return null;
  let digits = '';
  for (const ch of s.slice(1)) {
    if (/\d/.test(ch)) digits += ch;
    else if (DIGIT_FIX[ch]) digits += DIGIT_FIX[ch];
    else return null;
  }
  const code = first + String(parseInt(digits, 10));
  return PALETTE.has(code) ? code : null;
}

/** 看起来像色号（字母+1~2位数字），但不一定在色卡里 */
export function looksLikeCode(raw) {
  const s = toHalfWidth(raw).toUpperCase().replace(/\s/g, '');
  return /^[A-Z][0-9OILSZBG]{1,2}$/.test(s);
}
