// 逐项核对：每个色号和数量都要人确认一遍才能进入库存预览。
import { h, clear, toast, confirmDialog, chip, pickCode, stepper, fmtNum } from '../ui.js';
import { hexOf } from '../palette.js';
import { colorCheck, itemIssues, totalsCheck, newId } from '../extract/index.js';
import * as store from '../store.js';
import { openImageViewer, entriesFromImages, hasViewable } from '../viewer.js';
import { renderOverview, hasOverview, addColorSheet } from './overview.js';

function issueLevel(item, s) {
  const is = itemIssues(item, s);
  if (is.some(i => i.level === 'error')) return 'e';
  if (is.some(i => i.level === 'warn')) return 'w';
  return '';
}

export async function renderVerify(app) {
  const s = app.rec.session;
  if (!s) { app.rec.step = 'pick'; return app.render(); }
  if (s.mode === 'overview') {
    if (hasOverview(s)) return renderOverview(app, { discard });
    s.mode = s.items.length ? 'card' : 'list';
  }
  if (s.mode === 'colors') {
    if (hasColorsStep(s)) return renderColors(app);
    s.mode = s.items.length ? 'card' : 'list';
  }
  if (s.mode === 'list' || !s.items.length) return renderList(app);
  return renderCard(app);
}

async function discard(app) {
  const pid = app.rec.session?.patternId;
  if (pid) {
    // 修改已保存图纸的颜色：放弃修改，回到图纸详情
    if (!(await confirmDialog('放弃这次修改？', { ok: '放弃', danger: true, detail: '图纸保持原来的颜色和数量。' }))) return;
    app.rec.session = null; app.rec.step = 'pick';
    await store.clearSession();
    app.pat.page = 'detail'; app.pat.id = pid;
    return app.render();
  }
  if (!(await confirmDialog('放弃这次识别？', { ok: '放弃', danger: true, detail: '已核对的内容不会保存。' }))) return;
  const ids = store.sessionImageIds(app.rec.session);
  app.rec.session = null;
  app.rec.step = 'pick';
  await store.clearSession();
  store.deleteImagesIfUnused(ids);
  app.render();
}

// ---------- 第一步：颜色齐不齐（没有位置信息、但附了截图时；有位置信息的用“识别总览”） ----------

/** 有截图可对照、又没有位置信息（总览画不出框）时，先单独看一眼颜色齐不齐 */
export function hasColorsStep(s) {
  return !hasOverview(s) && hasViewable(s.images);
}
/** 回到“看颜色齐不齐”那一步的按钮（总览或颜色页） */
function phase1Button(app, s) {
  if (hasOverview(s)) return h('button.btn.sm.soft', { onclick: () => { s.mode = 'overview'; app.saveSession(); app.render(); } }, '总览');
  if (hasColorsStep(s)) return h('button.btn.sm.soft', { onclick: () => { s.mode = 'colors'; app.saveSession(); app.render(); } }, '颜色');
  return null;
}

function renderColors(app) {
  const s = app.rec.session;
  app.setTitle('先看颜色齐不齐');
  app.setBack(() => discard(app));
  app.actions.append(h('button.btn.sm.soft', { onclick: () => { s.mode = 'list'; app.saveSession(); app.render(); } }, '列表'));
  const view = clear(app.view);
  const t = totalsCheck(s);
  view.append(h('div.banner.info', h('span.ico', '👀'), h('div',
    h('b', '先对着整张图看一遍：图上的每种颜色下面都有吗？'),
    h('div.small', '漏掉的点“补一个漏掉的颜色”，可以连着补好几个；全齐了再逐个核对数量。'))));
  s.images.forEach((im, k) => {
    if (!(im.display || im.fullId)) return;
    const open = () => openImageViewer(entriesFromImages(s.images), { index: k, view: im.display ? 'legend' : 'full', focus: false });
    view.append(im.display
      ? h('div.ref', h('div.ref-full.colors-img', { onclick: open }, h('img', { src: im.display, alt: '清单' }), h('span.tap', '点开放大')))
      : h('button.btn.block.soft', { onclick: open }, `🖼 看${s.images.length > 1 ? `第 ${k + 1} 张` : ''}原图`));
  });
  view.append(h('div.section-title', `识别出 ${t.colors} 种颜色${s.statedColors ? `（图上写 ${s.statedColors} 色）` : ''}`));
  view.append(h('div.colors-chips', s.items.map(it => h('div.colors-chip' + (it.added ? '.added' : ''),
    chip(it.code || '?', { size: 'sm', label: it.code || it.rawCode || '?' }),
    h('span.n', it.count != null ? `×${fmtNum(it.count)}` : '×?')))));
  view.append(h('button.btn.soft.block', { style: { marginTop: '12px' }, onclick: async () => { if (await addColorSheet(app)) app.rerender(); } }, '＋ 补一个漏掉的颜色'));
  view.append(h('div.sticky-actions',
    s.items.length
      ? h('button.btn.primary.big.block', {
        onclick: () => { s.mode = 'card'; const k = s.items.findIndex(i => !i.verified); s.cursor = k >= 0 ? k : 0; app.saveSession(); app.render(); },
      }, `颜色齐了，开始核对数量（${s.items.length} 项）`)
      : null));
}

