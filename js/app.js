// 入口：底部标签切换、共享状态、启动时恢复未完成的核对。
import * as store from './store.js';
import { renderRecognize } from './views/recognize.js';
import { renderInventory } from './views/inventory.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';
import { clear, toast } from './ui.js';

export const VERSION = '1.0.0';

const views = {
  recognize: renderRecognize,
  inventory: renderInventory,
  history: renderHistory,
  settings: renderSettings,
};

export const app = {
  tab: 'recognize',
  settings: null,
  // 识别流程的状态（works 里有 canvas，只在内存里；session 会存进数据库）
  rec: { step: 'pick', method: null, works: [], session: null, status: '', abort: null },
  view: document.getElementById('view'),
  title: document.getElementById('title'),
  actions: document.getElementById('top-actions'),
  backBtn: document.getElementById('back-btn'),

  async render() {
    this.settings = await store.getSettings();
    for (const b of document.querySelectorAll('#tabbar button')) b.classList.toggle('on', b.dataset.tab === this.tab);
    clear(this.actions);
    this.backBtn.hidden = true;
    this.backBtn.onclick = null;
    const scrollKeep = this._keepScroll ? window.scrollY : 0;
    try {
      await views[this.tab](this);
    } catch (e) {
      console.error(e);
      clear(this.view).append(Object.assign(document.createElement('div'), { className: 'banner bad', textContent: '出错了：' + e.message }));
    }
    window.scrollTo(0, this._keepScroll ? scrollKeep : 0);
    this._keepScroll = false;
    this.updateBadge();
  },

  /** 局部刷新时保持滚动位置 */
  rerender() { this._keepScroll = true; return this.render(); },

  go(tab) { this.tab = tab; return this.render(); },

  setTitle(t) { this.title.textContent = t; document.title = t === '拼豆计数器' ? t : `${t} · 拼豆计数器`; },

  setBack(fn) { this.backBtn.hidden = !fn; this.backBtn.onclick = fn; },

  async updateBadge() {
    try {
      const inv = await store.getInventory();
      const n = store.lowStockList(inv, this.settings).length;
      const b = document.getElementById('low-badge');
      b.hidden = !n;
      b.textContent = n > 99 ? '99+' : n;
    } catch { /* 忽略 */ }
  },

  /** 保存核对进度（防止切到相册看原图后 App 被系统回收） */
  saveSession: (() => {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(() => { if (app.rec.session) store.saveSession({ ...app.rec.session, step: app.rec.step }).catch(() => {}); }, 300);
    };
  })(),
};

document.getElementById('tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) app.go(b.dataset.tab);
});

async function start() {
  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persisted?.();
      if (!persisted) navigator.storage.persist().catch(() => {});
    }
  } catch { /* 部分浏览器不支持 */ }
  try {
    const s = await store.loadSession();
    if (s && ['verify', 'preview'].includes(s.step)) {
      app.rec.session = s;
      app.rec.step = s.step;
      app.rec.method = s.method;
    }
  } catch (e) { console.warn(e); }
  await app.render();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('有新版本，下次打开时生效');
      });
    });
  }).catch(e => console.warn('SW 注册失败', e));
}

window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  if (e.reason?.name !== 'AbortError') toast('出错了：' + (e.reason?.message || e.reason), 'error');
});

start();
