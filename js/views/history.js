// “历史”标签：图纸（待拼 / 已拼 / 撤销、多选算合计用量）和库存流水。
import { h, clear, toast, confirmDialog, chip, fmtNum, fmtTime, copyText } from '../ui.js';
import * as store from '../store.js';
import { newId } from '../extract/index.js';
import { openImageViewer, entriesFromImages } from '../viewer.js';

// select：多选模式下已选的图纸 id（null = 不在多选模式）；page：'totals' = 合计页；copies：每张图纸拼几份
const ui = { tab: 'patterns', select: null, page: null, copies: new Map(), filter: 'all', open: null };
const P_STATUS = { pending: ['待拼', 'accent'], done: ['已拼', 'ok'] };

/** 从别的标签切回来、或再点一次“历史”时，回到图纸列表 */
export function resetHistoryUI() {
  ui.select = null; ui.page = null; ui.open = null;
}

export async function renderHistory(app) {
  if (app.fresh) resetHistoryUI();
  if (ui.tab === 'patterns' && ui.page === 'totals' && ui.select?.size) return renderTotals(app);
  ui.page = null;
  const view = clear(app.view);
  if (ui.select) {
    app.setTitle('选择图纸');
    app.setBack(() => { ui.select = null; app.render(); });
    return patterns(app, view);
  }
  app.setTitle('历史');
  view.append(h('div.seg', { style: { margin: '6px 0 12px' } },
    h('button' + (ui.tab === 'patterns' ? '.on' : ''), { onclick: () => { ui.tab = 'patterns'; app.rerender(); } }, '图纸'),
    h('button' + (ui.tab === 'tx' ? '.on' : ''), { onclick: () => { ui.tab = 'tx'; app.rerender(); } }, '库存流水')));
  if (ui.tab === 'patterns') await patterns(app, view);
  else await transactions(app, view);
}

const patternTotal = p => p.items.reduce((a, i) => a + i.count, 0);

function thumbButton(p, onclick) {
  const src = p.thumbs?.[0];
  return h('button.thumb', { 'aria-label': '查看图纸', onclick },
    src ? h('img', { src, alt: '' }) : h('img', { alt: '' }),
    p.images?.length ? h('span.zi', '🔍') : null);
}

function viewPattern(p) {
  if (!p.images?.length) {
    toast(p.thumbs?.length ? '这张图纸是旧版本存的，没有保存原图' : '这张图纸没有图片（手动录入或文字识别）');
    return;
  }
  openImageViewer(entriesFromImages(p.images), { view: 'full', focus: false });
}

