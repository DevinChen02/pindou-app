// “历史”标签：图纸（待拼 / 已拼 / 撤销）和库存流水。
import { h, clear, toast, confirmDialog, chip, fmtNum, fmtTime } from '../ui.js';
import * as store from '../store.js';
import { newId } from '../extract/index.js';

const ui = { tab: 'patterns' };
const P_STATUS = { pending: ['待拼', 'accent'], done: ['已拼', 'ok'] };

export async function renderHistory(app) {
  app.setTitle('历史');
  const view = clear(app.view);
  view.append(h('div.seg', { style: { margin: '6px 0 12px' } },
    h('button' + (ui.tab === 'patterns' ? '.on' : ''), { onclick: () => { ui.tab = 'patterns'; app.rerender(); } }, '图纸'),
    h('button' + (ui.tab === 'tx' ? '.on' : ''), { onclick: () => { ui.tab = 'tx'; app.rerender(); } }, '库存流水')));
  if (ui.tab === 'patterns') await patterns(app, view);
  else await transactions(app, view);
}

async function patterns(app, view) {
  const list = await store.listPatterns();
  if (!list.length) {
    view.append(h('div.empty', h('div.big-ico', '🧩'), h('p', '还没有图纸。识别一张并确认后会出现在这里。')));
    return;
  }
  for (const p of list) {
    const total = p.items.reduce((a, i) => a + i.count, 0);
    const [label, cls] = P_STATUS[p.status] || ['—', ''];
    const card = h('div.card',
      h('div.pcard',
        p.thumbs?.[0] ? h('img', { src: p.thumbs[0], alt: '' }) : h('img', { alt: '' }),
        h('div.grow',
          h('div.row.between', h('div.t', p.name || '未命名'), h('span.tag.' + cls, label)),
          h('div.small.muted', `${p.items.length} 色 · ${fmtNum(total)} 颗 · ${fmtTime(p.createdAt)}`),
          h('div.row.wrap.gap-s', { style: { marginTop: '6px' } }, p.items.slice(0, 10).map(i => chip(i.code, { size: 'sm' })), p.items.length > 10 ? h('span.small.muted', '…') : null))),
      h('div.row.gap.end', { style: { marginTop: '12px' } },
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
        h('button.btn.sm.soft', { onclick: () => reuse(app, p) }, '再拼一次')));
    view.append(card);
  }
}

function sessionFromPattern(p, patternId) {
  return {
    id: newId(), createdAt: Date.now(), method: 'saved', name: p.name, patternId,
    images: [], statedTotal: p.statedTotal || null, statedColors: null, cursor: 0, mode: 'list',
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
