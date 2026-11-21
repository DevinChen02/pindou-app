// 多个仓库的界面：库存页顶上的仓库列表（切换、新建）、仓库设置（名字、色卡、默认补货线、快捷补货按钮、删除），
// 别的页面用的“🏠 仓库 ▾”按钮，结算时的“从哪个仓库扣”。只有一个仓库时，后两样都不出现。
import { h, clear, toast, sheet, confirmDialog, fmtNum, chip } from '../ui.js';
import * as store from '../store.js';
import { PALETTE, SERIES, BASE_SERIES, seriesLabel } from '../palette.js';
import { readOnlyToast } from '../license.js';

/** “🏠 名字 ▾”按钮（只有一个仓库时返回 null）。点开选仓库，onPick(id) */
export function whButton(list, value, onPick, { title = '用哪个仓库的库存', note = null } = {}) {
  if (list.length < 2) return null;
  const w = list.find(x => x.id === value) || list[0];
  return h('button.wh-btn', { type: 'button', 'data-wh': w.id, 'aria-label': `仓库：${w.name}（点一下换）`, onclick: () => pickWh(list, w.id, onPick, { title, note }) },
    h('span.wh-ico', '🏠'), h('span.wh-name', w.name), h('span.caret', '▾'));
}

/** 选一个仓库的弹层。note(w)：每个仓库下面的一行小字（比如“缺 3 色”） */
export function pickWh(list, value, onPick, { title = '用哪个仓库的库存', note = null } = {}) {
  const s = sheet(h('div.opt-list', list.map(w => h('button.opt' + (w.id === value ? '.on' : ''), {
    'data-wh': w.id,
    onclick: async () => { s.close(); if (w.id !== value) await onPick(w.id); },
  }, h('div.grow', h('div.opt-t', w.name), note ? h('div.tiny.muted', note(w)) : null), h('span.opt-ck', w.id === value ? '✓' : '')))), { title });
}

/** 结算时“从哪个仓库扣”：一排可以点的仓库（只有一个仓库时返回 null）；note(w)：名字后面的小字（“够”“缺 3 色”） */
export function whChoice(list, value, onChange, { label = '从哪个仓库扣', note = null } = {}) {
  if (list.length < 2) return null;
  let cur = value;
  const box = h('div.wh-choice');
  const draw = () => box.replaceChildren(h('div.small.muted', label),
    h('div.wh-pills', list.map(w => h('button.tagopt.wh-pill' + (w.id === cur ? '.on' : ''), {
      type: 'button', 'data-wh': w.id,
      onclick: () => { if (cur === w.id) return; cur = w.id; draw(); onChange(w.id); },
    }, w.name, note ? h('span.wh-pill-n', note(w)) : null))));
  draw();
  return box;
}

/** 这些颜色和颗数（{ 色号: 颗数 }）在一个仓库里够不够：“够”或“缺 3 色” */
export async function shortNote(amounts, settings) {
  const notes = new Map();
  for (const w of await store.listWarehouses()) {
    const inv = await store.getInventory(w.id);
    const n = Object.entries(amounts).filter(([code, need]) => need > 0 && store.stockOf(inv, code) < need).length;
    notes.set(w.id, n ? `缺 ${n} 色` : '够');
  }
  return w => notes.get(w.id) || '';
}

/** 库存页顶上点仓库名：仓库列表（每个写色卡、有库存几色几颗、几种待补货），点一个切过去；设置；新建 */
export async function warehouseSheet(app) {
  const sums = await store.warehouseSummaries(app.settings);
  const cur = await store.currentWh();
  const s = sheet([
    h('div.wh-list', sums.map(({ w, colors, beads, low }) => h('div.wh-row' + (w.id === cur.id ? '.on' : ''), { 'data-wh': w.id },
      h('button.wh-main', {
        onclick: async () => { s.close(); if (w.id !== cur.id) { await store.setCurrentWh(w.id); toast(`现在是“${w.name}”`); } app.rerender(); },
      },
      h('span.opt-ck', w.id === cur.id ? '✓' : ''),
      h('div.grow', h('div.opt-t', w.name), h('div.tiny.muted', `${store.cardLabel(w)} · 有库存 ${colors} 色 · ${fmtNum(beads)} 颗${low ? ` · ${low} 色待补货` : ''}`))),
      h('button.btn.sm.soft.wh-set', { onclick: () => { s.close(); editWarehouse(app, w); } }, '设置')))),
    h('button.btn.soft.block.wh-new', { style: { marginTop: '12px' }, onclick: () => { s.close(); editWarehouse(app, null); } }, '＋ 新建仓库'),
    h('p.tiny.muted', { style: { margin: '10px 2px 0' } }, '每个仓库的库存、补货线、流水各管各的。图纸对照库存、结算扣库存时可以选用哪个仓库。'),
  ], { title: '仓库', tall: sums.length > 3 });
}

