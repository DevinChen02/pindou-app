// 试用激活：别人想用这个 App，要找作者要一个“激活码”。激活码和那台设备绑定（每台设备有自己的“设备码”），
// 所以对方把网址或激活码转给别人都没用——别人打开只会看到自己的设备码，还得再找作者要。iPhone 和 iPad 看板各自激活。
//
// 激活码 = 作者用私钥对“设备码 + 到期日”做的签名（ECDSA P-256）；App 里只有公钥，只能验证、造不出来。
// 私钥不在代码里、不在仓库里，只在作者手机上（激活页面最下面“我是作者”导入一次），在 设置 → 试用激活码 里给别人生成激活码。
// 验证全在手机上算，没网也能用。
//
// 到期、或者被作者停用：只能查看（图纸、拼豆板、库存都看得到，也能导出备份），不能扫新的图、不能改任何东西。
// 停用名单在网站上的 revoked.json（作者在 App 里点“停用”就会改它）；每台设备打开 App、切回前台时去拿一次，没网就用上次拿到的。
// 挡得住普通转发；挡不住会改代码的人（网页代码本来就能下载）——够给朋友试用。
import { h, clear, toast, sheet, copyText } from './ui.js';

const PUBLIC_KEY = { kty: 'EC', crv: 'P-256', x: 'OiJp3NLRZJOg200fQco_cImfeHzynanMah8_NNdyKsY', y: 'SxH_oZyokT7O_xt_3wvqZwARu57DJ2Oeetj_PU5If-8' };
const K = { device: 'pindou-device', act: 'pindou-activation', owner: 'pindou-owner-key', issued: 'pindou-issued', force: 'pindou-license-test', revoked: 'pindou-revoked', gh: 'pindou-github', ownerList: 'pindou-revoked-owner' };
const EPOCH = Date.UTC(2020, 0, 1);
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 没有 0/O、1/I/L，念给别人听也不会弄错
const ALGO = { name: 'ECDSA', namedCurve: 'P-256' }, SIGN = { name: 'ECDSA', hash: 'SHA-256' };

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 无所谓 */ } },
};
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export const today = () => Math.floor((Date.now() - EPOCH) / 86400000);
export const dayText = d => new Date(EPOCH + d * 86400000).toISOString().slice(0, 10);

/** 本地测试（电脑上 127.0.0.1）不用激活，除非测试要看激活页面 */
const devHost = () => ['127.0.0.1', 'localhost'].includes(location.hostname) && ls.get(K.force) !== '1';

/** 这台设备的设备码（第一次打开时随机生成，存在这台设备上），如 K7Q4-M2XD */
export function deviceId() {
  let id = ls.get(K.device);
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(id || '')) {
    const r = crypto.getRandomValues(new Uint8Array(8));
    const s = [...r].map(b => ALPHA[b % ALPHA.length]).join('');
    id = s.slice(0, 4) + '-' + s.slice(4);
    ls.set(K.device, id);
  }
  return id;
}
/** 别人发来的设备码：大小写、空格、横线都不要紧 */
export function normalizeDevice(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length !== 8 || [...t].some(c => !ALPHA.includes(c))) return null;
  return t.slice(0, 4) + '-' + t.slice(4);
}

const message = (dev, exp) => new TextEncoder().encode(`pindou-activation|1|${dev}|${exp}`);
let pubKey = null;
const publicKey = () => (pubKey ||= crypto.subtle.importKey('jwk', PUBLIC_KEY, ALGO, false, ['verify']));

/** 激活码 → { exp（到期那天，0 = 永久）, sig }；格式不对返回 null */
function parse(code) {
  const s = String(code || '').replace(/\s+/g, '');
  if (!/^PD1[A-Za-z0-9_-]{88}$/.test(s)) return null;
  const b = unb64u(s.slice(3));
  if (b.length !== 66) return null;
  return { exp: (b[0] << 8) | b[1], sig: b.slice(2) };
}

/** 验证激活码是不是给这台设备的：{ ok, exp, expired } */
export async function verify(code, dev = deviceId()) {
  const p = parse(code);
  if (!p) return { ok: false, bad: 'format' };
  let good = false;
  try { good = await crypto.subtle.verify(SIGN, await publicKey(), p.sig, message(dev, p.exp)); } catch { good = false; }
  if (!good) return { ok: false, bad: 'device' };
  const expired = p.exp > 0 && today() > p.exp;
  return { ok: !expired, exp: p.exp, expired };
}

