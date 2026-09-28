// “识别”标签：选方法 → 选图/粘贴文字 →（框选清单）→ 识别 → 逐项核对 → 库存预览 → 完成
import { h, clear, toast } from '../ui.js';
import * as store from '../store.js';
import { loadImageFile, contentBounds, cropCanvas, guessLegendRect } from '../image.js';
import { cropper } from '../cropper.js';
import { extractImage, extractText, referenceImage, statedFromImages, newId } from '../extract/index.js';
import { renderVerify } from './verify.js';
import { hasViewable } from '../viewer.js';
import { renderPreview } from './preview.js';

const METHOD_TIPS = {
  vlm: '把截图发给云端大模型读取清单。版式再怪也能读，需联网、按次计费。',
  ocr: '在手机上离线识别，不花钱、不联网。需要你先框出色号清单的位置；截图越清晰越准。',
  text: '用 iPhone 自带的“实况文本”或快捷指令把截图里的字拷贝出来，粘贴到这里解析。',
};

export async function renderRecognize(app) {
  const r = app.rec;
  if (r.step === 'verify') return renderVerify(app);
  if (r.step === 'preview') return renderPreview(app);
  if (r.step === 'crop') return renderCrop(app);
  if (r.step === 'running') return renderRunning(app);
  return renderPick(app);
}

// ---------- 第 1 步：选方法、选图 ----------

async function renderPick(app) {
  app.setTitle('添加图纸');
  app.setBack(() => { app.pat.page = 'list'; app.render(); });
  const s = app.settings;
  const view = clear(app.view);
  const enabled = store.enabledMethods(s);
  const r = app.rec;
  if (!enabled.includes(r.method)) r.method = enabled.includes(s.defaultMethod) ? s.defaultMethod : enabled[0] || null;

  const saved = await store.loadSession();
  if (saved && saved.items?.length) {
    const done = saved.items.filter(i => i.verified).length;
    view.append(h('div.banner.info',
      h('span.ico', '📝'),
      h('div.grow', h('b', '有一次没核对完的识别'), h('div.small.muted', `${saved.name || ''} 已核对 ${done}/${saved.items.length} 项`)),
      h('button.btn.sm.primary', { onclick: () => { r.session = saved; r.method = saved.method; r.step = saved.step === 'preview' ? 'preview' : 'verify'; app.render(); } }, '继续')));
  }

  if (!enabled.length) {
    view.append(h('div.card',
      h('h2', '先开启一种识别方法'),
      h('p.muted', '在“设置”里打开云端大模型、离线 OCR 或实况文本中的至少一种。'),
      h('button.btn.primary', { onclick: () => app.go('settings') }, '去设置')));
    view.append(manualEntry(app));
    return;
  }

  if (enabled.length > 1) {
    view.append(h('div.seg.method-seg', enabled.map(m =>
      h('button' + (m === r.method ? '.on' : ''), { onclick: () => { r.method = m; app.rerender(); } }, store.METHOD_NAMES[m].replace(' / 快捷指令', '')))));
  } else {
    view.append(h('div.small.muted', '识别方法：', h('b', store.METHOD_NAMES[r.method])));
  }
  view.append(h('p.small.muted', METHOD_TIPS[r.method]));

  if (r.method === 'text') view.append(textPanel(app));
  else view.append(imagePanel(app));
  view.append(manualEntry(app));
}

function manualEntry(app) {
  return h('div.center', h('button.link', {
    onclick: () => {
      startSession(app, { method: 'manual', images: [], items: [], statedTotal: null, statedColors: null });
      app.rec.session.mode = 'list';
      app.render();
    },
  }, '不识别，手动录入色号和数量 ›'));
}

function imagePanel(app) {
  const r = app.rec;
  const vlm = app.settings.methods.vlm;
  const box = h('div');
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true });
  const manualCrop = h('input', { type: 'checkbox', checked: r.vlmManualCrop ?? !vlm.twoPass });
  manualCrop.addEventListener('change', () => { r.vlmManualCrop = manualCrop.checked; });
  input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) return;
    r.manualCrop = r.method === 'ocr' || (r.method === 'vlm' && manualCrop.checked);
    try {
      r.works = [];
      for (const f of files) {
        const canvas = await loadImageFile(f);
        r.works.push({ name: f.name || '截图', canvas, content: contentBounds(canvas), rect: null });
      }
    } catch (e) {
      toast('读取图片失败：' + e.message, 'error');
      return;
    }
    if (r.manualCrop) { r.cropIndex = 0; r.step = 'crop'; app.render(); } else runExtraction(app);
  });
  box.append(h('label.drop', input,
    h('div.big-ico', '🖼️'),
    h('b', '选择图纸截图'),
    h('div.small', '可一次选多张（同一张图纸拆成多张截图时，结果会合并）')));
  if (r.method === 'vlm') {
    box.append(h('label.row.gap.small', { style: { margin: '12px 2px' } }, manualCrop,
      h('span', '自己框选清单区域（更准、更省钱；不勾选则由模型自动找）')));
  }
  return box;
}

