// 显示二维码（可以几张轮流显示）、用摄像头扫二维码。iPhone 和 iPad 都用。
// 生成：vendor/qr/qrcode.mjs；扫：vendor/zxing（ZXing-C++ 的 WebAssembly，第一次扫码时才下载，约 0.9 MB）。
import { h } from './ui.js';
import qrcode from '../vendor/qr/qrcode.mjs';
import { collector, bytesToBinaryString } from './transfer.js';

/** 一串字节画成二维码（纠错 M 级，四周留 4 格白边，每格整数个像素，放大也清楚） */
export function qrCanvas(bytes, px = 900) {
  const qr = qrcode(0, 'M');
  qr.addData(bytesToBinaryString(bytes), 'Byte');
  qr.make();
  const n = qr.getModuleCount(), quiet = 4, total = n + quiet * 2;
  const k = Math.max(2, Math.floor(px / total));
  const cv = h('canvas.qr-canvas');
  cv.width = cv.height = total * k;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * k, (r + quiet) * k, k, k);
  cv.dataset.modules = String(n);
  return cv;
}

/**
 * 显示几张二维码：只有一张就一直显示；几张就轮流显示（扫的一方会自动收齐）。
 * 返回 { el, stop }；元素从页面上拿掉后自动停。
 */
export function qrShow(frames, { interval = 450 } = {}) {
  const canvases = frames.map(f => qrCanvas(f));
  const box = h('div.qr-show');
  const pic = h('div.qr-pic', canvases[0]);
  const dots = frames.length > 1 ? h('div.qr-dots', frames.map((_, i) => h('i' + (i ? '' : '.on')))) : null;
  box.append(pic, dots || '');
  let i = 0, timer = null, shown = false;
  if (frames.length > 1) {
    timer = setInterval(() => {
      if (box.isConnected) shown = true;
      else if (shown) { stop(); return; }
      i = (i + 1) % frames.length;
      pic.replaceChildren(canvases[i]);
      [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
    }, interval);
  }
  function stop() { clearInterval(timer); timer = null; }
  box.dataset.frames = String(frames.length);
  return { el: box, stop };
}

/** 显示二维码时不让屏幕自动变暗锁屏（支持的系统才有用） */
export async function keepAwake() {
  try { const lock = await navigator.wakeLock?.request('screen'); return () => lock?.release().catch(() => {}); } catch { return () => {}; }
}

// ---------- 扫码 ----------

let zxing = null;
/** 载入扫码引擎（第一次要下载约 0.9 MB，之后留在本机） */
export function loadScanner() {
  if (!zxing) {
    zxing = import('../vendor/zxing/zxing-reader.mjs').then(async m => {
      m.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('../vendor/zxing/zxing_reader.wasm', import.meta.url).href : prefix + path) },
      });
      return m;
    }).catch(e => { zxing = null; throw e; });
  }
  return zxing;
}

const CAM_KEY = 'pindou-cam';
const camPref = () => { try { return localStorage.getItem(CAM_KEY) === 'user' ? 'user' : 'environment'; } catch { return 'environment'; } };
const setCamPref = v => { try { localStorage.setItem(CAM_KEY, v); } catch { /* 无所谓 */ } };

/**
 * 全屏扫码：对准另一台设备上的二维码，几张轮流显示的会自动收齐。
 * kind：要扫的种类（transfer.js 的 KIND）；wrongKind(k)：扫到别的种类时显示的提示
 * 返回完整内容（Uint8Array），取消了返回 null。
 */
export function scanQR({ kind, title = '扫二维码', hint = '', wrongKind = () => '这个二维码不是这里要扫的' } = {}) {
  return new Promise(resolve => {
    const video = h('video.qs-video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true; video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
    const status = h('div.qs-status', '正在打开摄像头…');
    const prog = h('div.qs-prog');
    const flipBtn = h('button.btn.qs-flip', { onclick: () => { facing = facing === 'user' ? 'environment' : 'user'; setCamPref(facing); start(); } }, '🔄 换摄像头');
    const cancelBtn = h('button.btn.qs-cancel', { onclick: () => finish(null) }, '取消');
    const el = h('div.qrscan',
      video,
      h('div.qs-box'),
      h('div.qs-top', h('b', title), hint ? h('div.small', hint) : null),
      h('div.qs-bottom', status, prog, h('div.row.gap.center', flipBtn, cancelBtn)));
    document.body.append(el);
    document.body.classList.add('noscroll');

    let facing = camPref(), stream = null, done = false, busy = false, raf = 0, lastWarn = 0;
    const col = collector(kind);
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d', { willReadFrequently: true });

    const stopStream = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; };
    function finish(v) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      stopStream();
      document.removeEventListener('visibilitychange', onVis);
      el.classList.add('closing');
      setTimeout(() => { el.remove(); document.body.classList.remove('noscroll'); }, v ? 450 : 0);
      resolve(v);
    }
    // 切到后台时 iPhone/iPad 会把摄像头关掉：直接退出，回来再点一次扫码
    const onVis = () => { if (document.hidden) finish(null); };
    document.addEventListener('visibilitychange', onVis);

    async function start() {
      stopStream();
      video.classList.toggle('mirror', facing === 'user');
      if (!navigator.mediaDevices?.getUserMedia) { status.textContent = '这个浏览器不能用摄像头（要用 Safari 打开，网址是 https 开头）'; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      } catch (e) {
        status.textContent = e?.name === 'NotAllowedError'
          ? '没有摄像头权限：弹出询问时点“允许”；如果之前点了不允许，到 设置 → Safari → 相机 里改成“允许”（主屏幕上的 App 关掉重新打开会再问一次）'
          : '打不开摄像头：' + (e?.message || e?.name || e);
        return;
      }
      if (done) { stopStream(); return; }
      video.srcObject = stream;
      try { await video.play(); } catch { /* 静音视频一般能自动播放 */ }
      status.textContent = '对准二维码（放进框里，离近一点）';
      loop();
    }

    let engine = null;
    loadScanner().then(m => { engine = m; }).catch(() => { status.textContent = '扫码引擎下载失败：第一次扫码要联网'; });

    function loop() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }
    async function tick() {
      if (done) return;
      if (!busy && engine && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try { await decodeFrame(); } catch { /* 这一帧没读出来 */ }
        busy = false;
      }
      if (!done) raf = requestAnimationFrame(tick);
    }
    async function decodeFrame() {
      // 取画面中间的正方形（二维码一般对在中间），太大就缩到 1080 以内
      const vw = video.videoWidth, vh = video.videoHeight, side = Math.min(vw, vh);
      const S = Math.min(1080, side);
      if (cv.width !== S) { cv.width = S; cv.height = S; }
      g.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, S, S);
      const img = g.getImageData(0, 0, S, S);
      const res = await engine.readBarcodes(img, { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 });
      const r = res.find(x => x.isValid && x.bytes?.length);
      if (!r || done) return;
      const out = col.add(r.bytes);
      if (out.err) {
        if (Date.now() - lastWarn > 1500) { lastWarn = Date.now(); status.textContent = out.err === 'kind' ? wrongKind(out.kind) : '这不是拼豆计数器的二维码'; }
        return;
      }
      if (out.total > 1) {
        prog.replaceChildren(...Array.from({ length: out.total }, (_, i) => h('i' + (col.got > i ? '.on' : ''))));
        status.textContent = out.payload ? '收齐了 ✓' : `已收到 ${out.got}/${out.total} 张，继续对准（会自动轮换）`;
      }
      if (out.payload) { status.textContent = '收到了 ✓'; el.classList.add('ok'); finish(out.payload); }
    }
    start();
  });
}