/** 激活码的编号（停用单个激活码用）：签名的前一段，每个激活码都不一样 */
export const codeId = code => String(code || '').replace(/\s+/g, '').slice(3, 19);

/**
 * 现在能不能用：
 *   { ok: true, exp, owner }                  正常
 *   { ok: false, none: true }                 没激活（或者激活码不是这台设备的）→ 激活页面
 *   { ok: false, readOnly: true, expired|revoked, exp } 到期 / 被停用 → 只能查看
 */
export async function status() {
  if (!crypto?.subtle) return { ok: true, insecure: true }; // 不是 https（本地调试）没有加密接口：不拦
  if (devHost()) return { ok: true, dev: true, owner: hasOwnerKey() };
  const code = ls.get(K.act);
  if (!code) return { ok: false, none: true };
  const r = await verify(code);
  if (r.bad) return { ok: false, none: true };
  const owner = hasOwnerKey();
  if (!owner && isRevoked(deviceId(), codeId(code))) return { ok: false, readOnly: true, revoked: true, exp: r.exp };
  if (r.expired) return { ok: false, readOnly: true, expired: true, exp: r.exp, owner };
  return { ok: true, exp: r.exp, owner };
}

/** 只能查看时的说明（也用在“改不了”的提示里） */
export function readOnlyText(st) {
  return st.revoked ? '这台设备的激活已经被作者停用：现在只能查看，不能扫新的图、不能修改。'
    : `试用已经到期（${dayText(st.exp)}）：现在只能查看，不能扫新的图、不能修改。`;
}

// ---------- 停用名单（网站上的 revoked.json） ----------

const readJSON = (k, d) => { try { return JSON.parse(ls.get(k) || '') ?? d; } catch { return d; } };
function isRevoked(dev, id) {
  const r = readJSON(K.revoked, {});
  return (r.devices || []).includes(dev) || (!!id && (r.codes || []).includes(id));
}
function cleanList(j) {
  return {
    devices: [...new Set((Array.isArray(j?.devices) ? j.devices : []).map(normalizeDevice).filter(Boolean))],
    codes: [...new Set((Array.isArray(j?.codes) ? j.codes : []).filter(c => /^[A-Za-z0-9_-]{16}$/.test(c)))],
  };
}
const revokedUrl = () => new URL('revoked.json', document.baseURI).href;

/** 去网站拿最新的停用名单，存在这台设备上（没网就用上次的）。返回名单或 null */
export async function refreshRevoked() {
  try {
    const r = await fetch(revokedUrl() + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) { if (r.status === 404) { ls.set(K.revoked, JSON.stringify({ devices: [], codes: [], at: Date.now() })); } return null; }
    const list = cleanList(await r.json());
    ls.set(K.revoked, JSON.stringify({ ...list, at: Date.now() }));
    return list;
  } catch { return null; }
}

/**
 * 打开 App 时、切回前台时（最多一分钟一次）拿一次停用名单；能不能用的状态变了就调 onChange(新状态)。
 * 作者刚停用的设备，下次联网打开就只能查看；恢复了也一样马上生效。
 */
export function watchRevocation(current, onChange) {
  let last = 0, cur = current;
  const check = async () => {
    if (Date.now() - last < 60000) return;
    last = Date.now();
    if (!(await refreshRevoked())) return;
    const st = await status();
    const key = x => `${x.ok}|${!!x.readOnly}|${!!x.revoked}|${!!x.none}`;
    if (key(st) !== key(cur)) { cur = st; onChange(st); }
  };
  check();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}

// ---------- 作者：私钥 ----------