function textPanel(app) {
  const r = app.rec;
  const ta = h('textarea.input', { placeholder: '把拷贝的文字粘贴到这里，例如：\nA11 A18 E14\nx68 x45 x513', value: r.pasted || '' });
  ta.addEventListener('input', () => { r.pasted = ta.value; });
  const imgs = h('div.thumbs');
  const refInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const showThumbs = () => { clear(imgs); for (const w of r.refWorks || []) imgs.append(h('img', { src: cropCanvas(w.canvas, w.content, Math.min(1, 200 / w.content.h)).toDataURL('image/jpeg', .7) })); };
  refInput.addEventListener('change', async () => {
    r.refWorks = [];
    for (const f of refInput.files) {
      const canvas = await loadImageFile(f);
      r.refWorks.push({ name: f.name || '截图', canvas, content: contentBounds(canvas) });
    }
    showThumbs();
  });
  showThumbs();
  return h('div',
    h('div.row.gap', { style: { margin: '6px 0' } },
      h('button.btn.soft.sm', {
        onclick: async () => {
          try {
            const t = await navigator.clipboard.readText();
            if (!t) { toast('剪贴板是空的'); return; }
            ta.value = t; r.pasted = t;
          } catch { toast('无法读取剪贴板：请长按输入框选择“粘贴”'); }
        },
      }, '📋 从剪贴板粘贴'),
      h('button.btn.ghost.sm', { onclick: () => { ta.value = ''; r.pasted = ''; } }, '清空')),
    ta,
    h('label.btn.soft.sm', { style: { position: 'relative', marginTop: '10px' } }, refInput, '🖼️ 附上截图（可选，核对时对照看）'),
    imgs,
    h('div.spacer'),
    h('button.btn.primary.block.big', {
      onclick: async e => {
        const text = ta.value.trim();
        if (!text) { toast('请先粘贴文字'); return; }
        const res = extractText(text);
        if (!res.items.length) {
          toast('没从文字里找到“色号 + 数量”，请检查粘贴的内容', 'error');
          return;
        }
        e.currentTarget.disabled = true;
        const images = await Promise.all((r.refWorks || []).map(referenceImage));
        startSession(app, { method: 'text', images, items: res.items, statedTotal: res.statedTotal, statedColors: res.statedColors, rawText: text });
        app.render();
      },
    }, '解析文字'),
    h('details.help',
      h('summary', '怎样把截图里的字拷贝出来？'),
      h('p.small', h('b', '方法一：实况文本（最简单）')),
      h('ol.steps',
        h('li', '在“照片”里打开图纸截图'),
        h('li', '点右下角的“实况文本”图标（方框里三条线）'),
        h('li', '长按色号清单那几行文字 → 拖动选中清单部分（或“全选”）→ 拷贝'),
        h('li', '回到这里点“从剪贴板粘贴”')),
      h('p.small', h('b', '方法二：快捷指令（一次设置，以后分享即可）')),
      h('ol.steps',
        h('li', '打开“快捷指令”App → 右上角 + 新建，命名“拼豆取字”'),
        h('li', '添加操作“从图像中提取文本”，输入选“快捷指令输入”'),
        h('li', '再添加操作“拷贝到剪贴板”'),
        h('li', '点底部 ⓘ，打开“在共享表单中显示”，接收类型只留“图像”'),
        h('li', '以后在照片里打开截图 → 分享 → 拼豆取字，再回来粘贴')),
      h('p.small.muted', '这两种方法都用 iPhone 自带的文字识别（Apple Vision），离线、免费。文字没有位置信息，所以只截/选清单那一部分效果最好。')));
}

