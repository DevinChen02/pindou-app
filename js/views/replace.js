// 整种换颜色：把图纸里某个颜色全部换成另一个颜色（清单、拼豆板一起改），不用一格一格改。
// 用得上的时候：缺某个颜色想用别的代替；或者拼豆板上两个颜色整种认反了（互换）。
import { h, toast, sheet, chip, fmtNum, pickCode, undoToast } from '../ui.js';
import * as store from '../store.js';
import { rgbOf, nearestCodes, isCode } from '../palette.js';

/** 图纸里的颜色和颗数（照着拼豆板拼的用板上的颗数） */
function colorsOf(p) {
  return [...store.beadCounts(p)].filter(([, n]) => n > 0).map(([code, n]) => ({ code, n }));
}

/** 先选要换掉的颜色 */
function pickFrom(p) {
  return new Promise(resolve => {
    let done = false;
    const pick = c => { done = true; s.close(); resolve(c); };
    const rows = colorsOf(p);
    const s = sheet([
      h('p.small.muted', { style: { margin: '0 2px 10px' } }, '选要换掉的颜色：它在清单和拼豆板上的格子会全部换成你接着选的颜色。'),
      h('div.code-grid.rp-from', rows.map(r => {
        const locked = store.colorTouched(p, r.code);
        return h('button.code-cell.has-sub' + (locked ? '.locked' : ''), {
          'data-code': r.code,
          onclick: () => { if (locked) toast(`${r.code} 已经打了“拼好”的勾（或者扣过库存），不能整种换`); else pick(r.code); },
        }, chip(r.code, { size: 'sm' }), h('span.code-sub', locked ? '已拼好' : `${fmtNum(r.n)} 颗`));
      })),
    ], { title: '整种换颜色', tall: true, onClose: () => { if (!done) resolve(null); } });
  });
}

/** to 已经在图纸里：合并还是互换 */
function mergeOrSwap(p, from, to, nFrom, nTo) {
  return new Promise(resolve => {
    let done = false;
    const pick = v => { done = true; s.close(); resolve(v); };
    const s = sheet(h('div.menu.rp-mode',
      h('button.rp-merge', { onclick: () => pick('merge') },
        h('div', h('b', `合并：${from} 都换成 ${to}`)),
        h('div.tiny.muted', `${from} 的 ${fmtNum(nFrom)} 颗并到 ${to} 上（${to} 一共 ${fmtNum(nFrom + nTo)} 颗），图纸里不再有 ${from}`)),
      p.gen || store.colorTouched(p, to) ? null : h('button.rp-swap', { onclick: () => pick('swap') },
        h('div', h('b', `互换：${from} 和 ${to} 对调`)),
        h('div.tiny.muted', `拼豆板上这两个颜色整种认反了的时候用：${from} 的格子变成 ${to}，${to} 的格子变成 ${from}，清单不变`)),
    ), { title: `${to} 已经在这张图纸里了`, onClose: () => { if (!done) resolve(null); } });
  });
}

/**
 * 整种换颜色的整个流程。from 不给就先让用户选。换完调 onChanged()（重画页面）。
 * 返回 true 表示换了
 */
export async function replaceFlow(app, p, { from = null, onChanged = null } = {}) {
  p = await store.getPattern(p.id) || p;
  if (p.status === 'done') { toast('已经拼完的图纸不能换颜色'); return false; }
  if (!from) from = await pickFrom(p);
  if (!from) return false;
  if (store.colorTouched(p, from)) { toast(`${from} 已经打了“拼好”的勾（或者扣过库存），不能整种换`, 'error'); return false; }
  const counts = new Map(colorsOf(p).map(r => [r.code, r.n]));
  const inv = await store.getInventory();
  const anyStock = [...inv.values()].some(x => (x.stock || 0) > 0);
  const here = [...counts.keys()].filter(c => c !== from);
  const near = isCode(from) ? nearestCodes(rgbOf(from), 9).map(x => x.code).filter(c => c !== from) : [];
  const to = await pickCode({
    current: null, title: `${from} 换成哪个颜色？`,
    groups: [
      { label: '颜色最接近的：', codes: near },
      { label: '这张图纸里已有的颜色（选了就合并，也可以互换）：', codes: here },
    ],
    sub: anyStock ? c => `库存 ${fmtNum(store.stockOf(inv, c))}` : null,
  });
  if (!to || to === from) return false;
  let mode = 'merge';
  if (store.patternHasCode(p, to)) {
    mode = await mergeOrSwap(p, from, to, counts.get(from) || 0, counts.get(to) || 0);
    if (!mode) return false;
  }
  try {
    await store.replaceColor(p.id, from, to, { mode });
  } catch (e) { toast(e.message || String(e), 'error'); return false; }
  const n = counts.get(from) || 0;
  const msg = mode === 'swap' ? `${from} 和 ${to} 互换了` : `${from} 的 ${fmtNum(n)} 颗都换成了 ${to}`;
  undoToast(msg, async () => {
    try { await store.undoReplace(p.id); toast('已撤销换色', 'ok'); onChanged?.(); } catch (e) { toast(e.message, 'error'); }
  });
  onChanged?.();
  return true;
}

/** 菜单里“撤销整种换色”那一项（能撤销时才有） */
export function undoReplaceButton(p, { close, onChanged }) {
  if (!store.replaceUndoable(p)) return null;
  const u = p.replaceUndo;
  return h('button.rp-undo', {
    onclick: async () => {
      close();
      try { await store.undoReplace(p.id); toast('已撤销换色', 'ok'); onChanged?.(); } catch (e) { toast(e.message, 'error'); }
    },
  }, `↩ 撤销刚才的换色（${u.from} ${u.mode === 'swap' ? '⇄' : '→'} ${u.to}）`);
}
