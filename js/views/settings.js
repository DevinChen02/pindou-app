// “设置”标签：识别方法开关（开启前必须填好所需参数并通过自检）、库存参数、备份。
import { h, clear, toast, confirmDialog, shareFile } from '../ui.js';
import * as store from '../store.js';
import { testConnection } from '../extract/vlm.js';
import { testOcr } from '../extract/ocr.js';
import { renderPaletteManager } from './palette.js';
import { PALETTE, SERIES } from '../palette.js';

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

  view.append(h('div.section-title', '色卡'), paletteCard(app));
  view.append(h('div.section-title', '库存'), inventoryCard(app));
  view.append(h('div.section-title', '数据与备份'), dataCard(app));
  view.append(h('div.section-title', '关于'), aboutCard());
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
  const base = h('input.input', { value: d.basePath, placeholder: './vendor/tesseract/', autocapitalize: 'off', spellcheck: false });
  base.addEventListener('input', () => { d.basePath = base.value.trim(); });
  async function test(save) {
    if (!d.basePath) { status.className = 'status-line bad'; status.textContent = '请先填写：识别引擎位置'; return; }
    status.className = 'status-line'; status.textContent = '正在加载离线识别引擎（首次约 7 MB，之后可离线使用）…';
    try {
      const r = await testOcr(d, m => {
        if (m.progress != null && m.status && !/recognizing/.test(m.status)) status.textContent = `正在加载离线识别引擎… ${Math.round(m.progress * 100)}%`;
        else if (/recognizing/.test(m.status || '')) status.textContent = '引擎已加载，正在自检…';
      });
      if (!r.ok) throw new Error(`引擎能运行，但自检图读成了：${r.got || '空'}`);
      status.className = 'status-line ok'; status.textContent = `✓ 离线识别可用（自检读到：${r.got}）`;
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
      field('识别引擎位置', base, { req: true, note: '随应用一起部署在 vendor/tesseract/，一般不用改。' }),
      status,
      h('div.row.gap.wrap',
        h('button.btn.soft', { type: 'button', onclick: () => test(false) }, '自检'),
        h('button.btn.primary', { type: 'button', onclick: () => test(true) }, cfg.enabled ? '保存' : '自检并启用'),
        !cfg.enabled ? h('button.btn.ghost', { type: 'button', onclick: () => { draft.open.ocr = false; draft.ocr = null; app.rerender(); } }, '取消') : null)) : null);
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
      if (!(await confirmDialog('用这个备份覆盖当前所有数据？', { ok: '覆盖导入', danger: true, detail: `备份时间：${data.exportedAt || '未知'}；${(data.colors || []).length} 个色号，${(data.patterns || []).length} 张图纸。当前数据会被替换。` }))) return;
      await store.importData(data);
      toast('已导入', 'ok');
      app.render();
    } catch (e) { toast('导入失败：' + e.message, 'error'); }
    fileIn.value = '';
  });
  const withKeys = h('input', { type: 'checkbox' });
  return h('div.card',
    h('div.kv', h('div', h('div.k', '导出备份'), h('div.d', '生成 JSON 文件，可“存储到文件”→ iCloud 云盘'),
      h('label.row.gap-s.tiny.muted', { style: { marginTop: '4px' } }, withKeys, '同时导出 API Key / 口令')),
    h('button.btn.sm', {
      onclick: async () => {
        const data = await store.exportData({ includeSecrets: withKeys.checked });
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

function aboutCard() {
  return h('div.card',
    h('p', h('b', '拼豆计数器'), h('span.muted.small', '　v1.1 · 仅供个人使用')),
    h('p.small.muted', '所有库存数据只保存在这台手机的浏览器里。请从主屏幕图标打开（和 Safari 里打开的是两份独立的数据）。'),
    h('p.small.muted', `色卡：${PALETTE.size} 色（${SERIES.join(' ')}）。`));
}