async function patterns(app, view) {
  const list = await store.listPatterns();
  if (!list.length) {
    ui.select = null;
    view.append(h('div.empty', h('div.big-ico', '🧩'), h('p', '还没有图纸。识别一张并确认后会出现在这里。')));
    return;
  }
  const sel = ui.select;
  if (sel) {
    // 删掉已不存在的
    const ids = new Set(list.map(p => p.id));
    for (const id of [...sel]) if (!ids.has(id)) sel.delete(id);
    const pending = list.filter(p => p.status === 'pending');
    const allOn = sel.size === list.length;
    app.actions.append(h('button.btn.sm.soft', { onclick: () => { if (allOn) sel.clear(); else list.forEach(p => sel.add(p.id)); app.rerender(); } }, allOn ? '全不选' : '全选'));
    view.append(h('p.small.muted', { style: { margin: '6px 2px 8px' } }, '选几张打算拼的图纸，看一共要多少豆子、哪些颜色要先买。'));
    if (pending.length) {
      view.append(h('div.row.gap-s.wrap', { style: { marginBottom: '4px' } },
        h('button.btn.sm.soft', { onclick: () => { sel.clear(); pending.forEach(p => sel.add(p.id)); app.rerender(); } }, `只选待拼的（${pending.length}）`),
        sel.size ? h('button.btn.sm.ghost', { onclick: () => { sel.clear(); app.rerender(); } }, '清空') : null));
    }
  } else {
    app.actions.append(h('button.btn.sm.soft', { onclick: () => { ui.select = new Set(); app.render(); } }, '多选'));
    if (list.length > 1) {
      view.append(h('button.btn.soft.block', { style: { marginBottom: '4px' }, onclick: () => { ui.select = new Set(); app.render(); } },
        '🧮 选几张图纸，算一共要多少豆子'));
    }
  }

  for (const p of list) {
    const total = patternTotal(p);
    const [label, cls] = P_STATUS[p.status] || ['—', ''];
    const on = sel?.has(p.id);
    const toggle = () => { if (on) sel.delete(p.id); else sel.add(p.id); app.rerender(); };
    const body = h('div.pcard',
      sel ? h('span.check.sel' + (on ? '.v' : '.p'), { style: { alignSelf: 'center' } }, on ? '✓' : '') : null,
      thumbButton(p, e => { if (sel) { e.stopPropagation(); toggle(); } else viewPattern(p); }),
      h('div.grow',
        h('div.row.between', h('div.t', p.name || '未命名'), h('span.tag.' + cls, label)),
        h('div.small.muted', `${p.items.length} 色 · ${fmtNum(total)} 颗 · ${fmtTime(p.createdAt)}`),
        h('div.row.wrap.gap-s', { style: { marginTop: '6px' } }, p.items.slice(0, 10).map(i => chip(i.code, { size: 'sm' })), p.items.length > 10 ? h('span.small.muted', '…') : null)));
    if (sel) {
      view.append(h('div.card.pick' + (on ? '.on' : ''), { onclick: toggle, role: 'checkbox', 'aria-checked': on ? 'true' : 'false' }, body));
      continue;
    }
    view.append(h('div.card', body,
      h('div.row.gap.end.wrap', { style: { marginTop: '12px' } },
        p.status === 'done' && p.txId ? h('button.btn.sm', {
          onclick: async () => {
            if (!(await confirmDialog(`撤销“${p.name}”的扣减？`, { ok: '撤销', danger: true, detail: '这幅图用掉的豆子会加回库存，图纸变回“待拼”。' }))) return;
            try { await store.undoTransaction(p.txId); toast('已撤销，库存已恢复', 'ok'); app.rerender(); } catch (e) { toast(e.message, 'error'); }
          },
        }, '撤销扣减') : null,
        p.status === 'pending' ? h('button.btn.sm.ghost', {
          onclick: async () => {
            if (!(await confirmDialog(`删除“${p.name}”？`, { ok: '删除', danger: true }))) return;
            await store.deletePattern(p.id); app.rerender();
          },
        }, '删除') : null,
        p.status === 'pending' ? h('button.btn.sm.primary', { onclick: () => openPending(app, p) }, '去预览 / 确认') : null,
        h('button.btn.sm.soft', { onclick: () => reuse(app, p) }, '再拼一次'))));
  }

  if (sel) {
    view.append(h('div.sticky-actions',
      h('button.btn.primary.big.block', {
        disabled: !sel.size,
        onclick: () => { ui.page = 'totals'; ui.open = null; app.render(); },
      }, sel.size ? `看合计用量（已选 ${sel.size} 张）` : '先选图纸')));
  }
}

// ---------- 合计用量 ----------

