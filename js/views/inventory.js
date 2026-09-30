// “库存”标签：每个色号还剩多少、待补货、补货/盘点、批量录入。
import { h, clear, toast, sheet, chip, fmtNum, fmtTime, confirmDialog, icon, optionSheet } from '../ui.js';
import { PALETTE, SERIES, BASE_SERIES, hexOf, normalizeCode, seriesLabel } from '../palette.js';
import { parseLegendText } from '../extract/text.js';
import * as store from '../store.js';
import { readOnlyToast } from '../license.js';

const ui = { filter: 'owned', series: 'all', q: '', tab: 'stock', filtersScroll: 0 };

export async function renderInventory(app) {
  app.setTitle('库存');
  if (app.fresh) ui.tab = 'stock';
  const segs = h('div.seg', { style: { margin: '6px 0 4px' } },
    h('button' + (ui.tab === 'stock' ? '.on' : ''), { onclick: () => { ui.tab = 'stock'; app.rerender(); } }, '库存'),
    h('button' + (ui.tab === 'tx' ? '.on' : ''), { onclick: () => { ui.tab = 'tx'; app.rerender(); } }, '流水'));
  if (ui.tab === 'tx') {
    const view = clear(app.view);
    view.append(segs);
    return transactions(app, view);
  }
  const settings = app.settings;
  const inv = await store.getInventory();
  const lows = store.lowStockList(inv, settings);
  const lowSet = new Set(lows.map(x => x.code));
  const ownedN = [...inv.values()].filter(r => (r.stock ?? 0) > 0).length;
  if (!inv.size && ui.filter === 'owned') ui.filter = 'all';
  app.actions.append(h('button.btn.sm.soft', { onclick: () => batchSheet(app) }, '批量录入'));
  const view = clear(app.view);

  const search = h('input.input', { type: 'search', placeholder: '搜索色号，如 H7', value: ui.q, autocapitalize: 'characters', autocomplete: 'off' });
  const grid = h('div.inv-grid');
  const sortKey = invSortOf(settings);
  const list = [...PALETTE.values()];
  // 按数量排：没录入的（多半没买过这个颜色）总是排最后；数量一样按色号
  const stockOf = p => inv.get(p.code)?.stock;
  if (sortKey === 'asc') list.sort((a, b) => (stockOf(a) == null) - (stockOf(b) == null) || (stockOf(a) ?? 0) - (stockOf(b) ?? 0));
  if (sortKey === 'desc') list.sort((a, b) => (stockOf(a) == null) - (stockOf(b) == null) || (stockOf(b) ?? 0) - (stockOf(a) ?? 0));
  const countEl = h('span.small.muted');
  const draw = () => {
    clear(grid);
    const q = ui.q.trim().toUpperCase();
    let n = 0;
    for (const p of list) {
      const rec = inv.get(p.code);
      const stock = rec?.stock ?? 0;
      if (ui.series !== 'all' && p.series !== ui.series) continue;
      if (q && !p.code.startsWith(q) && p.code !== normalizeCode(q)) continue;
      if (ui.filter === 'owned' && !(stock > 0)) continue;
      if (ui.filter === 'low' && !lowSet.has(p.code)) continue;
      n++;
      const isLow = lowSet.has(p.code);
      grid.append(h('div.tile' + (isLow ? '.low' : '') + (!rec ? '.none' : stock === 0 ? '.zero' : ''), { onclick: () => editSheet(app, p.code) },
        chip(p.code, { size: 'sm' }),
        h('div.n', rec ? fmtNum(stock) : '未录入'),
        isLow ? h('span.flag', '!') : null));
    }
    countEl.textContent = `${n} 色`;
    if (!n) grid.append(h('div.empty', { style: { gridColumn: '1 / -1' } },
      h('div.big-ico', ui.filter === 'low' ? '👍' : '🫘'),
      h('p', ui.filter === 'low' ? '没有需要补货的颜色' : ui.filter === 'owned' ? '还没有录入库存' : '没有匹配的色号'),
      ui.filter === 'owned' ? h('button.btn.primary', { onclick: () => batchSheet(app) }, '批量录入库存') : null));
  };
  search.addEventListener('input', () => { ui.q = search.value; draw(); });

  // 点筛选按钮会整页重画：记住这一排按钮滚到哪了，重画后放回原处（不自动滑回最左边）
  const pick = fn => () => { ui.filtersScroll = filters.scrollLeft; fn(); app.rerender(); };
  const filters = h('div.filters',
    [['owned', `有库存 ${ownedN}`], ['low', `待补货 ${lows.length}`], ['all', `全部 ${PALETTE.size}`]].map(([k, label]) =>
      h('button' + (ui.filter === k ? '.on' : ''), { onclick: pick(() => { ui.filter = k; }) }, label)),
    h('span', { style: { width: '8px', flexShrink: 0 } }),
    ['all', ...SERIES].map(sr => h('button' + (ui.series === sr ? '.on' : ''), { onclick: pick(() => { ui.series = sr; }) }, sr === 'all' ? '全系列' : seriesLabel(sr))));
  // 排序：在列表上方右边（像“按色号 ▾”的下拉），点开选排序方式
  const sortBtn = h('button.inv-sort', { 'aria-label': '排序方式', onclick: () => sortSheet(app) },
    icon('sort'), h('span', INV_SORTS.find(o => o.value === sortKey).short), h('span.caret', '▾'));

  view.append(segs, h('div.inv-tools', search, filters, h('div.inv-head', countEl, sortBtn)));
  filters.scrollLeft = ui.filtersScroll;
  requestAnimationFrame(() => { filters.scrollLeft = ui.filtersScroll; });
  if (lows.length && ui.filter !== 'low') {
    view.append(h('div.banner.warn', { style: { cursor: 'pointer' }, onclick: () => { ui.filter = 'low'; app.rerender(); } },
      h('span.ico', '🛒'), h('div.grow', h('b', `${lows.length} 种颜色低于补货线`), h('div.small', lows.slice(0, 8).map(x => x.code).join('、') + (lows.length > 8 ? '…' : ''))), h('span', '›')));
  }
  view.append(grid);
  draw();
}

