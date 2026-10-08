/**
 * Service worker: faz o app abrir sem internet.
 *
 * EstratÃ©gia deliberadamente simples:
 * Â· os arquivos do app (HTML, CSS, JS, Ã­cones) vÃªm do cache primeiro â€”
 *   Ã© o que faz o Ã­cone da tela de inÃ­cio abrir instantÃ¢neo e offline;
 * Â· qualquer outra coisa (as chamadas ao assistente) vai direto para a rede e
 *   nunca Ã© cacheada.
 *
 * Os **dados** do usuÃ¡rio nÃ£o passam por aqui: eles vivem no IndexedDB.
 */

// Incremente a cada publicaÃ§Ã£o: Ã© o que descarta o cache antigo nos
// aparelhos que jÃ¡ instalaram o app.
const VERSION = 'norte-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/db.js',
  './js/store.js',
  './js/domain.js',
  './js/format.js',
  './js/ics.js',
  './js/backup.js',
  './js/screens/dashboard.js',
  './js/screens/finance.js',
  './js/screens/goals.js',
  './js/screens/journal.js',
  './js/screens/calendar.js',
  './js/screens/settings.js',
  './js/screens/chat.js',
  './favicon.ico',
  './icons/icon-32.png',
  './icons/icon-120.png',
  './icons/icon-152.png',
  './icons/icon-167.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // `addAll` falha inteiro se um arquivo faltar; individual Ã© mais
      // tolerante e evita um app que nÃ£o instala por causa de um Ã­cone.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // SÃ³ servimos do cache o que Ã© nosso e da mesma origem.
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Atualiza em segundo plano para a prÃ³xima abertura jÃ¡ ter o novo.
        event.waitUntil(refresh(request));
        return cached;
      }
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(VERSION).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    }),
  );
});

async function refresh(request) {
  try {
    const response = await fetch(request);
    if (!response.ok) return;
    const cache = await caches.open(VERSION);
    await cache.put(request, response);
  } catch {
    // Offline: o cache jÃ¡ respondeu, nÃ£o hÃ¡ nada a fazer.
  }
}
