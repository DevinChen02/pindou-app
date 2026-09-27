// 库存预览（拼这幅图后每种颜色还剩多少）→ 确认拼豆 → 完成（补货提醒 / 撤销）
import { h, clear, toast, confirmDialog, chip, fmtNum, copyText } from '../ui.js';
import * as store from '../store.js';

function sessionItems(s) {
  return s.items.filter(i => i.code && i.count > 0).map(i => ({ code: i.code, count: i.count }));
}

const STATUS = {
  short: { tag: 'bad', text: '不够' },
  low: { tag: 'warn', text: '需补货' },
  ok: { tag: 'ok', text: '够用' },
};

export async function renderPreview(app) {
  const s = app.rec.session;
  if (!s) { app.rec.step = 'pick'; return app.render(); }
  const settings = app.settings;
  app.setTitle('库存预览');
  app.setBack(() => { app.rec.step = 'verify'; s.mode = 'list'; app.saveSession(); app.render(); });
  const view = clear(app.view);
  const inv = await store.getInventory();
  const rows = store.previewRows(sessionItems(s), inv, settings);
  const short = rows.filter(r => r.status === 'short');
  const low = rows.filter(r => r.status === 'low');
  const totalNeed = rows.reduce((a, r) => a + r.need, 0);

  const nameInput = h('input.input', { value: s.name || '', placeholder: '给这幅图起个名字' });
  nameInput.addEventListener('input', () => { s.name = nameInput.value; app.saveSession(); });
  view.append(h('div.field', h('label', '图纸名称'), nameInput));

  if (short.length) {
    const lack = short.reduce((a, r) => a + -r.after, 0);
    view.append(h('div.banner.bad', h('span.ico', '⛔️'), h('div',
      h('b', `${short.length} 种颜色不够，共缺 ${fmtNum(lack)} 颗`),
      h('div.small', '补货后再来确认；也可以先“存为待拼”，之后在“历史”里继续。'))));
  } else if (low.length) {
    view.append(h('div.banner.warn', h('span.ico', '⚠️'), h('div',
      h('b', '全部够用'), h('div.small', `但拼完后有 ${low.length} 种颜色会低于补货线。`))));
  } else {
    view.append(h('div.banner.ok', h('span.ico', '✅'), h('div', h('b', '全部够用'), h('div.small', '拼完后所有颜色都还在补货线以上。'))));
  }
  if (Number(settings.lossPercent) > 0) view.append(h('p.small.muted', `“需要”已按损耗 ${settings.lossPercent}% 向上取整。`));

  const table = h('table.ptable',
    h('thead', h('tr', h('th', '颜色'), h('th', '需要'), h('th', '现有'), h('th', '拼后'), h('th', ''))),
    h('tbody', rows.map(r => h('tr.' + r.status,
      h('td', chip(r.code, { size: 'sm' })),
      h('td', fmtNum(r.need)),
      h('td', fmtNum(r.stock)),
      h('td.after' + (r.after < 0 ? '.neg' : r.status === 'low' ? '.low' : ''), r.after < 0 ? `缺 ${fmtNum(-r.after)}` : fmtNum(r.after)),
      h('td.stcell', h('span.tag.' + STATUS[r.status].tag, STATUS[r.status].text))))));
  view.append(h('div.table-wrap', table));
  view.append(h('p.small.muted', `共 ${rows.length} 色、${fmtNum(totalNeed)} 颗。补货线：默认 ${settings.defaultThreshold} 颗（可在库存里为单个颜色另设）。`));

  const saveAsPending = async () => {
    const pid = await ensurePattern(s, 'pending');
    await store.clearSession();
    app.rec.session = null;
    app.rec.step = 'pick';
    toast('已存为待拼，可在“历史”里继续', 'ok');
    app.go('history');
    return pid;
  };

  view.append(h('div.sticky-actions',
    h('button.btn.primary.big.block', {
      disabled: short.length > 0,
      onclick: async () => {
        const ok = await confirmDialog('确认开始拼这幅图？', {
          ok: '确认，扣减库存',
          detail: `将从库存扣减 ${rows.length} 种颜色，共 ${fmtNum(totalNeed)} 颗。之后可以在“历史”里撤销。`,
        });
        if (!ok) return;
        try {
          const pid = await ensurePattern(s, 'pending');
          const txId = await store.commitPattern(pid, rows);
          app.rec.result = { txId, patternId: pid, rows, name: s.name };
          app.rec.step = 'done';
          await store.clearSession();
          app.render();
        } catch (e) {
          toast(e.message, 'error');
          app.render();
        }
      },
    }, short.length ? `还缺 ${short.length} 种颜色，不能确认` : '确认拼豆，扣减库存'),
    h('div.row.gap',
      h('button.btn.grow', { onclick: saveAsPending }, '存为待拼'),
      (short.length || low.length) ? h('button.btn.grow', { onclick: () => copyText(shoppingList(short, low)) }, '复制补货清单') : null)));
}

