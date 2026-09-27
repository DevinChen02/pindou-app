// 识别总览：逐项核对之前，先把识别出的每一项在清单图上框出来，
// 一眼就能看出漏了哪个颜色；点图上没被框住的地方就能直接补上。
import { h, clear, toast, sheet, chip, pickCode, stepper, fmtNum } from '../ui.js';
import { nearestCodes } from '../palette.js';
import { itemIssues, totalsCheck, newId } from '../extract/index.js';
import { makeCanvas, sampleSwatch } from '../image.js';
import { openImageViewer } from '../viewer.js';

const union = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const toneOf = (it, s) => {
  const is = itemIssues(it, s);
  return is.some(i => i.level === 'error') ? 'bad' : is.some(i => i.level === 'warn') ? 'warn' : 'ok';
};
const ui = { allLabels: false }; // 默认只给有问题的框标出识别结果，其余只画框，不挡字
const labelOf = it => `${it.code || it.rawCode || '?'}×${it.count ?? '?'}`;
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

/** 这次识别有没有位置信息（有才显示总览） */
export function hasOverview(s) {
  return !!s?.images?.length && s.items.some(i => i.img != null && i.box && s.images[i.img]?.display);
}

function openCard(app, idx) {
  const s = app.rec.session;
  s.mode = 'card'; s.cursor = idx;
  app.saveSession(); app.render();
}