export const hasOwnerKey = () => /^PDKEY1\./.test(ls.get(K.owner) || '');
async function privateKey(text = ls.get(K.owner)) {
  const m = String(text || '').trim().match(/PDKEY1\.([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('这不是作者密钥（应该是 PDKEY1. 开头的一整行）');
  return crypto.subtle.importKey('pkcs8', unb64u(m[1]), ALGO, false, ['sign']);
}
async function sign(key, dev, exp) {
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, key, message(dev, exp)));
  return 'PD1' + b64u(new Uint8Array([exp >> 8, exp & 255, ...sig]));
}

/** 导入作者密钥：先确认和 App 里的公钥是一对，再存下来，顺便把这台设备永久激活 */
export async function importOwnerKey(text) {
  const key = await privateKey(text).catch(() => { throw new Error('密钥读不出来：要把 PDKEY1. 开头的那一整行完整粘贴进来'); });
  const code = await sign(key, deviceId(), 0);
  const r = await verify(code);
  if (!r.ok) throw new Error('这个密钥和这个 App 对不上（不是这个 App 的作者密钥）');
  ls.set(K.owner, String(text).trim().match(/PDKEY1\.[A-Za-z0-9_-]+/)[0]);
  ls.set(K.act, code);
}
export function removeOwnerKey() { ls.del(K.owner); }

/** 作者给别人生成激活码：days = 0 表示永久 */
export async function makeCode(devInput, days, note = '') {
  const dev = normalizeDevice(devInput);
  if (!dev) throw new Error('设备码不对：应该是 8 位，比如 K7Q4-M2XD');
  const exp = days > 0 ? today() + days : 0;
  const code = await sign(await privateKey(), dev, exp);
  const log = issued();
  log.unshift({ dev, exp, id: codeId(code), note: String(note || '').slice(0, 40), at: Date.now() });
  ls.set(K.issued, JSON.stringify(log.slice(0, 50)));
  return { code, dev, exp, id: codeId(code) };
}
export function issued() { try { return JSON.parse(ls.get(K.issued) || '[]'); } catch { return []; } }

// ---------- 作者：随时停用 ----------
// 停用名单是网站上的 revoked.json。作者在 App 里点“停用 / 恢复”：
//   连了 GitHub（一个只能改这个仓库的令牌）→ App 直接改好 revoked.json，一两分钟后生效；
//   没连 → 给出新的 revoked.json 内容，作者自己换掉文件、推送。

/** 网站在哪个 GitHub 仓库：xxx.github.io/仓库名 → xxx/仓库名（设置里可以改） */
export function githubConf() {
  const c = readJSON(K.gh, {}) || {};
  let repo = c.repo || '';
  if (!repo) {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (m) repo = seg && !seg.includes('.') ? `${m[1]}/${seg}` : `${m[1]}/${m[1]}.github.io`;
  }
  return { token: c.token || '', repo };
}
export function setGithubConf({ token = '', repo = '' }) { ls.set(K.gh, JSON.stringify({ token: token.trim(), repo: repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '') })); }
export const githubEditUrl = () => `https://github.com/${githubConf().repo}/edit/main/revoked.json`;

async function gh(path, opt = {}) {
  const { token, repo } = githubConf();
  return fetch(`https://api.github.com/repos/${repo}/${path}`, {
    ...opt, cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
  });
}

/** 试一下令牌能不能读这个仓库 */
export async function testGithub() {
  const { token, repo } = githubConf();
  if (!token || !repo) throw new Error('先填令牌和仓库');
  const r = await gh('');
  if (r.status === 401) throw new Error('令牌不对（或者过期了）');
  if (r.status === 404) throw new Error(`找不到仓库 ${repo}（名字不对，或者令牌没勾这个仓库）`);
  if (!r.ok) throw new Error(`GitHub 返回 ${r.status}，稍后再试`);
  return true;
}

/** 作者这边看到的停用名单：连了 GitHub 就读仓库里的，否则读网站上的（自己改了还没推上去的优先） */
export async function ownerLoadList() {
  const { token, repo } = githubConf();
  if (token && repo) {
    try {
      const r = await gh('contents/revoked.json');
      if (r.status === 404) return { list: { devices: [], codes: [] }, sha: null, src: 'github' };
      if (r.ok) { const j = await r.json(); return { list: cleanList(JSON.parse(atob(j.content.replace(/\s/g, '')))), sha: j.sha, src: 'github' }; }
    } catch { /* 没网：往下用网站上的 */ }
  }
  const own = readJSON(K.ownerList, null);
  const site = await refreshRevoked();
  const same = (a, b) => a && b && JSON.stringify([...a.devices].sort()) === JSON.stringify([...b.devices].sort()) && JSON.stringify([...a.codes].sort()) === JSON.stringify([...b.codes].sort());
  if (own?.pending && !same(cleanList(own), site)) return { list: cleanList(own), src: 'local', pending: true };
  return { list: site || cleanList(readJSON(K.revoked, {})), src: 'site' };
}

