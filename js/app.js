// 入口：底部三个标签（图纸 / 库存 / 设置）、共享状态、启动时恢复未完成的核对。
import * as store from './store.js';
import { renderPatterns, resetPatternsUI } from './views/patterns.js';
import { renderInventory } from './views/inventory.js';
import { renderSettings } from './views/settings.js';
import { clear, toast, h } from './ui.js';
import { APP_VERSION } from './version.js';
import { status as licenseStatus, renderGate } from './license.js';
window.__appVersion = APP_VERSION; // 测试用：当前运行的版本

const views = {
  patterns: renderPatterns,
  inventory: renderInventory,
  settings: renderSettings,
};

export const app = {
  tab: 'patterns',
  settings: null,
  // 图纸标签里的页面：list 列表 / detail 详情 / add 添加（识别流程）/ build 拼豆 / totals 多选合计 / done 结算完成
  pat: { page: 'list', id: null, result: null },
  // 识别流程的状态（works 里有 canvas，只在内存里；session 会存进数据库）
  rec: { step: 'pick', method: null, works: [], session: null, status: '', abort: null },
  view: document.getElementById('view'),
  title: document.getElementById('title'),
  actions: document.getElementById('top-actions'),
  backBtn: document.getElementById('back-btn'),
  onLeave: null,

  async render() {
    this.settings = await store.getSettings();
    for (const b of document.querySelectorAll('#tabbar button')) b.classList.toggle('on', b.dataset.tab === this.tab);
    // 离开上一个页面：拼豆板等页面的清理
    try { this.onLeave?.(); } catch { /* 忽略 */ }
    this.onLeave = null;
    document.body.classList.remove('mode-build', 'mode-board');
    this.view.className = '';
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
    this.fresh = false;
    this.updateBadge();
  },

  /** 局部刷新时保持滚动位置 */
  rerender() { this._keepScroll = true; return this.render(); },

  /** 切换标签。fresh = 刚切进来（页面可以回到首页状态） */
  go(tab) { if (tab !== this.tab) this.fresh = true; this.tab = tab; return this.render(); },

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
  if (!b) return;
  const tab = b.dataset.tab;
  if (tab === 'settings') app.settingsPage = null; // 再点一次“设置”回到设置首页
  // 再点一次“图纸”回到图纸列表（正在添加的图纸会保留，列表顶上可以继续）；从别的标签切回来则回到原来的页面
  if (tab === 'patterns' && app.tab === 'patterns') { app.pat.page = 'list'; resetPatternsUI(); }
  app.fresh = true;
  app.go(tab);
});

async function start() {
  // 试用激活：没激活（或到期）的设备只显示激活页面（见 license.js）
  const lic = await licenseStatus().catch(e => { console.warn(e); return { ok: true }; });
  if (!lic.ok) { renderGate(lic, () => start()); return; }
  await store.loadPalette();
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
      app.pat.page = 'add';
    }
  } catch (e) { console.warn(e); }
  await app.render();
  store.gcImages(); // 清理没人用的图纸原图（不阻塞界面）
}

// ---------- 更新到新版本 ----------
// 发新版本后：打开 / 切回 App 时检查，新版本装好后自动刷新一次（正在做事时不打断，显示“点这里更新”）
export const updater = {
  reg: null,
  ready: false,           // 新版本已经装好、接管了这个页面，但页面还是旧代码
  /** 手动检查（设置 → 关于）。返回 'latest' | 'updating' | 'error' */
  async check() {
    if (!this.reg) return 'error';
    try { await this.reg.update(); } catch { return 'error'; }
    if (this.ready || this.reg.installing || this.reg.waiting) { this.force = true; if (this.ready) location.reload(); return 'updating'; }
    return 'latest';
  },
};

/** 现在刷新会不会丢掉正在做的事：弹层开着、正在添加图纸（识别中）、正在设置或拼拼豆板 */
function busy() {
  if (document.querySelector('.backdrop, .pz, .qrscan')) return true;
  return app.tab === 'patterns' && ['add', 'build'].includes(app.pat.page);
}

function showUpdateBar() {
  if (document.querySelector('.update-bar')) return;
  const bar = h('div.update-bar',
    h('span.grow', `新版本已经下载好`),
    h('button.btn.sm.primary.update-go', { onclick: () => location.reload() }, '立即更新'),
    h('button.icon-btn', { 'aria-label': '稍后', onclick: () => bar.remove() }, '✕'));
  document.body.appendChild(bar);
}

function onUpdateReady() {
  updater.ready = true;
  if (updater.force || !busy()) location.reload();
  else showUpdateBar();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller; // 第一次装（之前没有）不用刷新
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) onUpdateReady(); });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => { updater.reg = reg; }).catch(e => console.warn('SW 注册失败', e));
  // 从后台切回来（iPhone 上“再打开”常常只是切回来，页面不会重新加载）：检查一下有没有新版本；
  // 之前因为在忙没刷新的，现在不忙了就刷新
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (updater.ready && !busy()) { location.reload(); return; }
    updater.reg?.update().catch(() => {});
  });
}

window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  if (e.reason?.name !== 'AbortError') toast('出错了：' + (e.reason?.message || e.reason), 'error');
});

start();