async function renderTotals(app) {
  const settings = app.settings;
  app.setTitle('合计用量');
  app.setBack(() => { ui.page = null; app.render(); });
  const view = clear(app.view);
  const all = await store.listPatterns();
  const chosen = all.filter(p => ui.select.has(p.id));
  if (!chosen.length) { ui.page = null; return app.render(); }
  const copiesOf = p => ui.copies.get(p.id) || 1;

  // 合并所有图纸的用量（每张 × 份数），再按库存算
  const items = [], by = new Map();
  for (const p of chosen) {
    const n = copiesOf(p);
    for (const it of p.items) {
      items.push({ code: it.code, count: it.count * n });
      if (!by.has(it.code)) by.set(it.code, []);
      by.get(it.code).push({ name: p.name || '未命名', count: it.count * n });
    }
  }
  const inv = await store.getInventory();
  const rows = store.previewRows(items, inv, settings).map(r => ({ ...r, buy: Math.max(0, r.threshold - r.after) }));
  const short = rows.filter(r => r.status === 'short');
  const low = rows.filter(r => r.status === 'low');
  const totalNeed = rows.reduce((a, r) => a + r.need, 0);
  const totalBuy = rows.reduce((a, r) => a + r.buy, 0);
  const doneN = chosen.filter(p => p.status === 'done').length;

  // 选了哪些图纸（可改份数）
  view.append(h('div.list.tot-pats', chosen.map(p => {
    const n = copiesOf(p);
    const set = v => { ui.copies.set(p.id, Math.max(1, Math.min(99, v))); app.rerender(); };
    return h('div.li',
      h('div.grow',
        h('div', h('b', p.name || '未命名'), p.status === 'done' ? h('span.tag.ok', { style: { marginLeft: '6px' } }, '已拼') : null),
        h('div.tiny.muted', `${p.items.length} 色 · ${fmtNum(patternTotal(p))} 颗${n > 1 ? ` × ${n} 份` : ''}`)),
      h('div.mini-step',
        h('button', { 'aria-label': '少拼一份', disabled: n <= 1, onclick: () => set(n - 1) }, '−'),
        h('span', `${n} 份`),
        h('button', { 'aria-label': '多拼一份', onclick: () => set(n + 1) }, '+')));
  })));

  view.append(h('div.totals', { style: { marginTop: '12px' } },
    h('div.stat', h('div.k', '一共需要'), h('div.v', fmtNum(totalNeed)), h('div.s.muted', `${rows.length} 种颜色`)),
    h('div.stat', h('div.k', '建议买'), h('div.v', { style: { color: totalBuy ? 'var(--bad)' : 'var(--ok)' } }, fmtNum(totalBuy)),
      h('div.s.muted', totalBuy ? `${short.length + low.length} 种颜色` : '都不用买'))));

  if (short.length) {
    const lack = short.reduce((a, r) => a - r.after, 0);
    view.append(h('div.banner.bad', h('span.ico', '⛔️'), h('div',
      h('b', `${short.length} 种颜色不够，拼完这些图还缺 ${fmtNum(lack)} 颗`),
      low.length ? h('div.small', `另有 ${low.length} 种颜色够用，但拼完会低于补货线。`) : null)));
  } else if (low.length) {
    view.append(h('div.banner.warn', h('span.ico', '⚠️'), h('div',
      h('b', '全部够用'), h('div.small', `但拼完后有 ${low.length} 种颜色会低于补货线，建议提前买。`))));
  } else {
    view.append(h('div.banner.ok', h('span.ico', '✅'), h('div', h('b', '全部够用'), h('div.small', '拼完这些图，所有颜色都还在补货线以上。'))));
  }
  if (doneN) view.append(h('p.small.muted', `其中 ${doneN} 张已经拼过（库存扣过了），这里按“再拼一次”计算。`));

  const toBuy = rows.filter(r => r.buy > 0);
  if (ui.filter === 'buy' && !toBuy.length) ui.filter = 'all';
  view.append(h('div.seg', { style: { margin: '10px 0' } },
    h('button' + (ui.filter === 'all' ? '.on' : ''), { onclick: () => { ui.filter = 'all'; app.rerender(); } }, `全部颜色（${rows.length}）`),
    h('button' + (ui.filter === 'buy' ? '.on' : ''), { disabled: !toBuy.length, onclick: () => { ui.filter = 'buy'; app.rerender(); } }, `要买的（${toBuy.length}）`)));

  const shown = ui.filter === 'buy' ? toBuy : rows;
  const tbody = h('tbody');
  for (const r of shown) {
    const open = ui.open === r.code;
    const parts = by.get(r.code) || [];
    tbody.append(h('tr.' + r.status + '.click', { onclick: () => { ui.open = open ? null : r.code; app.rerender(); } },
      h('td', chip(r.code, { size: 'sm' })),
      h('td', fmtNum(r.need)),
      h('td', fmtNum(r.stock)),
      h('td.after' + (r.after < 0 ? '.neg' : r.status === 'low' ? '.low' : ''), r.after < 0 ? `缺 ${fmtNum(-r.after)}` : fmtNum(r.after)),
      h('td.buy', r.buy ? fmtNum(r.buy) : h('span.muted', '—'))));
    if (open) {
      tbody.append(h('tr.detail', h('td', { colspan: 5 },
        h('div.small', parts.map(x => h('div.row.between', h('span', x.name), h('span.mono', `${fmtNum(x.count)} 颗`)))),
        h('div.tiny.muted', { style: { marginTop: '4px' } },
          `补货线 ${r.threshold} 颗${Number(settings.lossPercent) > 0 ? ` · 需要已含损耗 ${settings.lossPercent}%` : ''}`))));
    }
  }
  view.append(h('div.table-wrap', h('table.ptable.tot',
    h('thead', h('tr', h('th', '颜色'), h('th', '需要'), h('th', '现有'), h('th', '拼完剩'), h('th', '建议买'))),
    tbody)));
  view.append(h('p.small.muted',
    `“建议买”= 拼完后补回到补货线（默认 ${settings.defaultThreshold} 颗）要买的数量；红色是不够拼，黄色是拼完会低于补货线。点一行可以看每张图纸各用多少。`,
    Number(settings.lossPercent) > 0 ? `“需要”已按损耗 ${settings.lossPercent}% 向上取整。` : ''));

  view.append(h('div.sticky-actions',
    h('button.btn.big.block' + (toBuy.length ? '.primary' : ''), {
      disabled: !toBuy.length,
      onclick: () => copyText(buyList(chosen, copiesOf, short, low)),
    }, toBuy.length ? `复制采购清单（${toBuy.length} 色，${fmtNum(totalBuy)} 颗）` : '不用买豆子 👍')));
}