// ---------- 排序 ----------
const INV_SORTS = [
  { value: 'code', short: '按色号', label: '按色号', desc: 'A1、A2…，和色卡顺序一样' },
  { value: 'asc', short: '数量少→多', label: '按数量：少 → 多', desc: '快用完的排在最前面，一眼看出要补哪些（没录入的排最后）' },
  { value: 'desc', short: '数量多→少', label: '按数量：多 → 少', desc: '存货最多的排在前面' },
];
/** 旧设置里的 'stock' 当成“少→多” */
const invSortOf = settings => (settings.invSort === 'stock' ? 'asc' : INV_SORTS.some(o => o.value === settings.invSort) ? settings.invSort : 'code');

function sortSheet(app) {
  optionSheet('排序方式', [{
    value: invSortOf(app.settings), options: INV_SORTS,
    onPick: async v => { app.settings.invSort = v; await store.saveSettings(app.settings); app.rerender(); },
  }]);
}

async function editSheet(app, code) {
  if (app.readOnly) { readOnlyToast(app.readOnly); return; }
  const settings = app.settings;
  const inv = await store.getInventory();
  const rec = inv.get(code);
  const stock = rec?.stock ?? 0;
  const th = rec?.threshold;
  const txs = (await store.listTransactions()).filter(t => t.deltas.some(d => d.code === code)).slice(0, 6);
  const amount = h('input.input.num', { type: 'number', inputmode: 'numeric', pattern: '[0-9]*', placeholder: '数量', min: 0 });
  const thInput = h('input.input', { type: 'number', inputmode: 'numeric', pattern: '[0-9]*', placeholder: `默认 ${settings.defaultThreshold}`, value: th ?? '' });
  const apply = async (changes, type, note) => {
    try {
      await store.applyChanges(changes, { type, note });
      toast('已更新', 'ok');
      sh.close();
      app.rerender();
    } catch (e) { toast(e.message, 'error'); }
  };
  const sh = sheet([
    h('div.row.gap', chip(code, { size: 'lg' }),
      h('div', h('div.muted.small', '当前库存'), h('div', { style: { fontSize: '34px', fontWeight: 800 } }, fmtNum(stock)),
        h('div.tiny.muted', `标准色 ${hexOf(code)}`))),
    h('div.section-title', '补货（加上）'),
    h('div.quick', settings.restockPresets.map(n => h('button.btn.soft', { onclick: () => apply([{ code, delta: n }], 'restock', '') }, `+${n}`))),
    h('div.section-title', '自定义数量'),
    h('div.row.gap', amount,
      h('button.btn', { onclick: () => { const n = Math.round(+amount.value); if (n > 0) apply([{ code, delta: n }], 'restock', ''); else toast('请输入数量'); } }, '加上'),
      h('button.btn', { onclick: () => { const n = Math.round(+amount.value); if (n >= 0 && amount.value !== '') apply([{ code, delta: -n }], 'adjust', '手动减少'); else toast('请输入数量'); } }, '减去'),
      h('button.btn', { onclick: () => { if (amount.value === '') return toast('请输入数量'); apply([{ code, set: Math.round(+amount.value) }], 'adjust', '盘点设为'); } }, '设为')),
    h('div.section-title', '补货线（剩余低于它就提醒）'),
    h('div.row.gap', thInput, h('button.btn', {
      onclick: async () => {
        await store.setThreshold(code, thInput.value === '' ? null : +thInput.value);
        toast(thInput.value === '' ? `已恢复为默认 ${settings.defaultThreshold}` : '已保存', 'ok');
        sh.close(); app.rerender();
      },
    }, '保存')),
    txs.length ? [h('div.section-title', '最近变动'), h('div.list', txs.map(t => {
      const d = t.deltas.find(x => x.code === code);
      return h('div.li', h('div.grow', h('div.small', store.TX_TYPES[t.type] || t.type, t.undone ? h('span.tag', { style: { marginLeft: '6px' } }, '已撤销') : null), h('div.tiny.muted', fmtTime(t.time))),
        h('b.mono', { style: { color: d.delta < 0 ? 'var(--bad)' : 'var(--ok)' } }, (d.delta > 0 ? '+' : '') + d.delta), h('span.tiny.muted', `→ ${d.after}`));
    }))] : null,
  ], { title: `${code} 库存` });
}

