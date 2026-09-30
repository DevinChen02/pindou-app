// “设置”标签：识别方法开关（开启前必须填好所需参数并通过自检）、库存参数、备份。
import { h, clear, toast, confirmDialog, shareFile, copyText } from '../ui.js';
import * as store from '../store.js';
import { testConnection } from '../extract/vlm.js';
import { testOcr, REC_MODELS, cellModelOf, downloadMB, getPP } from '../extract/ocr.js';
import { renderPaletteManager } from './palette.js';
import { PALETTE, SERIES } from '../palette.js';
import { APP_VERSION } from '../version.js';
import { updater } from '../app.js';
import * as license from '../license.js';

const PROVIDERS = {
  anthropic: { name: 'Claude', full: 'Anthropic Claude', keyHint: 'sk-ant-…', where: 'platform.claude.com → API Keys' },
  openai: { name: 'OpenAI', full: 'OpenAI', keyHint: 'sk-…', where: 'platform.openai.com → API keys' },
  gemini: { name: 'Gemini', full: 'Google Gemini', keyHint: 'AIza…', where: 'aistudio.google.com → Get API key' },
};

// 正在编辑、尚未保存的草稿
const draft = { vlm: null, ocr: null, open: {} };

export async function renderSettings(app) {
  if (app.settingsPage === 'palette') return renderPaletteManager(app);
  app.setTitle('设置');
  const s = app.settings;
  const view = clear(app.view);
  view.append(h('div.section-title', '识别方法'));
  view.append(h('p.small.muted', { style: { margin: '0 4px' } }, '可同时开启多种，识别时再选。开启时需要填好该方法所需的参数，并通过一次自检。'));
  view.append(vlmCard(app), ocrCard(app), textCard(app));

  const en = store.enabledMethods(s);
  if (en.length > 1) {
    const sel = h('select.input', { style: { width: 'auto' } }, en.map(m => h('option', { value: m, selected: s.defaultMethod === m }, store.METHOD_NAMES[m])));
    sel.addEventListener('change', async () => { s.defaultMethod = sel.value; await store.saveSettings(s); toast('已保存'); });
    view.append(h('div.card', h('div.kv', h('div', h('div.k', '默认识别方法'), h('div.d', '打开“识别”时默认选中')), sel)));
  }

  view.append(h('div.section-title', '识字模型'), modelCard(app));
  view.append(h('div.section-title', '色卡'), paletteCard(app));
  view.append(h('div.section-title', '库存'), inventoryCard(app));
  view.append(h('div.section-title', '数据与备份'), dataCard(app));
  view.append(h('div.section-title', '关于'), aboutCard(app));
  if (license.hasOwnerKey()) view.append(h('div.section-title', '试用激活码（只有你的手机上有）'), ownerCard(app));
}

function switchEl(checked, onchange) {
  const input = h('input', { type: 'checkbox', checked, role: 'switch' });
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('label.switch', input, h('span'));
}

function field(label, input, { req = false, note } = {}) {
  return h('div.field', h('label', label, req ? h('span.req', ' *') : null), input, note ? h('div.tiny.muted', { style: { margin: '4px 2px 0' } }, note) : null);
}