function buyList(chosen, copiesOf, short, low) {
  const names = chosen.map(p => (p.name || '未命名') + (copiesOf(p) > 1 ? `×${copiesOf(p)}` : '')).join('、');
  const lines = [`拼豆采购清单（${chosen.length} 张图纸：${names}）`];
  if (short.length) lines.push('', '【不够拼，必须买】', ...short.map(r => `${r.code}：缺 ${-r.after} 颗，建议买 ${r.buy} 颗`));
  if (low.length) lines.push('', '【拼完会低于补货线】', ...low.map(r => `${r.code}：拼完剩 ${r.after} 颗，建议买 ${r.buy} 颗`));
  lines.push('', `合计建议买 ${[...short, ...low].reduce((a, r) => a + r.buy, 0)} 颗`);
  return lines.join('\n');
}

// ---------- 打开 / 再拼 ----------

function sessionFromPattern(p, patternId) {
  return {
    id: newId(), createdAt: Date.now(), method: 'saved', name: p.name, patternId,
    images: (p.images || []).map(im => ({ ...im })),
    statedTotal: p.statedTotal || null, statedColors: null, cursor: 0, mode: 'list',
    items: p.items.map(i => ({ id: newId(), img: null, code: i.code, rawCode: i.code, count: i.count, box: null, rgb: null, uncertain: false, verified: true, orig: { code: i.code, count: i.count } })),
  };
}

function openPending(app, p) {
  app.rec.session = sessionFromPattern(p, p.id);
  app.rec.step = 'preview';
  app.saveSession();
  app.go('recognize');
}

function reuse(app, p) {
  app.rec.session = sessionFromPattern({ ...p, name: p.name + '（再拼）' }, null);
  app.rec.step = 'preview';
  app.saveSession();
  app.go('recognize');
}

// ---------- 库存流水 ----------

async function transactions(app, view) {
  const list = await store.listTransactions();
  if (!list.length) {
    view.append(h('div.empty', h('div.big-ico', '📒'), h('p', '还没有库存变动记录。')));
    return;
  }
  const patterns = new Map((await store.listPatterns()).map(p => [p.id, p]));
  const box = h('div.list');
  for (const t of list.slice(0, 200)) {
    const sum = t.deltas.reduce((a, d) => a + d.delta, 0);
    const pname = t.patternId != null ? patterns.get(t.patternId)?.name : '';
    const deltas = h('div.tx-deltas', { hidden: true }, t.deltas.map(d => h('span', `${d.code} ${d.delta > 0 ? '+' : ''}${d.delta} → ${d.after}`)));
    box.append(h('div.li.click', { style: { flexWrap: 'wrap' }, onclick: () => { deltas.hidden = !deltas.hidden; } },
      h('div.grow',
        h('div', h('b', store.TX_TYPES[t.type] || t.type), pname ? ` · ${pname}` : '', t.note && !pname ? ` · ${t.note}` : '', t.undone ? h('span.tag', { style: { marginLeft: '6px' } }, '已撤销') : null),
        h('div.tiny.muted', `${fmtTime(t.time)} · ${t.deltas.length} 色`)),
      h('b.mono', { style: { color: sum < 0 ? 'var(--bad)' : 'var(--ok)' } }, (sum > 0 ? '+' : '') + fmtNum(sum)),
      h('div', { style: { flexBasis: '100%' } }, deltas)));
  }
  view.append(box, h('p.small.muted.center', '点一条记录可以看每个颜色的变化。拼豆扣减可在“图纸”里撤销。'));
}
