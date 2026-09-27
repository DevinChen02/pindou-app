// 设置 → 色卡管理：自定义色卡的增、删、改，批量导入导出，恢复默认。
import { h, clear, toast, sheet, confirmDialog, chip, fmtNum, copyText, shareFile } from '../ui.js';
import {
  PALETTE, SERIES, DEFAULT_HEX, CODE_RE, seriesOf, seriesLabel, inkFor, hexToRgb, rgbToLab,
} from '../palette.js';
import { makeCanvas, loadImageFile } from '../image.js';
import * as store from '../store.js';

const ui = { series: 'all', q: '' };

export async function renderPaletteManager(app) {
  app.setTitle('色卡管理');
  app.setBack(() => { app.settingsPage = null; app.render(); });
  app.actions.append(h('button.btn.sm.primary', { onclick: () => editSheet(app, null) }, '＋ 新增'));
  const view = clear(app.view);
  const diff = store.paletteDiff();
  const changedSet = new Set([...diff.added, ...diff.changed]);

  view.append(h('p.small.muted', { style: { margin: '4px 2px 8px' } },
    `共 ${PALETTE.size} 色 · ${SERIES.length} 个系列。`,
    diff.custom ? `已自定义：新增 ${diff.added.length}、改色 ${diff.changed.length}、删除 ${diff.removed.length}。` : '当前是内置色卡（MARD 280 色）。',
    '点任一颜色可修改或删除。'));

  const search = h('input.input', { type: 'search', placeholder: '搜索色号或名称', value: ui.q, autocapitalize: 'characters', autocomplete: 'off' });
  const counts = {};
  for (const p of PALETTE.values()) counts[p.series] = (counts[p.series] || 0) + 1;
  if (ui.series !== 'all' && ui.series !== 'changed' && !counts[ui.series]) ui.series = 'all';
  const filters = h('div.filters',
    h('button' + (ui.series === 'all' ? '.on' : ''), { onclick: () => { ui.series = 'all'; app.rerender(); } }, `全部 ${PALETTE.size}`),
    changedSet.size ? h('button' + (ui.series === 'changed' ? '.on' : ''), { onclick: () => { ui.series = 'changed'; app.rerender(); } }, `已改动 ${changedSet.size}`) : null,
    SERIES.map(s => h('button' + (ui.series === s ? '.on' : ''), { onclick: () => { ui.series = s; app.rerender(); } }, `${seriesLabel(s)} ${counts[s]}`)));
  view.append(h('div.inv-tools', search, filters));

  const grid = h('div.inv-grid.pal-grid');
  const draw = () => {
    clear(grid);
    const q = ui.q.trim().toUpperCase();
    let n = 0;
    for (const p of PALETTE.values()) {
      if (ui.series === 'changed' ? !changedSet.has(p.code) : ui.series !== 'all' && p.series !== ui.series) continue;
      if (q && !p.code.startsWith(q) && !(p.name || '').toUpperCase().includes(q)) continue;
      n++;
      const tag = !DEFAULT_HEX.has(p.code) ? '新' : DEFAULT_HEX.get(p.code) !== p.hex ? '改' : null;
      grid.append(h('button.tile', { onclick: () => editSheet(app, p.code) },
        chip(p.code, { size: 'sm' }),
        h('div.pal-sub', p.name || p.hex),
        tag ? h('span.flag.' + (tag === '新' ? 'new' : 'chg'), tag) : null));
    }
    if (!n) grid.append(h('div.empty', { style: { gridColumn: '1 / -1' } }, h('div.big-ico', '🎨'), h('p', '没有匹配的颜色'),
      h('button.btn.primary', { onclick: () => editSheet(app, null, ui.q.trim().toUpperCase()) }, '新增这个颜色')));
  };
  search.addEventListener('input', () => { ui.q = search.value; draw(); });
  view.append(grid);
  draw();

  view.append(h('div.section-title', '更多'));
  view.append(h('div.card',
    h('div.kv', h('div', h('div.k', '批量导入 / 导出'), h('div.d', '一次添加很多颜色（比如另一个品牌的色卡），或把色卡发给别的设备')),
      h('button.btn.sm', { onclick: () => batchSheet(app) }, '打开')),
    h('div.kv', h('div', h('div.k', '恢复默认色卡'), h('div.d', '回到内置的 MARD 280 色')),
      h('button.btn.sm' + (diff.custom ? '.danger' : ''), {
        disabled: !diff.custom,
        onclick: async () => {
          const ok = await confirmDialog('恢复内置的 280 色色卡？', {
            ok: '恢复默认', danger: true,
            detail: `你的自定义会被清除（新增 ${diff.added.length}、改色 ${diff.changed.length}、删除 ${diff.removed.length}）。库存数量不受影响；自定义新增色号的库存会暂时看不到，重新添加该色号后会再出现。`,
          });
          if (!ok) return;
          await store.resetPalette();
          toast('已恢复默认色卡', 'ok');
          app.rerender();
        },
      }, '恢复'))));
}

