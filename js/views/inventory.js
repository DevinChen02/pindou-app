// “库存”标签：每个色号还剩多少、待补货、补货/盘点、批量录入。
import { h, clear, toast, sheet, chip, fmtNum, fmtTime, confirmDialog } from '../ui.js';
import { PALETTE, SERIES, hexOf, normalizeCode } from '../palette.js';
import { parseLegendText } from '../extract/text.js';
import * as store from '../store.js';

const ui = { filter: 'owned', series: 'all', q: '' };

export async function renderInventory(app) {
  app.setTitle('库存');
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
  const draw = () => {
    clear(grid);
    const q = ui.q.trim().toUpperCase();
    let n = 0;
    for (const p of PALETTE.values()) {
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
    if (!n) grid.append(h('div.empty', { style: { gridColumn: '1 / -1' } },
      h('div.big-ico', ui.filter === 'low' ? '👍' : '🫘'),
      h('p', ui.filter === 'low' ? '没有需要补货的颜色' : ui.filter === 'owned' ? '还没有录入库存' : '没有匹配的色号'),
      ui.filter === 'owned' ? h('button.btn.primary', { onclick: () => batchSheet(app) }, '批量录入库存') : null));
  };
  search.addEventListener('input', () => { ui.q = search.value; draw(); });

  const filters = h('div.filters',
    [['owned', `有库存 ${ownedN}`], ['low', `待补货 ${lows.length}`], ['all', '全部 221']].map(([k, label]) =>
      h('button' + (ui.filter === k ? '.on' : ''), { onclick: () => { ui.filter = k; app.rerender(); } }, label)),
    h('span', { style: { width: '8px', flexShrink: 0 } }),
    ['all', ...SERIES].map(sr => h('button' + (ui.series === sr ? '.on' : ''), { onclick: () => { ui.series = sr; app.rerender(); } }, sr === 'all' ? '全系列' : sr)));

  view.append(h('div.inv-tools', search, filters));
  if (lows.length && ui.filter !== 'low') {
    view.append(h('div.banner.warn', { style: { cursor: 'pointer' }, onclick: () => { ui.filter = 'low'; app.rerender(); } },
      h('span.ico', '🛒'), h('div.grow', h('b', `${lows.length} 种颜色低于补货线`), h('div.small', lows.slice(0, 8).map(x => x.code).join('、') + (lows.length > 8 ? '…' : ''))), h('span', '›')));
  }
  view.append(grid);
  draw();
}

async function editSheet(app, code) {
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
  let mode = 'add';
  const ta = h('textarea.input', { placeholder: '每行一个：色号 数量\n例如：\nH7 1000\nH2 1000\nA11 500' });
  const out = h('div');
  const seg = h('div.seg');
  const renderSeg = () => {
    clear(seg);
    for (const [k, label] of [['add', '补货（加上）'], ['set', '盘点（设为）']]) seg.append(h('button' + (mode === k ? '.on' : ''), { onclick: () => { mode = k; renderSeg(); } }, label));
  };
  renderSeg();
  const seriesSel = h('select.input', ['全部 221 色', ...SERIES.map(s => `${s} 系列`)].map((l, i) => h('option', { value: i ? SERIES[i - 1] : 'all' }, l)));
  const seriesVal = h('input.input', { type: 'number', inputmode: 'numeric', placeholder: '颗数', style: { width: '100px' } });
  const sh = sheet([
    h('p.small.muted', '适合第一次录入或一次买了很多颜色。支持直接粘贴“色号 数量”列表。'),
    seg, h('div.spacer'), ta,
    h('button.btn.primary.block', {
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
    }, '录入'),
    out,
    h('div.section-title', '按系列一次设好（盘点）'),
    h('div.row.gap', seriesSel, seriesVal, h('button.btn', {
      onclick: async () => {
        const v = Math.round(+seriesVal.value);
        if (seriesVal.value === '' || v < 0) return toast('请输入颗数');
        const codes = [...PALETTE.values()].filter(p => seriesSel.value === 'all' || p.series === seriesSel.value).map(p => p.code);
        if (!(await confirmDialog(`把 ${codes.length} 个色号都设为 ${v} 颗？`, { detail: '适合刚买了整套色卡时使用。之后可以单独修改。' }))) return;
        await store.applyChanges(codes.map(code => ({ code, set: v })), { type: 'import', note: `${seriesSel.selectedOptions[0].textContent}设为 ${v}` });
        toast('已设置', 'ok'); sh.close(); app.rerender();
      },
    }, '设置')),
  ], { title: '批量录入库存', tall: true });
}
