// Keeps the planner usable with no connection. Pages and code go to the network first, so a deploy
// shows straight away, and fall back to the last copy. Icons never change, so they come from the
// cache first. All paths are relative to this file: it works under a sub-path too.

const CACHE = 'irplanner-site-v1';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/rules.js', 'js/storage.js', 'js/theme.js',
  'js/serverrules.js', 'js/sourcestore.js', 'js/abilityscale.js', 'js/abilitytext.js', 'js/data/gamedata.js',
];
const NETWORK_WAIT_MS = 5000; // a dead connection can hang: give up and use the copy

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('irplanner-site-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const controller = new AbortController();
  const timer = cached ? setTimeout(() => controller.abort(), NETWORK_WAIT_MS) : null;
  try {
    const response = await fetch(request.url, { cache: 'no-cache', signal: controller.signal });
    if (response.ok) await cache.put(new URL(request.url).pathname === new URL('./', self.location).pathname ? './' : request.url.split('?')[0], response.clone());
    return response;
  } catch (e) {
    if (cached) return cached;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const scope = new URL('./', self.location).pathname;
  const path = url.pathname.slice(scope.length);
  if (path.startsWith('tests/')) return;
  event.respondWith(path.startsWith('img/') ? cacheFirst(event.request) : networkFirst(event.request));
});
