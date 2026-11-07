// アプリの画面をスマホ内に保存し、通信なしで一瞬で開けるようにするサービスワーカー
// 更新時は VERSION を変更してください（変更すると、次回起動時に新しい版へ切り替わります）
const VERSION = 'kakeibo-v13';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'db.js', 'backup.js',
  'chart.umd.min.js', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 保存済みの画面をすぐ返し、裏で最新版を取りに行く
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; });
    if (cached) {
      e.waitUntil(network.catch(() => {}));
      return cached;
    }
    return network;
  }));
});