// ---------- 逐项卡片 ----------

function renderCard(app) {
  const s = app.rec.session;
  s.cursor = Math.min(Math.max(0, s.cursor || 0), s.items.length - 1);
  const item = s.items[s.cursor];
  const n = s.items.length;
  const doneN = s.items.filter(i => i.verified).length;
  app.setTitle('逐项核对');
  app.setBack(() => discard(app));
  const p1 = phase1Button(app, s);
  if (p1) app.actions.append(p1);
  app.actions.append(h('button.btn.sm.soft', { onclick: () => { s.mode = 'list'; app.saveSession(); app.render(); } }, '列表'));
  const view = clear(app.view);

  // 顶部进度
  view.append(h('div.verify-top',
    h('div.row.between.small',
      h('b', `第 ${s.cursor + 1} / ${n} 项`),
      h('span.muted', `已确认 ${doneN} 项`)),
    h('div.progress', { style: { marginTop: '6px' } }, h('i', { style: { width: (doneN / n * 100) + '%' } })),
    h('div.dots', s.items.map((it, k) => h('i' + (it.verified ? '.v' : issueLevel(it, s) ? '.' + issueLevel(it, s) : '') + (k === s.cursor ? '.cur' : ''), {
      title: it.code || '?', onclick: () => { s.cursor = k; app.saveSession(); app.render(); },
    })))));

  // 参考图：有位置信息时先放“放大的局部”，整张清单放在卡片下面
  const zoom = zoomPanel(s, item);
  const full = fullPanel(s, item, !!zoom);
  view.append(zoom || full || h('div'));
  const links = refLinks(s, item);
  if (links) view.append(links);

  // 识别结果卡片
  const cc = colorCheck(item);
  const issues = itemIssues(item, s);
  const hasError = issues.some(i => i.level === 'error');
  const update = patch => { Object.assign(item, patch, { verified: false }); app.saveSession(); app.rerender(); };

  const countInput = stepper(item.count, v => {
    item.count = v; item.verified = false; app.saveSession();
    big.textContent = v ? fmtNum(v) : '未读出';
    big.classList.toggle('missing', !v);
    okBtn.disabled = !(item.code && v > 0);
    okBtn.textContent = item.code && v > 0 ? '✓ 对了，下一项' : '先补全色号和数量';
  }, { big: true });
  const big = h('div.count-big' + (item.count ? '' : '.missing'), item.count ? fmtNum(item.count) : '未读出');

  const okBtn = h('button.btn.ok.big', {
    disabled: hasError,
    onclick: () => {
      if (!(item.code && item.count > 0)) return;
      item.verified = true;
      const next = s.items.findIndex((it, k) => k > s.cursor && !it.verified);
      const any = next >= 0 ? next : s.items.findIndex(it => !it.verified);
      if (any < 0) { s.mode = 'list'; toast('全部核对完了 ✓', 'ok'); } else s.cursor = any;
      app.saveSession();
      app.render();
    },
  }, hasError ? '先补全色号和数量' : '✓ 对了，下一项');

  view.append(h('div.vcard',
    h('div.small.muted', '识别结果'),
    h('div.result', { style: { marginTop: '6px' } },
      chip(item.code || '?', { size: 'lg', label: item.code || (item.rawCode ? item.rawCode : '?') }),
      h('span.times', '×'),
      big),
    cc ? h('div.cmp',
      h('span', '图中取色'), h('span.sw', { style: { background: `rgb(${item.rgb.join(',')})` } }),
      item.code ? [h('span', '标准色'), h('span.sw', { style: { background: hexOf(item.code) } })] : null,
      cc.status === 'match' ? h('span.tag.ok', '颜色一致') : cc.status === 'near' ? h('span.tag', '颜色接近') : cc.status === 'mismatch' ? h('span.tag.warn', '颜色差别大') : null) : null,
    cc && cc.status !== 'match' && cc.suggestions.length ? h('div.row.wrap.gap-s.small', { style: { marginTop: '6px' } },
      h('span.muted', '按颜色看可能是：'),
      cc.suggestions.slice(0, 3).map(c => h('button.code-cell', { onclick: () => update({ code: c }) }, chip(c, { size: 'sm' })))) : null,
    issues.length ? h('div.issues', issues.map(i => h('div.issue.' + i.level, i.text))) : null,
    h('div.edit-grid',
      h('span.lbl', '色号'),
      h('button.code-btn', {
        onclick: async () => {
          const c = await pickCode({ current: item.code, suggestions: cc?.suggestions || [] });
          if (c) update({ code: c });
        },
      }, chip(item.code || '?', { size: 'sm' }), h('span', item.code ? '点这里更改' : '点这里选择色号'), h('span.chev', '›')),
      h('span.lbl', '数量'),
      countInput),
    (item.orig && (item.orig.code !== item.code || item.orig.count !== item.count))
      ? h('div.orig', `原识别：${item.orig.code || item.rawCode || '?'} × ${item.orig.count ?? '?'}`) : null,
  ));
  if (zoom && full) view.append(full);
  view.append(h('div.sticky-actions', h('div.vactions',
    h('button.btn.ghost', {
      onclick: async () => {
        if (!(await confirmDialog(`删除 ${item.code || '这一项'}？`, { ok: '删除', danger: true, detail: '比如它不是颜色（空格、总数），或者被重复识别了。' }))) return;
        s.items.splice(s.cursor, 1);
        if (!s.items.length) s.mode = 'list';
        app.saveSession(); app.render();
      },
    }, '删除'),
    h('button.btn.soft', { disabled: s.cursor === 0, 'aria-label': '上一项', onclick: () => { s.cursor--; app.saveSession(); app.render(); } }, '‹'),
    okBtn)));
}

