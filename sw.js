// Service Worker：把应用文件缓存到手机上，没网也能打开（云端大模型识别仍需联网）。
// 每次发布新版本时把 VERSION 改一下（和 js/version.js 的 APP_VERSION 一致），手机打开 App 时会自动换成新版本。
const VERSION = 'pindou-v2.10.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/version.js',
  './js/license.js',
  './js/db.js',
  './js/store.js',
  './js/palette.js',
  './js/image.js',
  './js/ui.js',
  './js/viewer.js',
  './js/panzoom.js',
  './js/board.js',
  './js/cells.js',
  './js/cropper.js',
  './js/ocrcells.js',
  './js/stitch.js',
  './js/merge.js',
  './js/boardview.js',
  './js/transfer.js',
  './js/qr.js',
  './js/views/ipad-send.js',
  './js/ipad.js',
  './ipad.html',
  './ipad.webmanifest',
  './vendor/qr/qrcode.mjs',
  './js/views/boardsetup.js',
  './js/boardasync.js',
  './js/boardworker.js',
  './js/extract/index.js',
  './js/extract/vlm.js',
  './js/extract/ocr.js',
  './js/extract/ocr-core.js',
  './js/extract/text.js',
  './js/extract/ppocr.js',
  './js/views/recognize.js',
  './js/views/verify.js',
  './js/views/overview.js',
  './js/views/preview.js',
  './js/views/inventory.js',
  './js/views/patterns.js',
  './js/views/build.js',
  './js/views/settings.js',
  './js/views/palette.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// 装新版本：绕过浏览器的 HTTP 缓存直接从网站拿（GitHub Pages 让浏览器把文件缓存 10 分钟，
// 不绕过的话新版本的缓存里装的可能还是旧文件，手机就一直是旧版本）
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

// 识别引擎和模型（几 MB 到十几 MB）、扫码引擎单独放一个缓存：第一次用到时下载，之后一直用缓存，
// 发新版本也不会重新下载（文件名里的版本号变了才会换）
const MODEL_CACHE = 'pindou-models-v1';
const isModel = url => /\/vendor\/(ppocr|ort|tesseract|zxing)\//.test(url.pathname); // zxing：扫二维码（约 1 MB）

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== MODEL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // API 请求不经过缓存
  if (url.pathname.endsWith('/revoked.json')) return; // 停用名单：每次都去网站拿最新的（见 license.js）
  if (isModel(url)) {
    e.respondWith(caches.open(MODEL_CACHE).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  // 应用文件：只用这个版本装好的那一份（同一个版本的文件是一起装的，不会新旧混着用）；
  // 缓存里没有的（没列在 SHELL 里）才去网站拿
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => null);
      if (res?.ok && res.type === 'basic') { cache.put(req, res.clone()); return res; }
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('./index.html');
      return new Response('离线状态下无法获取：' + url.pathname, { status: 503 });
    }),
  );
});