function shoppingList(short, low) {
  const lines = [];
  if (short.length) lines.push('【缺货】', ...short.map(r => `${r.code}：缺 ${-r.after} 颗（需要 ${r.need}，现有 ${r.stock}）`));
  if (low.length) lines.push('【拼完需补】', ...low.map(r => `${r.code}：拼完剩 ${r.after} 颗（补货线 ${r.threshold}）`));
  return lines.join('\n');
}

async function ensurePattern(s, status) {
  const items = sessionItems(s);
  if (s.patternId) {
    const p = await store.getPattern(s.patternId);
    if (p) {
      await store.updatePattern({ ...p, name: s.name || p.name, items });
      return s.patternId;
    }
  }
  const t = { images: s.images.map(im => im.thumb).filter(Boolean).slice(0, 4) };
  const id = await store.savePattern({
    name: s.name || '未命名图纸', status, items, method: s.method,
    statedTotal: s.statedTotal || null, thumbs: t.images,
  });
  s.patternId = id;
  return id;
}

export async function renderDone(app) {
  const res = app.rec.result;
  const tx = res && (await store.listTransactions()).find(t => t.id === res.txId);
  if (!res || !tx || tx.undone) { app.rec.result = null; app.rec.step = 'pick'; return app.render(); }
  app.setTitle('已开始拼豆');
  const settings = app.settings;
  const view = clear(app.view);
  const inv = await store.getInventory();
  const used = res.rows.map(r => r.code);
  const need = used.map(code => ({ code, stock: store.stockOf(inv, code), threshold: store.thresholdOf(inv, code, settings) }))
    .filter(x => x.stock < x.threshold);
  const others = store.lowStockList(inv, settings).filter(x => !used.includes(x.code));
  const total = res.rows.reduce((a, r) => a + r.need, 0);

  view.append(h('div.banner.ok', h('span.ico', '✅'), h('div', h('b', `“${res.name || '这幅图'}”已扣减库存`), h('div.small', `${res.rows.length} 种颜色，共 ${fmtNum(total)} 颗。`))));

  if (need.length) {
    view.append(h('div.card',
      h('h2', `🛒 这些颜色该补货了（${need.length}）`),
      h('p.small.muted', '拼完后剩余已低于补货线：'),
      h('div.list', need.map(x => h('div.li',
        chip(x.code, { size: 'md' }),
        h('div.grow', h('b.mono', `剩 ${fmtNum(x.stock)} 颗`), h('div.tiny.muted', `补货线 ${x.threshold}`)),
        h('span.tag.warn', '需补货')))),
      h('div.spacer'),
      h('button.btn.block', { onclick: () => copyText(need.map(x => `${x.code}：剩 ${x.stock} 颗`).join('\n')) }, '复制补货清单')));
  } else {
    view.append(h('div.card', h('h2', '👍 用到的颜色都还充足'), h('p.small.muted', '拼完后都在补货线以上。')));
  }
  if (others.length) view.append(h('p.small.muted', `另外还有 ${others.length} 种颜色之前就低于补货线，可在“库存 → 待补货”查看。`));

  view.append(h('div.col', { style: { marginTop: '12px' } },
    h('button.btn.primary.big.block', { onclick: () => { app.rec.result = null; app.rec.session = null; app.rec.step = 'pick'; app.render(); } }, '完成'),
    h('button.btn.block', {
      onclick: async () => {
        if (!(await confirmDialog('撤销这次扣减？', { ok: '撤销', danger: true, detail: '库存会恢复到确认之前，这幅图会变回“待拼”。' }))) return;
        try {
          await store.undoTransaction(res.txId);
          toast('已撤销', 'ok');
          app.rec.result = null;
          app.rec.step = 'pick';
          app.go('history');
        } catch (e) { toast(e.message, 'error'); }
      },
    }, '撤销这次扣减'),
    h('button.btn.ghost.block', { onclick: () => app.go('inventory') }, '查看库存')));
}