/** 停用（on=true）/ 恢复一个设备码或一个激活码。返回 { pushed, json } */
export async function ownerSetRevoked({ dev = null, id = null }, on) {
  const cur = await ownerLoadList();
  const list = { devices: [...cur.list.devices], codes: [...cur.list.codes] };
  const upd = (arr, v) => { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); };
  if (dev) upd(list.devices, normalizeDevice(dev) || dev);
  if (id) upd(list.codes, id);
  const json = JSON.stringify({ v: 1, updated: new Date().toISOString(), devices: list.devices, codes: list.codes }, null, 1) + '\n';
  const { token, repo } = githubConf();
  if (token && repo) {
    const r = await gh('contents/revoked.json', {
      method: 'PUT',
      body: JSON.stringify({ message: `${on ? '停用' : '恢复'}试用：${dev || id}`, content: btoa(json), ...(cur.sha ? { sha: cur.sha } : {}) }),
    });
    if (!r.ok) {
      throw new Error(`GitHub 上没改成：${r.status === 401 ? '令牌不对或过期了' : r.status === 403 ? '令牌没有写权限（Contents 要选 Read and write）' : r.status === 404 ? '找不到仓库，检查仓库名' : r.status === 409 || r.status === 422 ? '刚好有别的改动，再点一次' : `GitHub 返回 ${r.status}`}`);
    }
    ls.set(K.ownerList, JSON.stringify({ ...list, at: Date.now(), pending: false }));
    return { pushed: true, json, list };
  }
  ls.set(K.ownerList, JSON.stringify({ ...list, at: Date.now(), pending: true }));
  return { pushed: false, json, list };
}

/** 到期说明：“永久” / “到 2026-10-29（还剩 29 天）” / “已到期” */
export function expText(exp) {
  if (!exp) return '永久';
  const left = exp - today();
  return left < 0 ? `已到期（${dayText(exp)}）` : `到 ${dayText(exp)}（还剩 ${left} 天）`;
}

