// Uygulama dosyalarını telefona kaydeder, internet olmadan da açılsın diye.
// Portföy verilerine dokunmaz; onlar yalnızca telefonun hafızasında durur.
var CACHE = 'dengeleyici-v1';
var FILES = ['./', 'index.html', 'app.js', 'calc.js', 'manifest.json', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

// Yalnızca uygulamanın kendi dosyaları: önce internet, olmazsa kayıtlı kopya.
// Fiyat istekleri (başka site) hiç önbelleğe alınmaz.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
    })
  );
});
