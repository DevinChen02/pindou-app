// 试用激活：别人想用这个 App，要找作者要一个“激活码”。激活码和那台设备绑定（每台设备有自己的“设备码”），
// 所以对方把网址或激活码转给别人都没用——别人打开只会看到自己的设备码，还得再找作者要。
//
// 激活码 = 作者用私钥对“设备码 + 到期日”做的签名（ECDSA P-256）；App 里只有公钥，只能验证、造不出来。
// 私钥不在代码里、不在仓库里，只在作者手机上（激活页面最下面“我是作者”导入一次），在 设置 → 关于 里给别人生成激活码。
// 不需要服务器：全在手机上算，没网也能验证。
// 挡得住普通转发；挡不住会改代码的人（网页代码本来就能下载）——够给朋友试用。iPad 看板不用激活（它自己什么也做不了）。
import { h, clear, toast, sheet, copyText } from './ui.js';

const PUBLIC_KEY = { kty: 'EC', crv: 'P-256', x: 'OiJp3NLRZJOg200fQco_cImfeHzynanMah8_NNdyKsY', y: 'SxH_oZyokT7O_xt_3wvqZwARu57DJ2Oeetj_PU5If-8' };
const K = { device: 'pindou-device', act: 'pindou-activation', owner: 'pindou-owner-key', issued: 'pindou-issued', force: 'pindou-license-test' };
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

/** 现在能不能用：{ ok, exp, owner, dev, expired, none } */
export async function status() {
  if (!crypto?.subtle) return { ok: true, insecure: true }; // 不是 https（本地调试）没有加密接口：不拦
  if (devHost()) return { ok: true, dev: true, owner: hasOwnerKey() };
  const code = ls.get(K.act);
  if (!code) return { ok: false, none: true };
  const r = await verify(code);
  return { ...r, owner: hasOwnerKey() };
}

async function activate(code) {
  const r = await verify(code);
  if (r.ok) ls.set(K.act, String(code).replace(/\s+/g, ''));
  return r;
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
  log.unshift({ dev, exp, note: String(note || '').slice(0, 40), at: Date.now() });
  ls.set(K.issued, JSON.stringify(log.slice(0, 30)));
  return { code, dev, exp };
}
export function issued() { try { return JSON.parse(ls.get(K.issued) || '[]'); } catch { return []; } }

/** 到期说明：“永久” / “到 2026-10-29（还剩 29 天）” / “已到期” */
export function expText(exp) {
  if (!exp) return '永久';
  const left = exp - today();
  return left < 0 ? `已到期（${dayText(exp)}）` : `到 ${dayText(exp)}（还剩 ${left} 天）`;
}

// ---------- 激活页面 ----------

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/** 没激活（或到期）时整个 App 换成这一页；激活成功调 onUnlock() */
export function renderGate(st, onUnlock) {
  document.body.classList.add('gated');
  document.getElementById('title').textContent = '拼豆计数器';
  const view = clear(document.getElementById('view'));
  view.className = 'gate';
  const dev = deviceId();
  const input = h('textarea.input.gate-code', { rows: 3, placeholder: '把作者发来的激活码粘贴到这里（PD1 开头）', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const msg = h('div.small.gate-msg');
  const go = h('button.btn.primary.block.gate-go', {
    onclick: async () => {
      go.disabled = true; msg.className = 'small gate-msg'; msg.textContent = '正在验证…';
      const r = await activate(input.value);
      go.disabled = false;
      if (r.ok) { msg.textContent = ''; toast(r.exp ? `激活成功，可以用到 ${dayText(r.exp)}` : '激活成功', 'ok'); unlock(); return; }
      msg.className = 'small gate-msg bad';
      msg.textContent = r.bad === 'format' ? '激活码不完整：要把 PD1 开头的一整串都粘贴进来'
        : r.bad === 'device' ? `这个激活码不是给这台设备的（这台设备的设备码是 ${dev}）`
          : `这个激活码已经到期了（${dayText(r.exp)}），找作者要一个新的`;
    },
  }, '激活');
  const unlock = () => { document.body.classList.remove('gated'); view.className = ''; onUnlock(); };
  const needHome = isIOS() && !standalone();
  const codeBox = h('div.gate-dev',
    h('div.small.muted', '这台设备的设备码'),
    h('div.gate-id', dev),
    h('button.btn.sm.soft', { onclick: () => copyText(dev) }, '复制设备码'));
  const form = h('div.gate-form',
    h('p.small', h('b', '1. '), '把上面的设备码发给作者'),
    h('p.small', h('b', '2. '), '把作者发回来的激活码粘贴到下面，点“激活”'),
    input, msg, go);
  const main = h('div.card.gate-card',
    h('div.gate-ico', '🧩'),
    st.expired
      ? h('p', h('b', '试用已经到期了'), h('br'), h('span.small.muted', `（到 ${dayText(st.exp)}）找作者要一个新的激活码；你的库存和图纸都还在这台设备上。`))
      : h('p', h('b', '这个 App 还在试用，需要作者给的激活码'), h('br'), h('span.small.muted', '激活码只能在这一台设备上用，转给别人没有用。')),
    codeBox, form);
  if (needHome) {
    // iPhone 上 Safari 里和主屏幕上是两份独立的数据：在 Safari 里激活了，到主屏幕上还得再激活一次
    codeBox.hidden = true; form.hidden = true;
    main.append(h('div.gate-home',
      h('p', h('b', '先把它添加到主屏幕')),
      h('ol.small',
        h('li', '点 Safari 下面的分享按钮'),
        h('li', '选“添加到主屏幕”'),
        h('li', '从主屏幕上的图标打开，再激活')),
      h('p.tiny.muted', 'Safari 里和主屏幕上是两份独立的数据，在 Safari 里激活的，到主屏幕上不算。'),
      h('button.btn.sm.ghost', { onclick: e => { e.currentTarget.parentNode.remove(); codeBox.hidden = false; form.hidden = false; } }, '我就在浏览器里用')));
  }
  view.append(main,
    h('p.center', h('button.btn.sm.ghost.gate-owner', { onclick: () => ownerImport(unlock) }, '我是作者（导入密钥）')));
}

/** “我是作者”：粘贴作者密钥导入（激活页面、设置 → 关于 都能进） */
export function ownerImport(done) {
  const ta = h('textarea.input', { rows: 3, placeholder: 'PDKEY1.…', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const msg = h('div.small.gate-msg');
  const s = sheet([
    h('p.small.muted', '把“拼豆激活密钥.txt”里 PDKEY1. 开头的那一整行粘贴进来。密钥只存在这台手机上；以后在 设置 → 关于 → 试用激活码 里给朋友生成激活码。'),
    ta, msg,
    h('button.btn.primary.block', {
      style: { marginTop: '10px' },
      onclick: async () => {
        try { await importOwnerKey(ta.value); s.close(); toast('密钥已导入，这台手机永久激活', 'ok'); done(); } catch (e) { msg.className = 'small gate-msg bad'; msg.textContent = e.message; }
      },
    }, '导入'),
  ], { title: '我是作者' });
}