const CARD_KINDS = [['all', '全部'], ['base', '基础色'], ['series', '选系列'], ['codes', '选颜色']];

/**
 * 仓库设置（w = null：新建）：名字、色卡（这个仓库有哪些颜色）、默认补货线、快捷补货按钮；删除。
 * 新建的仓库照着当前仓库填好补货线和快捷按钮，建好就切过去。onDone()：保存后（默认重画页面）
 */
export async function editWarehouse(app, w, { onDone = null } = {}) {
  if (app.readOnly) { readOnlyToast(app.readOnly); return; }
  const cur = await store.currentWh();
  const isNew = !w;
  const st = { card: structuredClone(w?.card || { kind: 'all' }) };
  const name = h('input.input.wh-name-in', { value: w?.name || '', placeholder: '比如：家里、工作室', maxlength: 20 });
  const th = h('input.input.num.wh-th', { type: 'number', inputmode: 'numeric', pattern: '[0-9]*', min: 0, value: (w || cur).threshold ?? app.settings.defaultThreshold });
  const ps = h('input.input.wh-ps', { value: ((w || cur).presets || app.settings.restockPresets).join(', '), inputmode: 'numeric' });
  const cardBox = h('div.wh-card');
  const drawCard = () => {
    const c = st.card;
    clear(cardBox).append(...[
      h('div.seg.wh-card-seg', CARD_KINDS.map(([k, label]) => h('button' + (c.kind === k ? '.on' : ''), {
        type: 'button', 'data-kind': k,
        onclick: () => {
          if (k === 'series') st.card = { kind: 'series', series: c.series?.length ? c.series : [...BASE_SERIES] };
          else if (k === 'codes') st.card = { kind: 'codes', codes: c.codes?.length ? c.codes : store.cardCodes({ card: c }) };
          else st.card = { kind: k };
          drawCard();
        },
      }, label))),
      c.kind === 'series' ? h('div.tag-pick.wh-series', SERIES.map(sr => h('button.tagopt' + (c.series.includes(sr) ? '.on' : ''), {
        type: 'button', 'data-series': sr,
        onclick: () => { c.series = c.series.includes(sr) ? c.series.filter(x => x !== sr) : [...c.series, sr]; drawCard(); },
      }, seriesLabel(sr)))) : null,
      c.kind === 'codes' ? h('button.btn.sm.soft.wh-pick-codes', { type: 'button', onclick: async () => { const got = await pickCodes(new Set(c.codes)); if (got) { c.codes = [...got]; drawCard(); } } }, `点选颜色（已选 ${store.cardCodes({ card: c }).length} 色）`) : null,
      h('div.tiny.muted.wh-card-sum', `${store.cardLabel({ card: c })}。库存页只列这些颜色（不在色卡里、但有库存的也会列出来）；生成图纸可以选“只用这个仓库的色卡”。`)].filter(Boolean));
  };
  drawCard();

  const save = async () => {
    const card = st.card;
    if (card.kind === 'series' && !card.series.length) return toast('至少选一个系列', 'error');
    if (card.kind === 'codes' && !card.codes.length) return toast('至少选一个颜色', 'error');
    const presets = ps.value.split(/[,，\s]+/).map(Number).filter(n => n > 0);
    try {
      if (isNew) {
        const id = await store.createWarehouse({ name: name.value, card, threshold: th.value, presets });
        await store.setCurrentWh(id);
        toast(`已新建“${name.value.trim()}”，现在是这个仓库`, 'ok');
      } else {
        await store.updateWarehouse(w.id, { name: name.value, card, threshold: th.value === '' ? w.threshold : th.value, presets });
        toast('已保存', 'ok');
      }
      s.close();
      if (onDone) onDone(); else app.rerender();
    } catch (e) { toast(e.message, 'error'); }
  };

  const del = async () => {
    const live = await store.listWarehouses();
    if (live.length <= 1) return toast('至少要留一个仓库', 'error');
    const inv = await store.getInventory(w.id);
    let colors = 0, beads = 0;
    for (const r of inv.values()) if ((r.stock || 0) > 0) { colors++; beads += r.stock; }
    const ok = await confirmDialog(`删除仓库“${w.name}”？`, {
      ok: '删除', danger: true,
      detail: (beads ? `这个仓库里还有 ${colors} 色、${fmtNum(beads)} 颗，会一起删掉。` : '这个仓库里没有库存。') + '流水保留（写着“已删除”）；图纸里从这个仓库扣过的，撤销时豆子没地方加回去。',
    });
    if (!ok) return;
    try {
      await store.deleteWarehouse(w.id);
      toast(`已删除“${w.name}”`, 'ok');
      s.close();
      if (onDone) onDone(); else app.rerender();
    } catch (e) { toast(e.message, 'error'); }
  };

  const s = sheet([
    h('div.field', h('label', '仓库名字'), name),
    h('div.section-title', '色卡：这个仓库有哪些颜色'), cardBox,
    h('div.card.wh-nums', { style: { marginTop: '12px' } },
      h('div.kv', h('div', h('div.k', '默认补货线（颗）'), h('div.d', '某色剩余低于它就提醒补货；可在库存里给单色另设')), th),
      h('div.kv', h('div', h('div.k', '快捷补货按钮'), h('div.d', '库存页里一键 +N，用逗号分隔')), ps)),
    h('div.row.between', { style: { marginTop: '14px' } },
      isNew ? h('span') : h('button.btn.ghost.wh-del', { onclick: del }, '删除仓库'),
      h('div.row.gap', h('button.btn.ghost', { onclick: () => s.close() }, '取消'), h('button.btn.primary.wh-save', { onclick: save }, isNew ? '新建' : '保存'))),
  ], { title: isNew ? '新建仓库' : `仓库设置 · ${w.name}`, tall: true });
  if (isNew) setTimeout(() => name.focus(), 250);
}

