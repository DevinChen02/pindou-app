// 解析纯文字（iPhone 实况文本 / 快捷指令“从图像中提取文本”拷贝出来的内容）。
// 这类文字没有位置信息，只能靠顺序：
//   · “H2 (2606)”、“A11 x68”、“E1 4” —— 色号后面紧跟数量
//   · “A11 A18 E14 …” 一行色号，下一行 “x68 x45 x513 …” —— 按顺序一一对应
//   · 每个色号、数量各占一行 —— 同上
// 格子里成片的色号（后面没有数量）和行列号（1 2 3 … 连续数字）会被忽略。
import { normalizeCode, toHalfWidth } from '../palette.js';

const SKIP_WORDS = /^(空|全|全部|总计|合计|总数|共计|色号|数量|颜色)$/;

/** 从文字里找“共 696 颗”“878 豆”“12 色” */
export function parseStatedTotals(text) {
  const t = toHalfWidth(text);
  let total = null, colors = null;
  const m1 = t.match(/共\s*(\d{2,6})\s*[颗粒豆个]/) || t.match(/(\d{2,6})\s*[颗粒]/) || t.match(/(\d{2,6})\s*豆(?!子)/)
    || t.match(/(?:总数|总计|合计|全部?)\s*[:：]?\s*(\d{2,6})/);
  if (m1) total = +m1[1];
  const m2 = t.match(/(\d{1,3})\s*色(?:号)?(?![a-zA-Z0-9])/) || t.match(/(\d{1,3})\s*种颜色/);
  if (m2) colors = +m2[1];
  return { total, colors };
}

function classify(tok) {
  if (SKIP_WORDS.test(tok)) return { kind: 'skip', raw: tok };
  // 粘连：A11x68、H2(2606)、E1:4
  const g = tok.match(/^([A-Za-z]{1,3}[0-9OoIlSZ]{1,3})[:：]?[xX×*(]+(\d{1,5})\)?$/);
  if (g && normalizeCode(g[1])) return { kind: 'pair', code: normalizeCode(g[1]), count: +g[2], raw: tok };
  const c = tok.match(/^[xX×*]?\(?(\d{1,5})\)?$/);
  if (c) return { kind: 'count', n: +c[1], prefixed: /^[xX×*(]/.test(tok), raw: tok };
  const code = normalizeCode(tok);
  if (code && /[A-Za-z]/.test(tok)) return { kind: 'code', code, raw: tok };
  if (/^[A-Za-z]{1,3}[0-9A-Za-z]{1,3}$/.test(tok) && /\d/.test(tok)) return { kind: 'badcode', raw: tok };
  return { kind: 'other', raw: tok };
}

function isConsecutive(nums) {
  if (nums.length < 4) return false;
  let run = 0;
  for (let i = 1; i < nums.length; i++) run += nums[i] === nums[i - 1] + 1 ? 1 : 0;
  return run >= nums.length - 2;
}

/**
 * 返回 { items: [{code, count, raw, uncertain}], statedTotal, statedColors, skipped }
 * code 为 null 表示读到了像色号的字但不在色卡里（留给用户改）。
 */
export function parseLegendText(text) {
  const norm = toHalfWidth(String(text || ''))
    .replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[×✕]/g, 'x');
  const { total, colors } = parseStatedTotals(norm);
  // 切成 token，保留换行作为分隔
  const toks = [];
  for (const line of norm.split(/\r?\n/)) {
    const parts = line
      .replace(/([A-Za-z]{1,3}\d{1,3})\s*\(\s*(\d+)\s*\)/g, '$1($2)')
      .replace(/\b([xX])\s+(\d)/g, '$1$2')
      .split(/[\s,，、;；|/]+/).filter(Boolean);
    for (const p of parts) toks.push(classify(p));
    toks.push({ kind: 'nl' });
  }
  const items = [];
  const skipped = [];
  let i = 0;
  const isCodeTok = t => t && (t.kind === 'code' || t.kind === 'badcode' || t.kind === 'skip');
  const nextNonNl = j => { while (j < toks.length && toks[j].kind === 'nl') j++; return j; };
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === 'pair') { items.push({ code: t.code, count: t.count, raw: t.raw }); i++; continue; }
    if (t.kind === 'code' || t.kind === 'badcode') {
      // 色号后紧跟数量（同一行）
      const nx = toks[i + 1];
      if (nx && nx.kind === 'count' && !(toks[i + 2] && toks[i + 2].kind === 'count')) {
        // 但如果这是“一行色号 + 一行数量”的块，交给下面的块逻辑
        let k = i, codesRun = 0;
        while (k < toks.length && isCodeTok(toks[k])) { codesRun++; k++; }
        if (codesRun === 1) {
          items.push({ code: t.code || null, count: nx.n, raw: `${t.raw} ${nx.raw}`, uncertain: t.kind === 'badcode' });
          i += 2;
          continue;
        }
      }
      // 块：连续 k 个色号（可跨行），接着连续 k 个数量
      let k = i;
      const run = [];
      while (k < toks.length && (isCodeTok(toks[k]) || toks[k].kind === 'nl')) { if (toks[k].kind !== 'nl') run.push(toks[k]); k++; }
      const cstart = nextNonNl(k);
      const cnts = [];
      let m = cstart;
      while (m < toks.length && (toks[m].kind === 'count' || toks[m].kind === 'nl') && cnts.length < run.length) {
        if (toks[m].kind === 'count') cnts.push(toks[m]);
        m++;
      }
      if (cnts.length && !isConsecutive(cnts.map(c => c.n)) && cnts.length >= Math.min(run.length, 2)) {
        const mismatch = cnts.length !== run.length;
        run.slice(0, cnts.length).forEach((c, idx) => {
          if (c.kind === 'skip') { skipped.push(`${c.raw} ${cnts[idx].raw}`); return; }
          items.push({ code: c.code || null, count: cnts[idx].n, raw: `${c.raw} ${cnts[idx].raw}`, uncertain: mismatch || c.kind === 'badcode' });
        });
        i = m;
        continue;
      }
      // 后面没有数量：大概是格子里的色号，跳过
      i = k;
      continue;
    }
    i++;
  }
  // 同一个色号出现两次（多半是格子里的字混进来了）→ 标记不确定，保留第一次
  const seen = new Map();
  const out = [];
  for (const it of items) {
    if (it.code && seen.has(it.code)) { seen.get(it.code).dup = true; continue; }
    if (it.code) seen.set(it.code, it);
    out.push(it);
  }
  for (const it of out) if (it.dup) { it.uncertain = true; delete it.dup; it.note = '文字里出现了不止一次'; }
  return { items: out, statedTotal: total, statedColors: colors, skipped };
}