/** 放大的局部：当前条目的色块（实线框）和数量（虚线框） */
function zoomPanel(s, item) {
  const img = item.img != null ? s.images[item.img] : null;
  if (!img || !item.box) return null;
  const cv = h('canvas');
  const wrap = h('div.ref', h('div.ref-zoom', { onclick: () => viewItem(s, item, 'legend') }, cv, h('span.lbl', '图中（放大）')));
  const im = new Image();
  im.onload = () => {
    const u = unionBox(item.box, item.countBox);
    const bw = u.x1 - u.x0, bh = u.y1 - u.y0;
    const padX = Math.max(bw * 0.6, 30), padY = Math.max(bh * 0.5, 24);
    const sx = Math.max(0, u.x0 - padX), sy = Math.max(0, u.y0 - padY);
    const sw = Math.min(im.naturalWidth, u.x1 + padX) - sx, sh = Math.min(im.naturalHeight, u.y1 + padY) - sy;
    const maxW = Math.min(wrap.clientWidth || 360, 700), maxH = 170;
    const k = Math.min(maxW / sw, maxH / sh, 5);
    const dpr = window.devicePixelRatio || 1;
    cv.width = sw * k * dpr; cv.height = sh * k * dpr;
    cv.style.width = sw * k + 'px'; cv.style.height = sh * k + 'px';
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = k < 2.5;
    g.drawImage(im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8604c';
    const rect = (b, dash) => {
      g.save();
      g.strokeStyle = accent; g.lineWidth = 3 * dpr;
      if (dash) g.setLineDash([6 * dpr, 4 * dpr]);
      g.strokeRect((b.x0 - sx) * k * dpr, (b.y0 - sy) * k * dpr, (b.x1 - b.x0) * k * dpr, (b.y1 - b.y0) * k * dpr);
      g.restore();
    };
    rect(item.box, false);
    if (item.countBox) rect(item.countBox, true);
  };
  im.src = img.display;
  return wrap;
}

/** 整张清单（高亮当前项），点开可全屏放大；没有截图时显示粘贴的文字 */
function fullPanel(s, item, below) {
  const img = item.img != null ? s.images[item.img] : (s.images.length === 1 ? s.images[0] : null);
  if (!img?.display) {
    if (img?.fullId) return null; // 只有整张图（比如从“历史”里打开的图纸）：用下面的“看完整原图”

    return s.rawText ? h('div.ref', h('div', { style: { padding: '12px 14px' } },
      h('div.small.muted', '粘贴的文字（没有附截图）：'),
      h('pre.small', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: '140px', overflow: 'auto' } }, s.rawText))) : null;
  }
  const hasBox = item.img != null && item.box;
  const full = h('div.ref-full', h('img', { src: img.display, alt: '清单' }),
    h('span.tap', s.images.length > 1 ? `第 ${(item.img ?? 0) + 1} 张 · 点开放大` : '点开放大'));
  if (hasBox) {
    const b = item.box;
    full.append(h('div.hl', { style: {
      left: (b.x0 / img.dw * 100) + '%', top: (b.y0 / img.dh * 100) + '%',
      width: ((b.x1 - b.x0) / img.dw * 100) + '%', height: ((b.y1 - b.y0) / img.dh * 100) + '%',
    } }));
  }
  full.addEventListener('click', () => viewItem(s, item, 'legend'));
  return h('div.ref' + (below ? '.below' : ''), below ? h('div.ref-caption', '整张清单（框出的是当前这一项）') : null, full);
}