export function renderOverview(app, { discard }) {
  const s = app.rec.session;
  app.setTitle('识别总览');
  app.setBack(() => discard(app));
  app.actions.append(h('button.btn.sm.soft', { onclick: () => { s.mode = 'list'; app.saveSession(); app.render(); } }, '列表'));
  const view = clear(app.view);

  // ---- 汇总：识别出几色几颗，和图上写的总数对一下 ----
  const t = totalsCheck(s);
  const totalIn = h('input.input.num', { type: 'number', inputmode: 'numeric', pattern: '[0-9]*', min: 0, placeholder: '选填', value: s.statedTotal ?? '' });
  const diff = h('div.ov-diff');
  const updDiff = () => {
    const st = s.statedTotal;
    diff.className = 'ov-diff';
    if (!st) { diff.textContent = '图上如果写了总颗数（比如标题里的“4613”），填进来可以帮你发现漏掉的颜色。'; diff.classList.add('muted'); return; }
    const d = st - t.sum;
    if (d === 0) { diff.textContent = '✓ 和图上的总数一致'; diff.classList.add('ok'); }
    else if (d > 0) { diff.textContent = `比图上少 ${fmtNum(d)} 颗：多半漏了颜色，或者某个数量读少了`; diff.classList.add('bad'); }
    else { diff.textContent = `比图上多 ${fmtNum(-d)} 颗：可能多识别了一项，或者某个数量读多了`; diff.classList.add('bad'); }
  };
  totalIn.addEventListener('input', () => {
    const v = parseInt(totalIn.value, 10);
    s.statedTotal = v > 0 ? v : null;
    app.saveSession(); updDiff();
  });
  updDiff();
  view.append(h('div.card.ov-sum',
    h('div.k', '识别出'),
    h('div.v', `${t.colors} 种颜色 · ${fmtNum(t.sum)} 颗`,
      s.statedColors ? h('span.small' + (t.colors === s.statedColors ? '.ok-t' : '.bad-t'), `　图上写 ${s.statedColors} 色`) : null),
    h('div.ov-total', h('label', '图上写的总颗数'), totalIn),
    diff));

  view.append(h('div.banner.info', h('span.ico', '👀'), h('div',
    h('b', '先对一眼：每个颜色都应该有一个框'),
    h('div.small', '没被框住的就是漏掉的，直接点它补上；框上的标签是识别结果，和图上对不上的点框就能去改。'))));

  // ---- 每张图：清单图 + 所有识别框 ----
  const multi = s.images.length > 1;
  s.images.forEach((im, k) => {
    if (!im.display) return;
    const idxs = s.items.map((it, i) => i).filter(i => s.items[i].img === k && s.items[i].box);
    // 只显示识别出的那几行附近（上下各多留两行），清单下面大片空白/水印不占地方
    const us = idxs.map(i => union(s.items[i].box, s.items[i].countBox));
    const rowH = median(us.map(u => u.y1 - u.y0)) || im.dh * 0.1;
    let cy0 = 0, cy1 = im.dh;
    if (us.length) {
      cy0 = Math.max(0, Math.min(...us.map(u => u.y0)) - rowH * 2.2);
      cy1 = Math.min(im.dh, Math.max(...us.map(u => u.y1)) + rowH * 2.4);
      if (cy1 - cy0 > im.dh * 0.85) { cy0 = 0; cy1 = im.dh; }
    }
    const ch = cy1 - cy0;
    // 又宽又扁的清单（一两行排满整个宽度）在手机上字太小：切成几段上下叠放，每段放大显示。
    // 切口尽量选在两个框之间的空隙里
    const segs = splitPoints(im.dw, ch, us, rowH);
    const figs = segs.map(([x0, x1]) => {
      const sw = x1 - x0;
      const inner = h('div.ov-inner', {
        style: { left: (-x0 / sw * 100) + '%', width: (im.dw / sw * 100) + '%', top: (-cy0 / ch * 100) + '%', height: (im.dh / ch * 100) + '%' },
      }, h('img', { src: im.display, alt: '清单', draggable: false }));
      for (const i of idxs) {
        const it = s.items[i];
        const u = union(it.box, it.countBox);
        if (u.x1 < x0 || u.x0 > x1) continue;
        const tone = toneOf(it, s);
        inner.append(h('div.ov-box.' + tone + (u.y0 - cy0 < rowH * 0.8 ? '.lb' : ''), {
          style: {
            left: (u.x0 / im.dw * 100) + '%', top: (u.y0 / im.dh * 100) + '%',
            width: ((u.x1 - u.x0) / im.dw * 100) + '%', height: ((u.y1 - u.y0) / im.dh * 100) + '%',
          },
        }, h('span', labelOf(it))));
      }
      const fig = h('div.ov-fig' + (ui.allLabels ? '.all' : ''), { style: { aspectRatio: `${sw} / ${ch}` } }, inner);
      fig.addEventListener('click', e => {
        const r = inner.getBoundingClientRect();
        tapAt(app, k, (e.clientX - r.left) / r.width * im.dw, (e.clientY - r.top) / r.height * im.dh);
      });
      return fig;
    });
    const labBtn = h('button.link.small', {
      onclick: () => { ui.allLabels = !ui.allLabels; app.rerender(); },
    }, ui.allLabels ? '只标有问题的' : '显示全部标签');
    view.append(h('div.ov-sec',
      h('div.row.between.ov-head',
        h('b.small', multi ? `第 ${k + 1} 张 · 框出 ${idxs.length} 项` : `框出 ${idxs.length} 项`),
        h('div.row.gap-s', labBtn, h('button.link.small', { onclick: () => fullscreen(app, k) }, '⤢ 全屏放大'))),
      h('div.ov-figs', figs),
      segs.length > 1 ? h('div.tiny.muted', { style: { margin: '4px 2px 0' } }, `清单太宽，切成 ${segs.length} 段上下排（从左到右）`) : null,
      h('div.ov-legend.tiny.muted',
        h('span', h('i.ok'), '读出来了'), h('span', h('i.warn'), '把握不大'), h('span', h('i.bad'), '缺色号/数量'),
        h('span', '· 点图上没框的地方补颜色'))));
  });

  // ---- 识别出的所有项（点开去核对/修改）----
  view.append(h('div.section-title', `识别结果（${s.items.length} 项，点一项去核对）`));
  view.append(h('div.ov-list', s.items.map((it, i) => h('button.ov-item', { onclick: () => openCard(app, i) },
    chip(it.code || '?', { size: 'sm', label: it.code || it.rawCode || '?' }),
    h('span.n', it.count != null ? `×${fmtNum(it.count)}` : '×?'),
    it.verified ? h('span.dot.v', '✓') : h('span.dot.' + toneOf(it, s))))));
  const noPos = s.items.filter(it => !(it.img != null && it.box)).length;
  if (noPos) view.append(h('p.small.muted', `其中 ${noPos} 项没有位置（手动添加或位置没识别出来），不在图上画框。`));
  view.append(h('div.center', h('button.link', { onclick: () => addByPick(app) }, '＋ 手动添加一个颜色')));

  const firstTodo = s.items.findIndex(i => !i.verified);
  view.append(h('div.sticky-actions',
    s.items.length
      ? h('button.btn.primary.big.block', { onclick: () => openCard(app, firstTodo >= 0 ? firstTodo : 0) },
        firstTodo >= 0 ? `没漏，开始逐项核对（${s.items.filter(i => !i.verified).length} 项）` : '全部核对过了，去列表')
      : h('button.btn.big.block', { onclick: () => { s.mode = 'list'; app.saveSession(); app.render(); } }, '去列表')));
}