function passwordInput(value, placeholder) {
  const input = h('input.input', { type: 'password', value: value || '', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const btn = h('button.btn.sm.ghost', { type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; btn.textContent = input.type === 'password' ? '显示' : '隐藏'; } }, '显示');
  return { el: h('div.pw', input, btn), input };
}

function segEl(options, value, onChange) {
  const el = h('div.seg');
  const draw = () => {
    clear(el);
    for (const [k, label] of options) el.append(h('button' + (value === k ? '.on' : ''), { type: 'button', onclick: () => { value = k; draw(); onChange(k); } }, label));
  };
  draw();
  return el;
}

// ---------- 云端大模型 ----------

function vlmCard(app) {
  const s = app.settings;
  const cfg = s.methods.vlm;
  const open = cfg.enabled || draft.open.vlm;
  if (!draft.vlm) draft.vlm = structuredClone(cfg);
  const d = draft.vlm;
  const status = h('div.status-line');
  const body = h('div.mbody');
  const sw = switchEl(cfg.enabled, async on => {
    if (!on) {
      cfg.enabled = false;
      draft.open.vlm = false;
      await store.saveSettings(s);
      toast('已关闭云端大模型');
      app.rerender();
    } else {
      draft.open.vlm = true;
      sw.querySelector('input').checked = false; // 通过自检后才真正打开
      app.rerender();
    }
  });

  const draw = () => {
    clear(body);
    const P = PROVIDERS[d.provider];
    const key = passwordInput(d.apiKeys[d.provider], P.keyHint);
    key.input.addEventListener('input', () => { d.apiKeys[d.provider] = key.input.value.trim(); });
    const token = passwordInput(d.workerToken, '部署 Worker 时设置的口令');
    token.input.addEventListener('input', () => { d.workerToken = token.input.value.trim(); });
    const url = h('input.input', { type: 'url', value: d.workerUrl, placeholder: 'https://pindou-proxy.你的账号.workers.dev', autocapitalize: 'off', spellcheck: false });
    url.addEventListener('input', () => { d.workerUrl = url.value.trim(); });
    const model = h('input.input', { value: d.models[d.provider] || '', placeholder: store.DEFAULT_MODELS[d.provider], autocapitalize: 'off', spellcheck: false });
    model.addEventListener('input', () => { d.models[d.provider] = model.value.trim(); });
    const two = h('input', { type: 'checkbox', checked: d.twoPass });
    two.addEventListener('change', () => { d.twoPass = two.checked; });

    body.append(
      field('服务商', segEl(Object.entries(PROVIDERS).map(([k, v]) => [k, v.name]), d.provider, v => { d.provider = v; draw(); }), { req: true }),
      field('连接方式', segEl([['direct', '手机直连'], ['proxy', 'Worker 代理']], d.mode, v => { d.mode = v; draw(); }), {
        req: true,
        note: d.mode === 'direct' ? 'API Key 只保存在这台手机里，直接发给服务商。最简单。' : 'API Key 保存在你自己的 Cloudflare Worker 里，手机只存口令，更安全（部署方法见说明文档 worker/README）。',
      }),
      d.mode === 'direct'
        ? field(`${P.full} API Key`, key.el, { req: true, note: `获取：${P.where}` })
        : [field('Worker 地址', url, { req: true }), field('Worker 口令', token.el, { req: true })],
      field('模型名称', model, { req: true, note: `默认 ${store.DEFAULT_MODELS[d.provider]}，可改成你账号可用的其他视觉模型。` }),
      h('label.row.gap.small', { style: { margin: '8px 2px' } }, two, h('span', '两遍识别：先定位清单，再放大读取（更准，多一次调用）')),
      status,
      h('div.row.gap.wrap',
        h('button.btn.soft', { type: 'button', onclick: () => runTest(false) }, '测试连接'),
        h('button.btn.primary', { type: 'button', onclick: () => runTest(true) }, cfg.enabled ? '保存' : '保存并启用'),
        !cfg.enabled ? h('button.btn.ghost', { type: 'button', onclick: () => { draft.open.vlm = false; draft.vlm = null; app.rerender(); } }, '取消') : null));
  };

  const missing = () => {
    const m = [];
    if (!d.models[d.provider]) m.push('模型名称');
    if (d.mode === 'direct' && !d.apiKeys[d.provider]) m.push('API Key');
    if (d.mode === 'proxy') {
      if (!/^https:\/\/\S+/.test(d.workerUrl)) m.push('Worker 地址（需以 https:// 开头）');
      if (!d.workerToken) m.push('Worker 口令');
    }
    return m;
  };

  async function runTest(save) {
    const m = missing();
    if (m.length) { status.className = 'status-line bad'; status.textContent = '请先填写：' + m.join('、'); return; }
    status.className = 'status-line'; status.textContent = '正在测试：发一张小图给模型…';
    try {
      const r = await testConnection(d);
      if (!r.ok) throw new Error(`连上了，但模型读错了测试图（读到：${r.got || '空'}）。可以换个模型再试。`);
      status.className = 'status-line ok';
      status.textContent = `✓ 连接正常（${(r.ms / 1000).toFixed(1)} 秒），模型读到：${r.got}`;
      if (save) await commit();
    } catch (e) {
      status.className = 'status-line bad';
      status.textContent = '✗ ' + e.message;
      if (save) {
        status.append(h('div', { style: { marginTop: '6px' } }, h('button.btn.sm', { type: 'button', onclick: () => commit() }, '仍然保存并启用（跳过测试）')));
      }
    }
  }
  async function commit() {
    const m = missing();
    if (m.length) { toast('请先填写：' + m.join('、'), 'error'); return; }
    s.methods.vlm = { ...structuredClone(d), enabled: true };
    if (!store.enabledMethods(s).includes(s.defaultMethod)) s.defaultMethod = 'vlm';
    draft.open.vlm = false;
    draft.vlm = null;
    await store.saveSettings(s);
    toast('云端大模型已启用', 'ok');
    app.rerender();
  }

  if (open) draw();
  return h('div.card.mcard',
    h('div.mhead', h('div.grow',
      h('div.mtitle', '云端大模型 ', cfg.enabled ? h('span.tag.ok', `已开启 · ${PROVIDERS[cfg.provider].name}`) : null),
      h('div.mdesc', '版式千变万化也能读，最准。需要联网和 API Key，按次付少量费用。')), sw),
    open ? body : null);
}

// ---------- 离线 OCR ----------

function ocrCard(app) {
  const s = app.settings;
  const cfg = s.methods.ocr;
  const open = cfg.enabled || draft.open.ocr;
  if (!draft.ocr) draft.ocr = structuredClone(cfg);
  const d = draft.ocr;
  const status = h('div.status-line');
  const sw = switchEl(cfg.enabled, async on => {
    if (!on) {
      cfg.enabled = false; draft.open.ocr = false;
      await store.saveSettings(s); toast('已关闭离线 OCR'); app.rerender();
    } else {
      draft.open.ocr = true; sw.querySelector('input').checked = false; app.rerender();
    }
  });
  // 引擎文件都随应用部署在 vendor/ 下，不用填路径（旧设置里改过的路径照样生效）
  d.basePath = d.basePath || './vendor/tesseract/';
  d.engine = d.engine || 'ppocr';
  const engSeg = h('div.seg',
    [['ppocr', 'PP-OCR（推荐）'], ['tesseract', 'Tesseract（轻量）']].map(([k, label]) => h('button' + (d.engine === k ? '.on' : ''), {
      type: 'button', onclick: () => { d.engine = k; for (const b of engSeg.children) b.classList.toggle('on', b.textContent === label); },
    }, label)));
  async function test(save) {
    status.className = 'status-line'; status.textContent = d.engine === 'ppocr'
      ? '正在加载识别引擎（PP-OCR，首次约 19 MB，之后可离线使用）…'
      : '正在加载离线识别引擎（首次约 7 MB，之后可离线使用）…';
    try {
      const r = await testOcr(d, m => {
        if (m.progress != null && m.status && !/recognizing/.test(m.status)) status.textContent = `正在加载离线识别引擎… ${Math.round(m.progress * 100)}%`;
        else if (/recognizing/.test(m.status || '')) status.textContent = '引擎已加载，正在自检…';
      });
      if (!r.ok) throw new Error(r.engine && r.engine !== d.engine ? 'PP-OCR 在这台设备上加载不了，请改用 Tesseract' : `引擎能运行，但自检图读成了：${r.got || '空'}`);
      status.className = 'status-line ok'; status.textContent = `✓ 离线识别可用（${d.engine === 'ppocr' ? 'PP-OCRv5' : 'Tesseract'}，自检读到：${r.got}）`;
      if (save) {
        s.methods.ocr = { ...structuredClone(d), enabled: true };
        if (!store.enabledMethods(s).includes(s.defaultMethod)) s.defaultMethod = 'ocr';
        draft.open.ocr = false; draft.ocr = null;
        await store.saveSettings(s); toast('离线 OCR 已启用', 'ok'); app.rerender();
      }
    } catch (e) {
      status.className = 'status-line bad'; status.textContent = '✗ ' + e.message;
    }
  }
  return h('div.card.mcard',
    h('div.mhead', h('div.grow',
      h('div.mtitle', '离线 OCR ', cfg.enabled ? h('span.tag.ok', '已开启') : null),
      h('div.mdesc', '在手机上识别，免费、不联网。识别前需要手动框出清单；清晰截图效果好，很糊的截图容易错。')), sw),
    open ? h('div.mbody',
      field('识别引擎', engSeg, { note: '点选即可，不用填任何路径：两种引擎都随应用一起部署，第一次用时从你的网址下载，之后离线可用。PP-OCR（百度飞桨 PP-OCRv5，就是“识字模型”里的标准模型）：示例图上读对更多、几乎不多认，速度也更快；首次约 19 MB。Tesseract：约 7 MB，PP-OCR 加载失败时会自动改用它。' }),
      status,
      h('div.row.gap.wrap',
        h('button.btn.soft', { type: 'button', onclick: () => test(false) }, '自检'),
        h('button.btn.primary', { type: 'button', onclick: () => test(true) }, cfg.enabled ? '保存' : '自检并启用'),
        !cfg.enabled ? h('button.btn.ghost', { type: 'button', onclick: () => { draft.open.ocr = false; draft.ocr = null; app.rerender(); } }, '取消') : null)) : null);
}

// ---------- 识字模型（读拼豆板格子上的色号） ----------

const MODEL_NOTES = {
  v6s: '更大、更准：实测读拼豆板格子上的色号，读对的格子从 91% 提高到 98%，速度慢约三成。',
  v5m: '更小、更快：和读清单用的是同一个模型（在手机上读过清单就已经下载好了）。',
};

function modelCard(app) {
  const s = app.settings;
  const cur = cellModelOf(s);
  const note = h('div.small.muted.model-note');
  const status = h('div.status-line.model-status');
  const dlBtn = h('button.btn.sm.soft.model-dl', { type: 'button', hidden: true }, '现在下载');
  const refresh = async () => {
    const id = cellModelOf(s), m = REC_MODELS[id];
    note.textContent = `${m.model}，模型 ${m.mb} MB。${MODEL_NOTES[id]}`;
    const mb = await downloadMB(id);
    status.className = 'status-line model-status' + (mb > 0 ? '' : ' ok');
    status.textContent = mb > 0 ? `还没下载：第一次用时下载约 ${Math.round(mb)} MB（也可以现在先下载好，之后离线可用）` : '✓ 已下载，离线也能用';
    dlBtn.hidden = !(mb > 0);
  };
  dlBtn.onclick = async () => {
    dlBtn.disabled = true;
    const id = cellModelOf(s);
    try {
      await getPP(m => { status.className = 'status-line model-status'; status.textContent = `下载中… ${Math.round((m.progress || 0) * 100)}%`; }, id);
      await refresh();
      if (status.textContent.startsWith('还没下载')) { status.className = 'status-line model-status ok'; status.textContent = '✓ 已加载，可以用了'; dlBtn.hidden = true; }
    } catch (e) {
      status.className = 'status-line model-status bad'; status.textContent = '✗ 下载失败：' + (e.message || e);
    }
    dlBtn.disabled = false;
  };
  const seg = segEl(Object.entries(REC_MODELS).reverse().map(([k, m]) => [k, k === 'v6s' ? `${m.name}（推荐）` : m.name]), cur, async k => {
    s.cellModel = k;
    await store.saveSettings(s);
    toast(`读格子色号改用${REC_MODELS[k].name}模型`, 'ok');
    refresh();
  });
  seg.classList.add('model-seg');
  refresh();
  return h('div.card.mcard',
    h('div.mdesc', { style: { marginBottom: '8px' } }, '读拼豆板格子上印的色号时用（设置拼豆板时的“逐格读色号”、拼豆时的“识字核对”）。读清单一直用标准模型——实测它读清单更准。'),
    seg, note, status, dlBtn);
}

// ---------- 实况文本 ----------

function textCard(app) {
  const s = app.settings;
  const cfg = s.methods.text;
  const sw = switchEl(cfg.enabled, async on => {
    cfg.enabled = on;
    if (on && !store.enabledMethods(s).includes(s.defaultMethod)) s.defaultMethod = 'text';
    await store.saveSettings(s);
    toast(on ? '已开启实况文本' : '已关闭实况文本');
    app.rerender();
  });
  return h('div.card.mcard',
    h('div.mhead', h('div.grow',
      h('div.mtitle', '实况文本 / 快捷指令 ', cfg.enabled ? h('span.tag.ok', '已开启') : null),
      h('div.mdesc', '用 iPhone 自带的文字识别（Apple Vision）把截图里的字拷贝出来再粘贴。离线、免费，不需要任何参数。')), sw),
    cfg.enabled ? h('div.mbody', h('p.small.muted', '使用方法见“识别”页里的“怎样把截图里的字拷贝出来？”。')) : null);
}

// ---------- 色卡 ----------

function paletteCard(app) {
  const d = store.paletteDiff();
  return h('div.card.click-card', { onclick: () => { app.settingsPage = 'palette'; app.render(); } },
    h('div.row.gap',
      h('div.pal-strip', [...PALETTE.values()].filter((_, i) => i % Math.ceil(PALETTE.size / 12) === 0).slice(0, 12)
        .map(p => h('i', { style: { background: p.hex } }))),
      h('div.grow',
        h('div.k', '色卡管理'),
        h('div.small.muted', `${PALETTE.size} 色 · ${SERIES.length} 个系列` + (d.custom ? ` · 已自定义 ${d.added.length + d.changed.length + d.removed.length} 处` : ' · 内置 MARD 280 色'))),
      h('span.muted', { style: { fontSize: '22px' } }, '›')),
    h('div.tiny.muted', { style: { marginTop: '8px' } }, '新增、修改、删除色号和颜色；支持从照片取色、批量导入导出。'));
}

// ---------- 库存参数 ----------

function inventoryCard(app) {
  const s = app.settings;
  const th = h('input.input', { type: 'number', inputmode: 'numeric', value: s.defaultThreshold, min: 0 });
  const loss = h('input.input', { type: 'number', inputmode: 'decimal', value: s.lossPercent, min: 0, max: 50, step: 1 });
  const presets = h('input.input', { value: s.restockPresets.join(', '), inputmode: 'numeric', style: { width: '150px' } });
  const save = async () => {
    const t = Math.round(+th.value), l = +loss.value;
    const ps = presets.value.split(/[,，\s]+/).map(Number).filter(n => n > 0).slice(0, 6);
    if (!(t >= 0)) return toast('补货线要是 0 或正数', 'error');
    if (!(l >= 0 && l <= 50)) return toast('损耗在 0–50% 之间', 'error');
    s.defaultThreshold = t; s.lossPercent = l; s.restockPresets = ps.length ? ps : [100, 500, 1000];
    await store.saveSettings(s);
    toast('已保存', 'ok');
    app.updateBadge();
  };
  for (const el of [th, loss, presets]) el.addEventListener('change', save);
  return h('div.card',
    h('div.kv', h('div', h('div.k', '默认补货线（颗）'), h('div.d', '某色剩余低于它就提醒补货；可在库存里给单色另设')), th),
    h('div.kv', h('div', h('div.k', '损耗（%）'), h('div.d', '掉豆、拼错的余量。例：5 表示需要量多算 5%')), loss),
    h('div.kv', h('div', h('div.k', '快捷补货按钮'), h('div.d', '库存页里一键 +N，用逗号分隔')), presets));
}

// ---------- 数据 ----------

function dataCard(app) {
  const persistLine = h('div.d', '检查中…');
  (async () => {
    try {
      const p = await navigator.storage?.persisted?.();
      persistLine.textContent = p ? '✓ 已申请持久保存，系统不会自动清理' : '未获得持久保存。请从主屏幕图标打开本应用，并定期导出备份。';
    } catch { persistLine.textContent = '此浏览器不支持查询。请定期导出备份。'; }
  })();
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!(await confirmDialog('用这个备份覆盖当前所有数据？', { ok: '覆盖导入', danger: true, detail: `备份时间：${data.exportedAt || '未知'}；${(data.colors || []).length} 个色号，${(data.patterns || []).length} 张图纸${(data.images || []).length ? `，${data.images.length} 张原图` : ''}。当前数据会被替换。` }))) return;
      await store.importData(data);
      toast('已导入', 'ok');
      app.render();
    } catch (e) { toast('导入失败：' + e.message, 'error'); }
    fileIn.value = '';
  });
  const withKeys = h('input', { type: 'checkbox' });
  const withImages = h('input', { type: 'checkbox' });
  const imgLabel = h('span', '同时导出图纸原图');
  store.imageStats().then(st => {
    imgLabel.textContent = st.count ? `同时导出图纸原图（${st.count} 张，约 ${(st.bytes / 1048576).toFixed(1)} MB）` : '同时导出图纸原图（目前没有）';
    if (!st.count) withImages.disabled = true;
  }).catch(() => {});
  return h('div.card',
    h('div.kv', h('div', h('div.k', '导出备份'), h('div.d', '生成 JSON 文件，可“存储到文件”→ iCloud 云盘'),
      h('label.row.gap-s.tiny.muted', { style: { marginTop: '4px' } }, withKeys, '同时导出 API Key / 口令'),
      h('label.row.gap-s.tiny.muted', { style: { marginTop: '4px' } }, withImages, imgLabel)),
    h('button.btn.sm', {
      onclick: async () => {
        const data = await store.exportData({ includeSecrets: withKeys.checked, includeImages: withImages.checked });
        const d = new Date();
        const name = `拼豆库存备份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
        await shareFile(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), name);
      },
    }, '导出')),
    h('div.kv', h('div', h('div.k', '从备份恢复'), h('div.d', '选择之前导出的 JSON 文件')), h('label.btn.sm', fileIn, '导入')),
    h('div.kv', h('div', h('div.k', '本地存储'), persistLine)),
    h('div.kv', h('div', h('div.k', '清空所有数据'), h('div.d', '库存、图纸、流水、设置全部删除')),
      h('button.btn.sm.danger', {
        onclick: async () => {
          if (!(await confirmDialog('确定清空所有数据？', { ok: '清空', danger: true, detail: '无法恢复。建议先导出备份。' }))) return;
          await store.resetAll();
          app.rec.session = null; app.rec.step = 'pick';
          toast('已清空');
          app.render();
        },
      }, '清空')));
}

function aboutCard(app) {
  const line = h('div.small.muted.about-line');
  const btn = h('button.btn.sm.soft.about-check', {
    type: 'button',
    onclick: async () => {
      btn.disabled = true; line.className = 'small muted about-line'; line.textContent = '正在检查…';
      const r = await updater.check();
      if (r === 'updating') line.textContent = '发现新版本，正在更新…（会自动刷新）';
      else if (r === 'latest') { line.className = 'small about-line ok'; line.textContent = `✓ 已经是最新版本 v${APP_VERSION}`; }
      else { line.className = 'small about-line bad'; line.textContent = '检查失败：可能没联网'; }
      btn.disabled = false;
    },
  }, '检查更新');
  return h('div.card',
    h('div.row.between', h('p', h('b', '拼豆计数器'), h('span.muted.small.about-ver', `　v${APP_VERSION}`), h('span.muted.small', ' · 仅供个人使用')), btn),
    line,
    h('p.small.muted', '发了新版本后，打开 App 时会自动更新（正在做事时不打断，顶上会出现“立即更新”）。'),
    h('p.small.muted', '所有库存数据只保存在这台手机的浏览器里。请从主屏幕图标打开（和 Safari 里打开的是两份独立的数据）。'),
    h('p.small.muted', `色卡：${PALETTE.size} 色（${SERIES.join(' ')}）。`),
    licenseLine(),
    license.hasOwnerKey() ? null : h('div.row.end', h('button.btn.sm.ghost.about-owner', { type: 'button', onclick: () => license.ownerImport(() => app.rerender()) }, '作者：导入密钥')));
}

/** 这台设备的试用激活情况 */
function licenseLine() {
  const el = h('p.small.muted.about-license', `设备码 ${license.deviceId()}`);
  license.status().then(st => {
    const what = st.dev ? '本地测试，不用激活' : st.owner ? '作者（这台手机上有密钥），永久' : st.ok ? `试用激活：${license.expText(st.exp)}` : '还没激活';
    el.textContent = `设备码 ${license.deviceId()} · ${what}`;
  }).catch(() => {});
  return el;
}

// ---------- 作者：给朋友生成试用激活码 ----------

const DAYS = [['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['0', '永久']];
function ownerCard(app) {
  let days = '30';
  const dev = h('input.input.own-dev', { placeholder: '对方的设备码，如 K7Q4-M2XD', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false });
  const note = h('input.input.own-note', { placeholder: '备注（谁的，可不填）', autocomplete: 'off' });
  const out = h('div.own-out');
  const list = h('div.own-list');
  const drawList = () => {
    const log = license.issued().slice(0, 8);
    clear(list).append(...(log.length ? [h('div.tiny.muted', '最近生成的：'), ...log.map(x => h('div.tiny.muted', `${x.note ? x.note + ' · ' : ''}${x.dev} · ${license.expText(x.exp)}`))] : []));
  };
  drawList();
  const gen = h('button.btn.primary.own-gen', {
    type: 'button',
    onclick: async () => {
      try {
        const r = await license.makeCode(dev.value, +days, note.value);
        clear(out).append(
          h('div.small', h('b', `给 ${r.dev} 的激活码`), ` · ${license.expText(r.exp)}`),
          h('div.mono.own-code', r.code),
          h('div.row.gap-s', h('button.btn.sm.soft', { type: 'button', onclick: () => copyText(r.code) }, '复制激活码')),
          h('div.tiny.muted', '发给对方，在他 App 的激活页面粘贴。只能在那一台设备上用，转给别人没用。'));
        drawList();
      } catch (e) { toast(e.message, 'error'); }
    },
  }, '生成激活码');
  return h('div.card',
    h('p.small.muted', { style: { marginTop: 0 } }, '朋友第一次打开 App 会看到自己的“设备码”，让他发给你；在这里生成激活码发回去。'),
    field('设备码', dev),
    field('能用多久', segEl(DAYS, days, v => { days = v; })),
    field('备注', note),
    gen, out, list,
    h('div.row.end', { style: { marginTop: '10px' } }, h('button.btn.sm.ghost', {
      type: 'button',
      onclick: async () => {
        if (!(await confirmDialog('从这台手机上移除作者密钥？', { ok: '移除', danger: true, detail: '移除后这台手机不能再生成激活码（已经发出去的照样能用）。这台手机本身已经激活，不受影响。以后可以用“拼豆激活密钥.txt”在 关于 → “作者：导入密钥” 再导入。' }))) return;
        license.removeOwnerKey(); toast('已移除'); app.rerender();
      },
    }, '移除密钥')));
}
