// 添加图纸的最后一步：起名、加分类、对照库存 → 保存到图纸库（或直接开始拼豆）
import { h, clear, toast, chip, fmtNum, copyText } from '../ui.js';
import * as store from '../store.js';
import { openImageViewer, entriesFromImages, hasViewable } from '../viewer.js';
import { tagSheet, goPattern } from './patterns.js';

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
  app.setTitle(s.patternId ? '保存修改' : '保存图纸');
  app.setBack(() => { app.rec.step = 'verify'; s.mode = 'list'; app.saveSession(); app.render(); });
  const view = clear(app.view);
  const inv = await store.getInventory();
  const rows = store.previewRows(sessionItems(s), inv, settings);
  const short = rows.filter(r => r.status === 'short');
  const low = rows.filter(r => r.status === 'low');
  const totalNeed = rows.reduce((a, r) => a + r.need, 0);

  const nameInput = h('input.input', { value: s.name || '', placeholder: '给这幅图起个名字' });
  nameInput.addEventListener('input', () => { s.name = nameInput.value; app.saveSession(); });
  view.append(h('div.field', h('label', '图纸名称'),
    hasViewable(s.images)
      ? h('div.row.gap', h('div.grow', { style: { minWidth: 0 } }, nameInput), h('button.btn.soft', { onclick: () => openImageViewer(entriesFromImages(s.images), { view: 'full', focus: false }) }, '🖼 看图纸'))
      : nameInput));

  if (short.length) {
    const lack = short.reduce((a, r) => a + -r.after, 0);
    view.append(h('div.banner.bad', h('span.ico', '⛔️'), h('div',
      h('b', `${short.length} 种颜色不够，共缺 ${fmtNum(lack)} 颗`),
      h('div.small', '可以先存到图纸库，补货后再拼；也可以先拼够的颜色。'))));
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

  // 分类（保存时一起存）
  const tagRow = h('div.pd-tags', { style: { margin: '10px 0 2px' } });
  const drawTags = () => {
    clear(tagRow);
    for (const t of s.tags || []) tagRow.append(h('span.tagchip.big', '#' + t));
    tagRow.append(h('button.tagadd', { onclick: () => tagSheet(app, { tags: s.tags || [] }, { onSave: tags => { s.tags = tags; app.saveSession(); drawTags(); } }) }, s.tags?.length ? '✎ 分类' : '＋ 加分类'));
  };
  drawTags();
  view.insertBefore(tagRow, view.children[1]);

  const save = async build => {
    try {
      const isEdit = !!s.patternId;
      const pid = await ensurePattern(s, 'pending');
      await store.clearSession();
      app.rec.session = null;
      app.rec.step = 'pick';
      if (build) { await store.startBuild(pid); return goPattern(app, pid, 'build'); }
      toast(isEdit ? '已保存修改' : '已保存到图纸库', 'ok');
      return goPattern(app, pid);
    } catch (e) { toast(e.message, 'error'); }
  };

  view.append(h('div.sticky-actions',
    s.patternId
      ? h('button.btn.primary.big.block', { onclick: () => save(false) }, '保存修改')
      : [h('button.btn.primary.big.block', { onclick: () => save(true) }, '保存并开始拼豆'),
        h('button.btn.big.block', { onclick: () => save(false) }, '先存到图纸库'),
        (short.length || low.length) ? h('button.btn.ghost.block', { onclick: () => copyText(shoppingList(short, low)) }, '复制补货清单') : null]));
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
      // 颜色变了：拼豆板按旧颜色认的格子不准了，下次拼豆时重新生成
      const same = p.items.map(i => i.code).sort().join() === items.map(i => i.code).sort().join();
      await store.updatePattern({ ...p, name: s.name || p.name, items, tags: s.tags || p.tags || [], ...(same ? {} : { board: null, boardError: null }) });
      return s.patternId;
    }
  }
  const t = { images: s.images.map(im => im.thumb).filter(Boolean).slice(0, 4) };
  // 整张图纸原图跟着图纸保存，以后能放大看、生成拼豆板；legend 是清单在原图上的位置（生成拼豆板时避开它）
  const images = s.images.filter(im => im.fullId).map(im => ({
    fullId: im.fullId, fw: im.fw, fh: im.fh, name: im.name || '',
    legend: im.fullMap ? { x: im.fullMap.ox, y: im.fullMap.oy, w: im.dw * im.fullMap.k, h: im.dh * im.fullMap.k } : null,
  }));
  const id = await store.savePattern({
    name: s.name || '未命名图纸', status, items, method: s.method, tags: s.tags || [],
    statedTotal: s.statedTotal || null, thumbs: t.images,
    images, imageIds: images.map(im => im.fullId),
  });
  s.patternId = id;
  return id;
}