export function startSession(app, { method, images, items, statedTotal, statedColors, rawText }) {
  const d = new Date();
  app.rec.session = {
    id: newId(), createdAt: Date.now(), method,
    name: `图纸 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    images, items, statedTotal: statedTotal || null, statedColors: statedColors || null,
    // 有位置信息时先看“识别总览”（框出每一项，看漏了哪个），再逐项核对
    // 没有位置、但附了截图：先单独看一眼颜色齐不齐（“颜色”这一步），再逐项核对数量
    cursor: 0, mode: items.some(i => i.box && i.img != null) ? 'overview' : items.length && hasViewable(images) ? 'colors' : items.length ? 'card' : 'list', rawText: rawText || null,
  };
  app.rec.step = 'verify';
  app.saveSession();
}

// ---------- 第 2 步：框选清单 ----------

function renderCrop(app) {
  const r = app.rec;
  const i = r.cropIndex || 0;
  const work = r.works[i];
  app.setTitle(`框选色号清单${r.works.length > 1 ? `（${i + 1}/${r.works.length}）` : ''}`);
  app.setBack(() => { r.step = 'pick'; r.works = []; app.render(); });
  const view = clear(app.view);
  const c = work.content;
  if (!work.rect) {
    // 默认：最后一条长格线以下（多数图纸的清单在格子下面）；找不到时框内容区下方 30%
    try { work.rect = guessLegendRect(work.canvas, c); } catch { work.rect = { x: c.x, y: c.y + c.h * 0.7, w: c.w, h: c.h * 0.3 }; }
  }
  const cr = cropper(work);
  view.append(
    h('p.small.muted', '已自动框出最可能是清单的位置。请确认方框框住了', h('b', '所有色块、色号和数量'), '，尽量少框进格子。拖角调整大小，拖中间移动，在框外空白处可重新画。'),
    cr.el,
    h('div.row.gap', { style: { marginTop: '6px' } },
      h('button.btn.soft.sm', { onclick: () => { work.rect = { ...c }; app.rerender(); } }, '整张图'),
      h('button.btn.soft.sm', { onclick: () => { work.rect = null; app.rerender(); } }, '重置'),
      h('div.grow'),
      i > 0 ? h('button.btn.sm', { onclick: () => { work.rect = cr.get(); r.cropIndex = i - 1; app.render(); } }, '上一张') : null),
    h('div.spacer'),
    h('button.btn.primary.block.big', {
      onclick: () => {
        work.rect = cr.get();
        if (i + 1 < r.works.length) { r.cropIndex = i + 1; app.render(); } else runExtraction(app);
      },
    }, i + 1 < r.works.length ? '下一张' : '开始识别'));
}

// ---------- 第 3 步：识别中 ----------

function renderRunning(app) {
  const r = app.rec;
  app.setTitle('识别中');
  const view = clear(app.view);
  const pct = r.progress ?? 0;
  view.append(h('div.card.center',
    h('div.spinner'),
    h('p', h('b', r.status || '准备中…')),
    h('div.progress', h('i', { style: { width: Math.round(pct * 100) + '%' } })),
    h('div.spacer'),
    h('button.btn.ghost', { onclick: () => { r.abort?.abort(); r.step = 'pick'; app.render(); } }, '取消')));
}

async function runExtraction(app) {
  const r = app.rec;
  const method = r.method;
  const settings = app.settings;
  r.step = 'running';
  r.progress = 0;
  r.status = '准备中…';
  r.abort = new AbortController();
  const signal = r.abort.signal;
  await app.render();
  const images = [], items = [];
  const errors = [];
  // 取消时把这次已经存下的原图删掉
  const dropImages = () => store.deleteImagesIfUnused(images.map(im => im.fullId).filter(Boolean));
  const setStatus = (i, msg) => {
    if (app.rec.step !== 'running') return;
    r.status = (r.works.length > 1 ? `第 ${i + 1}/${r.works.length} 张 · ` : '') + msg;
    const p = app.view.querySelector('.card p b');
    if (p) p.textContent = r.status;
  };
  for (let i = 0; i < r.works.length; i++) {
    if (signal.aborted) { dropImages(); return; }
    const work = r.works[i];
    try {
      const res = await extractImage(method, settings, work, images.length, { signal, onStatus: m => setStatus(i, m) });
      images.push(res.image);
      items.push(...res.items);
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) { dropImages(); return; }
      console.error(e);
      errors.push(`${work.name}：${e.message}`);
    }
    r.progress = (i + 1) / r.works.length;
    const bar = app.view.querySelector('.progress i');
    if (bar) bar.style.width = Math.round(r.progress * 100) + '%';
  }
  if (app.rec.step !== 'running') { dropImages(); return; }
  if (!images.length) {
    r.step = 'pick';
    await app.render();
    app.view.prepend(h('div.banner.bad', h('span.ico', '⚠️'), h('div', h('b', '识别失败'), h('div.small', errors.join('\n')),
      h('div.small', '可以换一种识别方法，或点下方“手动录入”。'))));
    return;
  }
  // 原图留在内存里，方便“重新框选”（App 被系统回收后就没了，那时需要重新选图）
  const st = statedFromImages(images);
  startSession(app, { method, images, items, ...st });
  if (!items.length) app.rec.session.mode = 'list';
  await app.render();
  if (errors.length) toast('部分图片识别失败：' + errors.join('；'), 'error');
  else if (!items.length) toast('没有识别出色号，请手动添加或换一种方法', 'error');
}

