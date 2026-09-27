// 小型 UI 工具：创建元素、提示、底部弹层、确认框、色号选择器。
import { PALETTE, SERIES, hexOf, inkFor, isCode, normalizeCode, SERIES_NAMES } from './palette.js';

/** h('div.card#id', {onclick, style:{...}, ...attrs}, ...children) */
export function h(sel, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const [, tag = 'div', rest = ''] = sel.match(/^([a-z0-9]*)(.*)$/i);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v; // textarea 只认属性，不认 value 特性
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function toast(msg, kind = '') {
  const el = h('div.toast' + (kind ? '.' + kind : ''), msg);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 4200 : 2400);
}

/** 底部弹层。返回 { el, close } */
export function sheet(content, { title, onClose, tall = false } = {}) {
  const panel = h('div.sheet' + (tall ? '.tall' : ''),
    h('div.sheet-head',
      h('div.sheet-grip'),
      title ? h('div.sheet-title', title) : null,
      h('button.icon-btn.sheet-x', { 'aria-label': '关闭', onclick: () => close() }, '✕')),
    h('div.sheet-body', content));
  const back = h('div.backdrop', { onclick: e => { if (e.target === back) close(); } }, panel);
  document.body.appendChild(back);
  document.body.classList.add('noscroll');
  requestAnimationFrame(() => back.classList.add('show'));
  let closed = false;
  function close(v) {
    if (closed) return;
    closed = true;
    back.classList.remove('show');
    document.body.classList.remove('noscroll');
    setTimeout(() => back.remove(), 250);
    onClose?.(v);
  }
  return { el: panel, close };
}

export function confirmDialog(message, { ok = '确定', cancel = '取消', danger = false, detail } = {}) {
  return new Promise(resolve => {
    const s = sheet([
      h('p.confirm-msg', message),
      detail ? h('div.confirm-detail', detail) : null,
      h('div.row.gap.end',
        h('button.btn.ghost', { onclick: () => s.close(false) }, cancel),
        h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => s.close(true) }, ok)),
    ], { onClose: v => resolve(!!v) });
  });
}

/** 色号色块 */
export function chip(code, { size = 'md', label = code, rgb } = {}) {
  const bg = rgb ? `rgb(${rgb.join(',')})` : isCode(code) ? hexOf(code) : '#d9d9de';
  const fg = rgb ? inkFor(rgb) : isCode(code) ? inkFor(hexOf(code)) : '#555';
  return h('span.chip.' + size, { style: { background: bg, color: fg } }, label ?? '?');
}

/** 色号选择器（按系列分页 + 直接输入 + 按颜色推荐） */
export function pickCode({ current, suggestions = [], title = '选择色号' } = {}) {
  return new Promise(resolve => {
    let series = isCode(current) ? PALETTE.get(current).series : SERIES[0];
    const grid = h('div.code-grid');
    const tabs = h('div.series-tabs');
    const input = h('input.input', {
      placeholder: '直接输入，如 H7', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false,
      value: current || '',
    });
    const hint = h('div.hint');
    const renderGrid = () => {
      clear(tabs);
      for (const s of SERIES) {
        tabs.appendChild(h('button.tab' + (s === series ? '.on' : ''), { title: SERIES_NAMES[s] || '', onclick: () => { series = s; renderGrid(); } }, s));
      }
      clear(grid);
      for (const p of PALETTE.values()) {
        if (p.series !== series) continue;
        grid.appendChild(h('button.code-cell' + (p.code === current ? '.on' : ''), { onclick: () => s.close(p.code) },
          chip(p.code, { size: 'sm' })));
      }
    };
    const sug = suggestions.filter(isCode);
    const s = sheet([
      sug.length ? h('div.sug', h('div.muted.small', '按图中色块颜色推荐：'),
        h('div.row.wrap.gap', sug.map(c => h('button.code-cell', { onclick: () => s.close(c) }, chip(c, { size: 'sm' }))))) : null,
      h('div.row.gap', input, h('button.btn.primary', {
        onclick: () => {
          const c = normalizeCode(input.value);
          if (c) s.close(c); else hint.textContent = `“${input.value}” 不在当前色卡里（可在 设置 → 色卡管理 里添加）`;
        },
      }, '确定')),
      hint, tabs, grid,
    ], { title, tall: true, onClose: v => resolve(v || null) });
    input.addEventListener('input', () => {
      const c = normalizeCode(input.value);
      hint.textContent = c ? '' : '';
      if (c) { series = PALETTE.get(c).series; renderGrid(); }
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { const c = normalizeCode(input.value); if (c) s.close(c); } });
    renderGrid();
  });
}

/** 数字步进输入 */
export function stepper(value, onChange, { min = 0, step = 1, big = false } = {}) {
  const input = h('input.input.num' + (big ? '.big' : ''), {
    type: 'number', inputmode: 'numeric', pattern: '[0-9]*', min, value: value ?? '',
    placeholder: '数量',
  });
  const set = v => { input.value = v; onChange(v === '' ? null : Number(v)); };
  input.addEventListener('input', () => onChange(input.value === '' ? null : Math.max(min, Math.round(Number(input.value)))));
  input.addEventListener('focus', () => input.select());
  return h('div.stepper',
    h('button.step', { 'aria-label': '减少', onclick: () => set(Math.max(min, (Number(input.value) || 0) - step)) }, '−'),
    input,
    h('button.step', { 'aria-label': '增加', onclick: () => set((Number(input.value) || 0) + step) }, '+'));
}

export function fmtTime(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('zh-CN'); }

/** 让用户保存/分享一个文件（iPhone 上会弹出分享面板，可“存储到文件”→ iCloud 云盘） */
export async function shareFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); return true; } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: 0 } });
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败，请手动选择文字', 'error'); }
    ta.remove();
  }
}
