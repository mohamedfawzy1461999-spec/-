// كاش للقشرة الأساسية فقط. أي طلب /api بيروح للسيرفر دايماً (مفيش بيانات حضور في الكاش).
const CACHE = 'bim-shell-v2';
self.addEventListener('install', e => {
  // كل ملف بيتحط لوحده: لو ملف مش موجود التثبيت ما يفشلش
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(['/', '/manifest.json'].map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api') || u.pathname === '/healthz') return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