function unionBox(a, b) {
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** 全屏看图：默认打开当前条目所在的图，并框出它 */
function viewItem(s, item, view) {
  const k = item.img != null ? item.img : 0;
  const entries = entriesFromImages(s.images, item.img != null ? { img: item.img, box: item.box, countBox: item.countBox } : null);
  // 看清单：直接放大到当前这一项；看整张图：先显示全图（当前项有框，点 ⌖ 可跳过去）
  openImageViewer(entries, { index: Math.max(0, entries.findIndex(e => e.from === k)), view, focus: view === 'legend' });
}

/** 卡片上方的两个入口：放大清单 / 看完整原图 */
function refLinks(s, item) {
  const img = item.img != null ? s.images[item.img] : (s.images.length === 1 ? s.images[0] : null);
  if (!img || !(img.display || img.fullId)) return null;
  return h('div.ref-links',
    img.display ? h('button.link', { onclick: () => viewItem(s, item, 'legend') }, '🔍 放大看清单') : h('span'),
    img.fullId ? h('button.link', { onclick: () => viewItem(s, item, 'full') }, '🖼 看完整原图 ›') : null);
}

// ---------- 列表 / 汇总 ----------

function renderList(app) {
  const s = app.rec.session;
  app.setTitle('核对结果');
  app.setBack(() => discard(app));
  const p1 = phase1Button(app, s);
  if (p1) app.actions.append(p1);
  if (s.items.length) app.actions.append(h('button.btn.sm.soft', { onclick: () => { s.mode = 'card'; const k = s.items.findIndex(i => !i.verified); s.cursor = k >= 0 ? k : 0; app.saveSession(); app.render(); } }, '逐项'));
  const view = clear(app.view);
  const t = totalsCheck(s);
  const unverified = s.items.filter(i => !i.verified).length;
  const errors = s.items.filter(i => itemIssues(i, s).some(x => x.level === 'error')).length;

  view.append(h('div.totals',
    h('div.stat', h('div.k', '合计颗数'), h('div.v', fmtNum(t.sum)),
      t.statedTotal ? h('div.s' + (t.totalOk ? '' : '.muted'), t.totalOk ? h('span.tag.ok', `✓ 与图上 ${fmtNum(t.statedTotal)} 一致`) : h('span.tag.bad', `图上写 ${fmtNum(t.statedTotal)}`)) : h('div.s.muted', '图上没写总数')),
    h('div.stat', h('div.k', '颜色数'), h('div.v', t.colors),
      t.statedColors ? h('div.s', t.colorsOk ? h('span.tag.ok', `✓ 与图上 ${t.statedColors} 色一致`) : h('span.tag.bad', `图上写 ${t.statedColors} 色`)) : h('div.s.muted', '　'))));
  if (t.statedTotal && !t.totalOk) {
    const diff = t.statedTotal - t.sum;
    view.append(h('div.banner.bad', h('span.ico', '⚠️'), h('div', h('b', `合计比图上${diff > 0 ? '少' : '多'} ${Math.abs(diff)} 颗`), h('div.small', '可能漏了颜色、多了一项，或某个数量读错了。'))));
  }

  const list = h('div.list', { style: { marginTop: '12px' } });
  if (!s.items.length) list.append(h('div.empty', h('div.big-ico', '🫘'), h('p', '还没有颜色，点下面“添加颜色”')));
  s.items.forEach((it, k) => {
    const lvl = issueLevel(it, s);
    list.append(h('div.li.click', { onclick: () => { s.mode = 'card'; s.cursor = k; app.saveSession(); app.render(); } },
      h('span.check.' + (it.verified ? 'v' : lvl || 'p'), it.verified ? '✓' : lvl === 'e' ? '!' : lvl === 'w' ? '?' : ''),
      chip(it.code || '?', { size: 'md', label: it.code || it.rawCode || '?' }),
      h('div.grow', h('span.num', it.count != null ? `× ${fmtNum(it.count)}` : '× ?'),
        s.images.length > 1 && it.img != null ? h('span.tiny.muted', `　第${it.img + 1}张`) : null),
      h('span.st', it.verified ? h('span.tag.ok', '已确认') : h('span.tag' + (lvl === 'e' ? '.bad' : lvl === 'w' ? '.warn' : ''), '待核对'))));
  });
  view.append(list);

  view.append(h('div.row.gap', { style: { marginTop: '10px' } },
    h('button.btn.soft.grow', { onclick: () => addItem(app) }, '＋ 添加颜色'),
    hasViewable(s.images) ? h('button.btn.ghost', { onclick: () => openImageViewer(entriesFromImages(s.images), { view: 'full', focus: false }) }, '🖼 看原图') : null));
  const rc = recropButton(app);
  if (rc) view.append(rc);

  const ready = s.items.length > 0 && !unverified && !errors;
  view.append(h('div.sticky-actions',
    ready
      ? h('button.btn.primary.big.block', { onclick: () => { app.rec.step = 'preview'; app.saveSession(); app.render(); } }, '下一步：保存图纸')
      : s.items.length
        ? h('button.btn.big.block', {
          onclick: () => { s.mode = 'card'; s.cursor = s.items.findIndex(i => !i.verified || itemIssues(i, s).some(x => x.level === 'error')); app.saveSession(); app.render(); },
        }, errors ? `还有 ${errors} 项需要补全` : `还有 ${unverified} 项没核对，继续 ›`)
        : null));
}

/** 结果明显不对时：回到框选那一步重新识别（原图还在内存里时才有） */
function recropButton(app) {
  const r = app.rec, s = r.session;
  if (!r.works?.length || !['ocr', 'vlm'].includes(s.method) || r.works.some(w => !w.canvas.width)) return null;
  return h('div.center', h('button.link', {
    onclick: async () => {
      if (!(await confirmDialog('重新框选清单再识别？', { ok: '重新框选', detail: '当前的核对结果会被替换。' }))) return;
      const ids = store.sessionImageIds(s);
      r.method = s.method;
      r.manualCrop = true;
      r.cropIndex = 0;
      r.session = null;
      r.step = 'crop';
      await store.clearSession();
      store.deleteImagesIfUnused(ids);
      app.render();
    },
  }, '结果不对？重新框选清单再识别 ›'));
}

async function addItem(app) {
  const s = app.rec.session;
  const code = await pickCode({ title: '添加颜色' });
  if (!code) return;
  const existing = s.items.find(i => i.code === code);
  if (existing) {
    toast(`${code} 已在列表里，已为你打开它`);
    s.mode = 'card'; s.cursor = s.items.indexOf(existing); app.saveSession(); app.render();
    return;
  }
  s.items.push({ id: newId(), img: null, code, rawCode: '', count: null, box: null, rgb: null, uncertain: false, verified: false, orig: null, added: true });
  s.mode = 'card';
  s.cursor = s.items.length - 1;
  app.saveSession();
  app.render();
  setTimeout(() => app.view.querySelector('.stepper input')?.focus(), 50);
}