function batchSheet(app) {
  if (app.readOnly) { readOnlyToast(app.readOnly); return; }
  let mode = 'add';
  const picked = new Set();
  let series = SERIES[0];
  const modeLabel = () => (mode === 'add' ? '补货' : '盘点设为');
  const seg = h('div.seg');
  const renderSeg = () => {
    clear(seg);
    for (const [k, label] of [['add', '补货（加上）'], ['set', '盘点（设为）']]) seg.append(h('button' + (mode === k ? '.on' : ''), { onclick: () => { mode = k; renderSeg(); refresh(); } }, label));
  };

  // ---- 点选颜色（可多选）----
  const tabs = h('div.series-tabs');
  const grid = h('div.code-grid.batch-grid');
  const pickInfo = h('div.small');
  const pickVal = h('input.input.num.pick-n', { type: 'number', inputmode: 'numeric', pattern: '[0-9]*', placeholder: '颗数', min: 0 });
  const pickBtn = h('button.btn.primary.pick-go');
  const renderTabs = () => {
    const sl = tabs.scrollLeft;
    clear(tabs);
    for (const sr of SERIES) {
      const n = [...PALETTE.values()].filter(p => p.series === sr && picked.has(p.code)).length;
      tabs.append(h('button.tab' + (sr === series ? '.on' : ''), { title: seriesLabel(sr), onclick: () => { series = sr; renderTabs(); renderGrid(); } }, sr, n ? h('sup.tab-n', n) : null));
    }
    tabs.scrollLeft = sl;
  };
  const renderGrid = () => {
    clear(grid);
    for (const p of PALETTE.values()) {
      if (p.series !== series) continue;
      grid.append(h('button.code-cell' + (picked.has(p.code) ? '.on' : ''), {
        'data-code': p.code,
        onclick: e => { if (picked.has(p.code)) picked.delete(p.code); else picked.add(p.code); e.currentTarget.classList.toggle('on'); renderTabs(); refresh(); },
      }, chip(p.code, { size: 'sm' })));
    }
  };
  const refresh = () => {
    pickInfo.textContent = picked.size ? `已选 ${picked.size} 色：${[...picked].slice(0, 10).join('、')}${picked.size > 10 ? '…' : ''}` : '点下面的颜色选中（可以多选，换系列也保留）';
    pickBtn.textContent = picked.size ? `${modeLabel()} ${picked.size} 色` : modeLabel();
  };
  pickBtn.addEventListener('click', async () => {
    if (!picked.size) return toast('先点选颜色');
    const v = Math.round(+pickVal.value);
    if (pickVal.value === '' || v < 0 || (mode === 'add' && v === 0)) return toast('请输入颗数');
    const codes = [...picked];
    if (!(await confirmDialog(`${mode === 'add' ? `给 ${codes.length} 种颜色各加 ${v} 颗` : `把 ${codes.length} 种颜色都设为 ${v} 颗`}？`, { detail: codes.join('、') }))) return;
    await store.applyChanges(codes.map(code => (mode === 'add' ? { code, delta: v } : { code, set: v })), { type: mode === 'add' ? 'restock' : 'import', note: `点选 ${codes.length} 色` });
    toast('已录入', 'ok'); sh.close(); app.rerender();
  });

  // ---- 按范围一次设好 ----
  const baseCodes = [...PALETTE.values()].filter(p => BASE_SERIES.includes(p.series));
  const ranges = [
    ['all', `全部 ${PALETTE.size} 色`, () => [...PALETTE.values()]],
    ...(baseCodes.length && baseCodes.length < PALETTE.size ? [['base', `基础 ${baseCodes.length} 色（A–M）`, () => baseCodes]] : []),
    ...SERIES.map(sr => [sr, `${seriesLabel(sr)} 系列`, () => [...PALETTE.values()].filter(p => p.series === sr)]),
  ];
  const seriesSel = h('select.input.range-sel', ranges.map(([k, l]) => h('option', { value: k }, l)));
  const seriesVal = h('input.input.num.range-n', { type: 'number', inputmode: 'numeric', placeholder: '颗数', style: { width: '100px' } });
  const rangeBtn = h('button.btn.range-go', {
    onclick: async () => {
      const v = Math.round(+seriesVal.value);
      if (seriesVal.value === '' || v < 0 || (mode === 'add' && v === 0)) return toast('请输入颗数');
      const [, label, get] = ranges.find(r => r[0] === seriesSel.value);
      const codes = get().map(p => p.code);
      if (!(await confirmDialog(mode === 'add' ? `给${label}每色加 ${v} 颗？` : `把${label}都设为 ${v} 颗？`, { detail: '适合刚买了整套色卡时使用。之后可以单独修改。' }))) return;
      await store.applyChanges(codes.map(code => (mode === 'add' ? { code, delta: v } : { code, set: v })), { type: mode === 'add' ? 'restock' : 'import', note: `${label}${mode === 'add' ? '各加' : '设为'} ${v}` });
      toast('已录入', 'ok'); sh.close(); app.rerender();
    },
  }, '录入');

  // ---- 粘贴列表 ----
  const ta = h('textarea.input', { placeholder: '每行一个：色号 数量\n例如：\nH7 1000\nH2 1000\nA11 500' });
  const out = h('div');
  const sh = sheet([
    h('p.small.muted', '适合第一次录入或一次买了很多颜色。先选“补货”还是“盘点”，再用下面任意一种方式录入。'),
    seg,
    h('div.section-title', '点选颜色'),
    pickInfo, tabs, grid,
    h('div.row.gap.batch-act', pickVal, pickBtn,
      h('button.btn.ghost.sm', { onclick: () => { picked.clear(); renderTabs(); renderGrid(); refresh(); } }, '清空'),
      h('button.btn.ghost.sm', { onclick: () => { for (const p of PALETTE.values()) if (p.series === series) picked.add(p.code); renderTabs(); renderGrid(); refresh(); } }, '全选本系列')),
    h('div.section-title', '按系列 / 整套一次录入'),
    h('div.row.gap', seriesSel, seriesVal, rangeBtn),
    h('div.section-title', '粘贴“色号 数量”列表'),
    ta,
    h('button.btn.block', {
      style: { marginTop: '10px' },
      onclick: async () => {
        const res = parseLegendText(ta.value);
        const items = res.items.filter(i => i.code && i.count != null);
        if (!items.length) { out.textContent = '没读到“色号 数量”，请检查格式'; return; }
        const bad = res.items.filter(i => !i.code).map(i => i.raw);
        const ok = await confirmDialog(`${mode === 'add' ? '补货' : '设为'} ${items.length} 种颜色？`, {
          detail: items.slice(0, 12).map(i => `${i.code} ${mode === 'add' ? '+' : '='}${i.count}`).join('，') + (items.length > 12 ? '…' : '') + (bad.length ? `\n（无法识别：${bad.join('、')}）` : ''),
        });
        if (!ok) return;
        await store.applyChanges(items.map(i => mode === 'add' ? { code: i.code, delta: i.count } : { code: i.code, set: i.count }), { type: mode === 'add' ? 'restock' : 'import', note: '批量' });
        toast('已录入', 'ok'); sh.close(); app.rerender();
      },
    }, '录入列表'),
    out,
  ], { title: '批量录入库存', tall: true });
  renderSeg(); renderTabs(); renderGrid(); refresh();
}