// ---------- 新增 / 编辑 ----------

function editSheet(app, code, presetCode = '') {
  const p = code ? PALETTE.get(code) : null;
  const state = { code: p?.code || (CODE_RE.test(presetCode) ? presetCode : ''), hex: p?.hex || suggestHex(), name: p?.name || '' };
  const preview = h('span.chip.lg');
  const seriesHint = h('div.tiny.muted', { style: { margin: '4px 2px 0' } });
  const err = h('div.hint');
  const codeIn = h('input.input', { value: state.code, placeholder: '如 H7、P23、ZG1', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, maxlength: 6 });
  const hexIn = h('input.input.mono', { value: state.hex, placeholder: '#RRGGBB', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, maxlength: 7 });
  const colorIn = h('input.color-well', { type: 'color', value: state.hex.toLowerCase(), 'aria-label': '选择颜色' });
  const nameIn = h('input.input', { value: state.name, placeholder: '可选，如“奶油白”', maxlength: 20 });
  const restore = h('div');

  const refresh = () => {
    const okHex = /^#[0-9A-F]{6}$/.test(state.hex);
    preview.textContent = state.code || '?';
    preview.style.background = okHex ? state.hex : '#ddd';
    preview.style.color = okHex ? inkFor(state.hex) : '#555';
    const s = seriesOf(state.code);
    seriesHint.textContent = !state.code ? '系列按色号前面的字母自动归类，如 ZG1 归入 ZG 系列'
      : !CODE_RE.test(state.code) ? '格式：1–3 个字母 + 1–3 位数字'
        : SERIES.includes(s) ? `归入 ${seriesLabel(s)} 系列` : `会新建 ${s} 系列`;
    clear(restore);
    const def = DEFAULT_HEX.get(p?.code);
    if (p && def && def !== state.hex) {
      restore.append(h('button.link.small', { type: 'button', onclick: () => setHex(def) }, `恢复内置颜色 ${def}`));
    }
    const similar = okHex ? nearestOthers(state.hex, state.code) : null;
    if (similar) restore.append(h('div.tiny.muted', `和 ${similar.code} 很接近（色差 ${similar.de.toFixed(1)}）`));
  };
  const setHex = hex => {
    state.hex = hex.toUpperCase();
    hexIn.value = state.hex;
    colorIn.value = state.hex.toLowerCase();
    err.textContent = '';
    refresh();
  };
  codeIn.addEventListener('input', () => {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    state.code = codeIn.value;
    err.textContent = '';
    refresh();
  });
  hexIn.addEventListener('input', () => {
    let v = hexIn.value.toUpperCase().replace(/[^0-9A-F#]/g, '');
    if (v && !v.startsWith('#')) v = '#' + v.replace(/#/g, '');
    hexIn.value = v;
    state.hex = v;
    if (/^#[0-9A-F]{6}$/.test(v)) colorIn.value = v.toLowerCase();
    refresh();
  });
  colorIn.addEventListener('input', () => setHex(colorIn.value));
  nameIn.addEventListener('input', () => { state.name = nameIn.value.trim(); });

  const save = async () => {
    const newCode = state.code.trim().toUpperCase();
    if (!CODE_RE.test(newCode)) { err.textContent = '色号格式不对：1–3 个字母 + 1–3 位数字，如 H7、P23、ZG1'; codeIn.focus(); return; }
    if (!/^#[0-9A-F]{6}$/.test(state.hex)) { err.textContent = '颜色格式不对：#RRGGBB，如 #FF8800'; hexIn.focus(); return; }
    if (newCode !== p?.code && PALETTE.has(newCode)) { err.textContent = `色号 ${newCode} 已经存在`; return; }
    if (p && newCode !== p.code) {
      const rec = await store.stockRecord(p.code);
      const ok = await confirmDialog(`把 ${p.code} 改成 ${newCode}？`, {
        ok: '改名',
        detail: rec?.stock ? `库存里的 ${fmtNum(rec.stock)} 颗会一起转到 ${newCode}。已保存的图纸和流水里仍显示旧色号。` : '已保存的图纸和流水里仍显示旧色号。',
      });
      if (!ok) return;
    }
    try {
      await store.upsertColor({ oldCode: p?.code || null, code: newCode, hex: state.hex, name: state.name });
      toast(p ? '已保存' : `已新增 ${newCode}`, 'ok');
      sh.close();
      app.rerender();
    } catch (e) { err.textContent = e.message; }
  };

  const del = async () => {
    const rec = await store.stockRecord(p.code);
    const ok = await confirmDialog(`从色卡删除 ${p.code}？`, {
      ok: '删除', danger: true,
      detail: rec?.stock
        ? `库存里还有 ${fmtNum(rec.stock)} 颗 ${p.code}，删除后这条库存也会一起删除（会记入流水）。`
        : DEFAULT_HEX.has(p.code) ? '这是内置色号，之后可以用“恢复默认色卡”找回。' : '删除后识别和库存里都不再有这个色号。',
    });
    if (!ok) return;
    await store.deleteColor(p.code);
    toast(`已删除 ${p.code}`, 'ok');
    sh.close();
    app.rerender();
  };

  const photoIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
  photoIn.addEventListener('change', async () => {
    const f = photoIn.files[0];
    photoIn.value = '';
    if (!f) return;
    const hex = await eyedropper(f);
    if (hex) setHex(hex);
  });

  const sh = sheet([
    h('div.pal-preview', preview),
    h('div.field', h('label', '色号', h('span.req', ' *')), codeIn, seriesHint),
    h('div.field', h('label', '颜色', h('span.req', ' *')),
      h('div.row.gap', colorIn, hexIn),
      h('div.row.gap.wrap', { style: { marginTop: '8px' } },
        h('label.btn.soft.sm', photoIn, '📷 从照片取色'),
        restore)),
    h('div.field', h('label', '名称（可选）'), nameIn),
    err,
    h('div.row.gap', { style: { marginTop: '6px' } },
      p ? h('button.btn.ghost.danger-text', { type: 'button', onclick: del }, '删除') : null,
      h('div.grow'),
      h('button.btn.ghost', { type: 'button', onclick: () => sh.close() }, '取消'),
      h('button.btn.primary', { type: 'button', onclick: save }, p ? '保存' : '新增')),
  ], { title: p ? `编辑 ${p.code}` : '新增颜色' });
  refresh();
  if (!p) setTimeout(() => codeIn.focus(), 300);
}

function suggestHex() { return '#CCCCCC'; }

function nearestOthers(hex, code) {
  const lab = rgbToLab(hexToRgb(hex));
  let best = null;
  for (const p of PALETTE.values()) {
    if (p.code === code) continue;
    const de = Math.hypot(lab[0] - p.lab[0], lab[1] - p.lab[1], lab[2] - p.lab[2]);
    if (!best || de < best.de) best = { code: p.code, de };
  }
  return best && best.de < 3 ? best : null;
}

/** 从照片取色：点图上任意位置，取周围一小块的平均色 */
async function eyedropper(file) {
  let canvas;
  try { canvas = await loadImageFile(file); } catch (e) { toast('读取照片失败：' + e.message, 'error'); return null; }
  return new Promise(resolve => {
    const k = Math.min(1, 1200 / Math.max(canvas.width, canvas.height));
    const view = makeCanvas(canvas.width * k, canvas.height * k);
    view.getContext('2d').drawImage(canvas, 0, 0, view.width, view.height);
    const g = view.getContext('2d', { willReadFrequently: true });
    const img = h('img', { src: view.toDataURL('image/jpeg', 0.85), alt: '' });
    const mark = h('div.eyedrop-mark', { hidden: true });
    const wrap = h('div.eyedrop', img, mark);
    const sw = h('span.sw', { style: { width: '44px', height: '44px', background: '#fff' } });
    const hexLbl = h('b.mono', '点图上的颜色');
    let picked = null;
    const pick = e => {
      const b = img.getBoundingClientRect();
      const fx = (e.clientX - b.left) / b.width, fy = (e.clientY - b.top) / b.height;
      if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return;
      const x = Math.round(fx * view.width), y = Math.round(fy * view.height);
      const r = Math.max(2, Math.round(view.width / 150));
      const d = g.getImageData(Math.max(0, x - r), Math.max(0, y - r), r * 2 + 1, r * 2 + 1).data;
      let R = 0, G = 0, B = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
      picked = '#' + [R, G, B].map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('').toUpperCase();
      sw.style.background = picked;
      hexLbl.textContent = picked;
      mark.hidden = false;
      mark.style.left = fx * 100 + '%';
      mark.style.top = fy * 100 + '%';
      useBtn.disabled = false;
    };
    wrap.addEventListener('pointerdown', e => { e.preventDefault(); wrap.setPointerCapture(e.pointerId); pick(e); });
    wrap.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') pick(e); });
    const useBtn = h('button.btn.primary', { disabled: true, onclick: () => s.close(picked) }, '用这个颜色');
    const s = sheet([
      h('p.small.muted', '点或拖动到豆子上，取一小块的平均色。照片光线会让颜色偏暗，可取完再微调。'),
      wrap,
      h('div.row.gap', { style: { marginTop: '10px' } }, sw, hexLbl, h('div.grow'), useBtn),
    ], { title: '从照片取色', tall: true, onClose: v => resolve(v || null) });
  });
}

// ---------- 批量导入 / 导出 ----------

function batchSheet(app) {
  let mode = 'import';
  const body = h('div');
  const seg = h('div.seg');
  const drawSeg = () => {
    clear(seg);
    for (const [k, label] of [['import', '导入'], ['export', '导出']]) {
      seg.append(h('button' + (mode === k ? '.on' : ''), { onclick: () => { mode = k; drawSeg(); drawBody(); } }, label));
    }
  };
  const drawBody = () => {
    clear(body);
    if (mode === 'import') {
      const ta = h('textarea.input.mono', { placeholder: '每行一个：色号 颜色 [名称]\n例如：\nZG1 #DAABB3 暗粉\nZG2 D6AA87\nH7 #000000', style: { minHeight: '180px' } });
      const out = h('div.small', { style: { marginTop: '8px' } });
      body.append(
        h('p.small.muted', '已有的色号会更新颜色，新的色号会新增。每行格式：色号、空格、#RRGGBB，名称可省略。'),
        ta,
        h('button.btn.primary.block', {
          style: { marginTop: '10px' },
          onclick: async () => {
            if (!ta.value.trim()) { toast('请先粘贴内容'); return; }
            const r = await store.importPaletteText(ta.value);
            out.className = 'small ' + (r.errors.length ? 'hint' : 'muted');
            out.textContent = `新增 ${r.added} 个，更新 ${r.updated} 个` + (r.errors.length ? `；${r.errors.length} 行格式不对：${r.errors.slice(0, 3).join(' / ')}${r.errors.length > 3 ? '…' : ''}` : '');
            if (r.added || r.updated) { toast(`已导入：新增 ${r.added}，更新 ${r.updated}`, 'ok'); app.rerender(); }
          },
        }, '导入'),
        out);
    } else {
      const text = store.paletteText();
      body.append(
        h('p.small.muted', `当前色卡 ${PALETTE.size} 色。可复制后粘贴到另一台设备的“导入”里。`),
        h('textarea.input.mono', { readonly: true, value: text, style: { minHeight: '180px' } }),
        h('div.row.gap', { style: { marginTop: '10px' } },
          h('button.btn.grow', { onclick: () => copyText(text) }, '复制全部'),
          h('button.btn.grow', { onclick: () => shareFile(new Blob([text], { type: 'text/plain' }), '拼豆色卡.txt') }, '存为文件')));
    }
  };
  drawSeg();
  drawBody();
  sheet([seg, h('div.spacer'), body], { title: '批量导入 / 导出', tall: true });
}
