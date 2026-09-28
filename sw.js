// Service Worker：把应用文件缓存到手机上，没网也能打开（云端大模型识别仍需联网）。
// 每次发布新版本时把 VERSION 改一下，手机会在下次打开时更新。
const VERSION = 'pindou-v2.4.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
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

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// 识别引擎和模型（几 MB 到十几 MB）单独放一个缓存：第一次用到时下载，之后一直用缓存，
// 发新版本也不会重新下载（文件名里的版本号变了才会换）
const MODEL_CACHE = 'pindou-models-v1';
const isModel = url => /\/vendor\/(ppocr|ort|tesseract)\//.test(url.pathname);

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
  // 应用文件：先用缓存，同时在后台更新；OCR 引擎等大文件第一次用到时缓存
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then(res => {
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('./index.html');
      return new Response('离线状态下无法获取：' + url.pathname, { status: 503 });
    }),
  );
});