/**
 * 宽清单切几段：让每个框在屏幕上至少约 16 点高（最多切 3 段，每段宽高比不小于 2:1），
 * 切口选在框之间的空隙
 */
function splitPoints(W, H, boxes, rowH) {
  const screenW = Math.min(window.innerWidth || 390, 720) - 32;
  const segMax = rowH * screenW / 16;
  const n = Math.max(1, Math.min(3, Math.ceil(W / segMax), Math.floor(W / H / 2)));
  if (n === 1) return [[0, W]];
  const xs = [0];
  for (let j = 1; j < n; j++) {
    const ideal = W * j / n, span = W / n * 0.18;
    let best = ideal, bestCost = Infinity;
    for (let x = ideal - span; x <= ideal + span; x += Math.max(1, W / 400)) {
      const cut = boxes.filter(b => b.x0 < x && b.x1 > x).length;
      const cost = cut * 1000 + Math.abs(x - ideal);
      if (cost < bestCost) { bestCost = cost; best = x; }
    }
    xs.push(Math.round(best));
  }
  xs.push(W);
  return xs.slice(0, -1).map((x, j) => [x, xs[j + 1]]);
}

/** 点了图上某处：点在框里 → 打开那一项；点在框外 → 补一个漏掉的颜色 */
function tapAt(app, k, x, y) {
  const s = app.rec.session;
  const hs = s.items.filter(it => it.img === k && it.box).map(it => it.box.y1 - it.box.y0);
  const pad = (median(hs) || 10) * 0.25;
  let hit = -1, best = Infinity;
  s.items.forEach((it, i) => {
    if (it.img !== k || !it.box) return;
    const u = union(it.box, it.countBox);
    if (x < u.x0 - pad || x > u.x1 + pad || y < u.y0 - pad || y > u.y1 + pad) return;
    const d = Math.hypot(x - (u.x0 + u.x1) / 2, y - (u.y0 + u.y1) / 2);
    if (d < best) { best = d; hit = i; }
  });
  if (hit >= 0) openCard(app, hit);
  else addMissing(app, k, x, y);
}

function fullscreen(app, k) {
  const s = app.rec.session;
  const entries = s.images.map((im, j) => ({
    name: im.name || `第 ${j + 1} 张`, from: j,
    views: im.display ? [{
      key: 'legend', label: '清单', src: im.display, w: im.dw, h: im.dh,
      marks: s.items.filter(it => it.img === j && it.box).map(it => ({ ...union(it.box, it.countBox), label: labelOf(it), tone: toneOf(it, s) })),
    }] : [],
  }));
  openImageViewer(entries, {
    index: Math.max(0, entries.filter(e => e.views.length).findIndex(e => e.from === k)),
    view: 'legend', focus: false, hint: '双指放大 · 点没被框住的颜色来补上',
    onTap: ({ x, y, entry, close }) => { close(); tapAt(app, entry.from, x, y); },
  });
}