// ---------- 激活页面 ----------

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/** 设备码 + 粘贴激活码的表单；激活成功调 onOk(结果) */
function activationForm(onOk) {
  const dev = deviceId();
  const input = h('textarea.input.gate-code', { rows: 3, placeholder: '把作者发来的激活码粘贴到这里（PD1 开头）', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const msg = h('div.small.gate-msg');
  const go = h('button.btn.primary.block.gate-go', {
    onclick: async () => {
      go.disabled = true; msg.className = 'small gate-msg'; msg.textContent = '正在验证…';
      await refreshRevoked();
      const r = await verify(input.value);
      go.disabled = false;
      if (r.ok && isRevoked(dev, codeId(input.value))) {
        msg.className = 'small gate-msg bad';
        msg.textContent = isRevoked(dev, null) ? '这台设备已经被作者停用了，要继续用请找作者' : '这个激活码已经被作者停用了，找作者要一个新的';
        return;
      }
      if (r.ok) { ls.set(K.act, String(input.value).replace(/\s+/g, '')); msg.textContent = ''; toast(r.exp ? `激活成功，可以用到 ${dayText(r.exp)}` : '激活成功', 'ok'); onOk(r); return; }
      msg.className = 'small gate-msg bad';
      msg.textContent = r.bad === 'format' ? '激活码不完整：要把 PD1 开头的一整串都粘贴进来'
        : r.bad === 'device' ? `这个激活码不是给这台设备的（这台设备的设备码是 ${dev}）`
          : `这个激活码已经到期了（${dayText(r.exp)}），找作者要一个新的`;
    },
  }, '激活');
  const codeBox = h('div.gate-dev',
    h('div.small.muted', '这台设备的设备码'),
    h('div.gate-id', dev),
    h('button.btn.sm.soft', { onclick: () => copyText(dev) }, '复制设备码'));
  const form = h('div.gate-form',
    h('p.small', h('b', '1. '), '把上面的设备码发给作者'),
    h('p.small', h('b', '2. '), '把作者发回来的激活码粘贴到下面，点“激活”'),
    input, msg, go);
  return { codeBox, form };
}

/** 没激活时整个 App 换成这一页；激活成功调 onUnlock()。title：iPad 看板传“拼豆看板” */
export function renderGate(st, onUnlock, { title = '拼豆计数器', what = '这个 App' } = {}) {
  document.body.classList.add('gated');
  document.getElementById('title').textContent = title;
  const view = clear(document.getElementById('view'));
  view.className = 'gate';
  const unlock = () => { document.body.classList.remove('gated'); view.className = ''; onUnlock(); };
  const { codeBox, form } = activationForm(unlock);
  const needHome = isIOS() && !standalone();
  const main = h('div.card.gate-card',
    h('div.gate-ico', '🧩'),
    h('p', h('b', `${what}还在试用，需要作者给的激活码`), h('br'), h('span.small.muted', '激活码只能在这一台设备上用，转给别人没有用。')),
    codeBox, form);
  if (needHome) {
    // iPhone 上 Safari 里和主屏幕上是两份独立的数据：在 Safari 里激活了，到主屏幕上还得再激活一次
    codeBox.hidden = true; form.hidden = true;
    main.append(h('div.gate-home',
      h('p', h('b', '先把它添加到主屏幕')),
      h('ol.small',
        h('li', '点 Safari 的分享按钮'),
        h('li', '选“添加到主屏幕”'),
        h('li', '从主屏幕上的图标打开，再激活')),
      h('p.tiny.muted', 'Safari 里和主屏幕上是两份独立的数据，在 Safari 里激活的，到主屏幕上不算。'),
      h('button.btn.sm.ghost', { onclick: e => { e.currentTarget.parentNode.remove(); codeBox.hidden = false; form.hidden = false; } }, '我就在浏览器里用')));
  }
  view.append(main,
    h('p.center', h('button.btn.sm.ghost.gate-owner', { onclick: () => ownerImport(unlock) }, '我是作者（导入密钥）')));
}

/** 只能查看时，每一页最上面的横幅（点了可以输入新的激活码） */
export function readOnlyBanner(st, onUnlock) {
  return h('div.ro-banner', { onclick: () => unlockSheet(st, onUnlock) },
    h('span.ro-ico', '🔒'),
    h('div.grow', h('b', st.revoked ? '已停用 · 只能查看' : '试用到期 · 只能查看'), h('div.tiny', '点这里输入新的激活码')));
}

/** 只能查看时：说明 + 输入新的激活码 */
export function unlockSheet(st, onUnlock) {
  let s = null;
  const { codeBox, form } = activationForm(() => { s.close(); onUnlock(); });
  s = sheet([
    h('p.small', readOnlyText(st)),
    h('p.small.muted', '你的图纸、拼豆板、库存都还在，可以查看，也可以在 设置 → 数据与备份 里导出备份。找作者要一个新的激活码，粘贴到下面就恢复。'),
    codeBox, form,
  ], { title: st.revoked ? '已停用' : '试用已到期', tall: true });
}

/** 只能查看时点了要改东西的按钮：提示一下 */
export function readOnlyToast(st) { toast(readOnlyText(st), 'error'); }

/** “我是作者”：粘贴作者密钥导入（激活页面、设置 → 关于 都能进） */
export function ownerImport(done) {
  const ta = h('textarea.input', { rows: 3, placeholder: 'PDKEY1.…', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const msg = h('div.small.gate-msg');
  const s = sheet([
    h('p.small.muted', '把“拼豆激活密钥.txt”里 PDKEY1. 开头的那一整行粘贴进来。密钥只存在这台设备上；以后在 设置 → 试用激活码 里给朋友生成激活码、随时停用。'),
    ta, msg,
    h('button.btn.primary.block', {
      style: { marginTop: '10px' },
      onclick: async () => {
        try { await importOwnerKey(ta.value); s.close(); toast('密钥已导入，这台手机永久激活', 'ok'); done(); } catch (e) { msg.className = 'small gate-msg bad'; msg.textContent = e.message; }
      },
    }, '导入'),
  ], { title: '我是作者' });
}
