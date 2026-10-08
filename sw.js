/**
 * Service worker: faz o app abrir sem internet.
 *
 * Estratégia deliberadamente simples:
 * · os arquivos do app (HTML, CSS, JS, ícones) vêm do cache primeiro —
 *   é o que faz o ícone da tela de início abrir instantâneo e offline;
 * · qualquer outra coisa (as chamadas ao assistente) vai direto para a rede e
 *   nunca é cacheada.
 *
 * Os **dados** do usuário não passam por aqui: eles vivem no IndexedDB.
 */

// Incremente a cada publicação: é o que descarta o cache antigo nos
// aparelhos que já instalaram o app.
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
      // `addAll` falha inteiro se um arquivo faltar; individual é mais
      // tolerante e evita um app que não instala por causa de um ícone.
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
  // Só servimos do cache o que é nosso e da mesma origem.
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Atualiza em segundo plano para a próxima abertura já ter o novo.
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
    // Offline: o cache já respondeu, não há nada a fazer.
  }
}