/** 在点的位置补一个颜色：显示放大的局部 + 按颜色推荐色号，填色号和数量 */
async function addMissing(app, k, x, y) {
  const s = app.rec.session;
  const im = s.images[k];
  const boxes = s.items.filter(it => it.img === k && it.box).map(it => it.box);
  const mw = median(boxes.map(b => b.x1 - b.x0)) || im.dw * 0.06;
  const mh = median(boxes.map(b => b.y1 - b.y0)) || mw * 0.6;
  const box = {
    x0: Math.max(0, x - mw / 2), y0: Math.max(0, y - mh / 2),
    x1: Math.min(im.dw, x + mw / 2), y1: Math.min(im.dh, y + mh / 2),
  };
  let imgEl;
  try { imgEl = await loadImg(im.display); } catch { toast('图片打不开', 'error'); return; }
  const cv = makeCanvas(im.dw, im.dh);
  cv.getContext('2d').drawImage(imgEl, 0, 0, im.dw, im.dh);
  let rgb = null;
  try { rgb = sampleSwatch(cv, box, 0.1); } catch { rgb = null; }
  const sugg = rgb ? nearestCodes(rgb, 6).map(n => n.code) : [];

  let code = null, count = null;
  const codeBtn = h('button.code-btn', { onclick: async () => { const c = await pickCode({ current: code, suggestions: sugg, title: '选择色号' }); if (c) setCode(c); } });
  const addBtn = h('button.btn.primary', { disabled: true, onclick: () => add() }, '添加');
  const sugRow = h('div.row.wrap.gap-s.small');
  const setCode = c => {
    code = c;
    codeBtn.replaceChildren(chip(code || '?', { size: 'sm' }), h('span', code ? '点这里更改' : '点这里选择色号'), h('span.chev', '›'));
    for (const b of sugRow.querySelectorAll('[data-code]')) b.classList.toggle('on', b.dataset.code === code);
    addBtn.disabled = !(code && count > 0);
  };
  if (sugg.length) {
    sugRow.append(h('span.muted', '按颜色可能是：'), ...sugg.map(c => h('button.code-cell', { 'data-code': c, onclick: () => setCode(c) }, chip(c, { size: 'sm' }))));
  }
  const cnt = stepper(null, v => { count = v; addBtn.disabled = !(code && count > 0); });
  setCode(null);

  const sh = sheet([
    snippet(imgEl, im, box, boxes),
    h('p.small.muted', { style: { margin: '8px 2px' } }, '虚线框是你点的位置（绿框是已经识别出的）。照图上写的填色号和数量：'),
    rgb ? h('div.cmp', { style: { marginBottom: '6px' } }, h('span', '图中颜色'), h('span.sw', { style: { background: `rgb(${rgb.join(',')})` } })) : null,
    sugg.length ? sugRow : null,
    h('div.edit-grid', { style: { marginTop: '10px' } }, h('span.lbl', '色号'), codeBtn, h('span.lbl', '数量'), cnt),
    h('div.row.gap.end', { style: { marginTop: '14px' } },
      h('button.btn.ghost', { onclick: () => sh.close() }, '取消'),
      addBtn),
  ], { title: '补上漏掉的颜色', tall: true });

  function add() {
    if (!(code && count > 0)) return;
    const dup = s.items.find(it => it.code === code);
    s.items.push({
      id: newId(), img: k, code, rawCode: '', count, box, countBox: null, rgb,
      uncertain: false, verified: true, orig: null, added: true,
    });
    sh.close();
    app.saveSession();
    app.rerender();
    toast(dup ? `已添加 ${code} × ${count}（注意：列表里已经有 ${code} 了）` : `已添加 ${code} × ${count}`, dup ? 'error' : 'ok');
  }
}

/** 放大的局部：点的位置虚线框，周围已识别的项绿框 */
function snippet(imgEl, im, box, others) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const padX = Math.max(bw * 1.6, 40), padY = Math.max(bh * 1.4, 30);
  const sx = Math.max(0, box.x0 - padX), sy = Math.max(0, box.y0 - padY);
  const sw = Math.min(im.dw, box.x1 + padX) - sx, shh = Math.min(im.dh, box.y1 + padY) - sy;
  const maxW = Math.min(window.innerWidth - 40, 560), maxH = 180;
  const kk = Math.min(maxW / sw, maxH / shh, 5);
  const dpr = window.devicePixelRatio || 1;
  const c = makeCanvas(sw * kk * dpr, shh * kk * dpr);
  c.style.width = sw * kk + 'px'; c.style.height = shh * kk + 'px';
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = kk < 2.5;
  // 显示图可能被缩放过：按 naturalWidth 换算
  const fx = imgEl.naturalWidth / im.dw, fy = imgEl.naturalHeight / im.dh;
  g.drawImage(imgEl, sx * fx, sy * fy, sw * fx, shh * fy, 0, 0, c.width, c.height);
  const rect = (b, color, dash, lw) => {
    g.save(); g.strokeStyle = color; g.lineWidth = lw * dpr;
    if (dash) g.setLineDash([6 * dpr, 4 * dpr]);
    g.strokeRect((b.x0 - sx) * kk * dpr, (b.y0 - sy) * kk * dpr, (b.x1 - b.x0) * kk * dpr, (b.y1 - b.y0) * kk * dpr);
    g.restore();
  };
  for (const b of others) rect(b, '#23925a', false, 2);
  rect(box, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8604c', true, 3);
  return h('div.ov-snip', c);
}

/** 不在图上点，直接从色卡里选一个加进来 */
async function addByPick(app) {
  const s = app.rec.session;
  const code = await pickCode({ title: '添加颜色' });
  if (!code) return;
  const existing = s.items.findIndex(i => i.code === code);
  if (existing >= 0) { toast(`${code} 已在列表里，已为你打开它`); return openCard(app, existing); }
  s.items.push({ id: newId(), img: null, code, rawCode: '', count: null, box: null, rgb: null, uncertain: false, verified: false, orig: null, added: true });
  openCard(app, s.items.length - 1);
  setTimeout(() => app.view.querySelector('.stepper input')?.focus(), 50);
}

