// オフラインでも画面を開けるようにするサービスワーカー
// 更新時は VERSION を変更してください
const VERSION = 'kakeibo-v3';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'db.js', 'config.js',
  'supabase.js', 'chart.umd.min.js', 'manifest.webmanifest',
  'icon-192.png', 'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// 自サイトのファイル：ネット優先（常に最新）、つながらない時はキャッシュ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