// ---------- 库存流水 ----------

async function transactions(app, view) {
  const list = await store.listTransactions();
  if (!list.length) {
    view.append(h('div.empty', h('div.big-ico', '📒'), h('p', '还没有库存变动记录。')));
    return;
  }
  const patterns = new Map((await store.listPatterns()).map(p => [p.id, p]));
  const box = h('div.list', { style: { marginTop: '10px' } });
  for (const t of list.slice(0, 300)) {
    const sum = t.deltas.reduce((a, d) => a + d.delta, 0);
    const pname = t.patternId != null ? patterns.get(t.patternId)?.name : '';
    const deltas = h('div.tx-deltas', { hidden: true }, t.deltas.map(d => h('span', `${d.code} ${d.delta > 0 ? '+' : ''}${d.delta} → ${d.after}`)));
    box.append(h('div.li.click', { style: { flexWrap: 'wrap' }, onclick: () => { deltas.hidden = !deltas.hidden; } },
      h('div.grow',
        h('div', h('b', store.TX_TYPES[t.type] || t.type), pname ? ` · ${pname}` : '', t.note ? ` · ${t.note}` : '', t.undone ? h('span.tag', { style: { marginLeft: '6px' } }, '已撤销') : null),
        h('div.tiny.muted', `${fmtTime(t.time)} · ${t.deltas.length} 色`)),
      h('b.mono', { style: { color: sum < 0 ? 'var(--bad)' : 'var(--ok)' } }, (sum > 0 ? '+' : '') + fmtNum(sum)),
      h('div', { style: { flexBasis: '100%' } }, deltas)));
  }
  view.append(box, h('p.small.muted.center', '点一条记录可以看每个颜色的变化。拼豆扣减可以在图纸详情里撤销。'));
}