/** 点选颜色（按系列分页，可以多选，换系列也保留）。返回选中的色号 Set，取消返回 null */
function pickCodes(initial) {
  return new Promise(resolve => {
    const picked = new Set(initial);
    let series = SERIES[0], done = false;
    const tabs = h('div.series-tabs'), grid = h('div.code-grid'), info = h('div.small.muted');
    const draw = () => {
      tabs.replaceChildren(...SERIES.map(sr => {
        const n = [...PALETTE.values()].filter(p => p.series === sr && picked.has(p.code)).length;
        return h('button.tab' + (sr === series ? '.on' : ''), { type: 'button', onclick: () => { series = sr; draw(); } }, sr, n ? h('sup.tab-n', n) : null);
      }));
      grid.replaceChildren(...[...PALETTE.values()].filter(p => p.series === series).map(p => h('button.code-cell' + (picked.has(p.code) ? '.on' : ''), {
        type: 'button', 'data-code': p.code,
        onclick: () => { if (picked.has(p.code)) picked.delete(p.code); else picked.add(p.code); draw(); },
      }, chip(p.code, { size: 'sm' }))));
      info.textContent = `已选 ${picked.size} 色`;
    };
    const s = sheet([
      h('div.row.between', info, h('div.row.gap-s',
        h('button.btn.sm.ghost', { type: 'button', onclick: () => { for (const p of PALETTE.values()) if (p.series === series) picked.add(p.code); draw(); } }, '全选本系列'),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => { for (const p of PALETTE.values()) if (p.series === series) picked.delete(p.code); draw(); } }, '本系列不选'))),
      tabs, grid,
      h('div.wh-codes-foot', h('button.btn.primary.block.wh-codes-done', { onclick: () => { done = true; s.close(); resolve(picked); } }, '选好了')),
    ], { title: '这个仓库有哪些颜色', tall: true, onClose: () => { if (!done) resolve(null); } });
    draw();
  });
}
