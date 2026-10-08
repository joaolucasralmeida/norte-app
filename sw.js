/**
 * Service worker: faz o app abrir sem internet.
 *
 * Duas estratégias, por um motivo concreto:
 *
 * · **Rede primeiro** para o HTML e o manifest. Foi aqui que doeu: com cache
 *   primeiro, uma versão antiga do `index.html` continuava sendo servida
 *   depois de publicar uma correção — e o iOS lia dela os links de ícone
 *   velhos ao adicionar o app à tela de início. Agora a página sempre tenta
 *   a rede antes, e só cai no cache quando está offline.
 *
 * · **Cache primeiro** para CSS, JS e imagens, que têm nome versionado e não
 *   mudam sem trocar de URL. É o que faz o app abrir instantâneo.
 *
 * Os **dados** do usuário não passam por aqui: eles vivem no IndexedDB.
 */

// Incremente a cada publicação: é o que descarta o cache antigo nos
// aparelhos que já instalaram o app.
const VERSION = 'norte-v10';

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
  './js/google-calendar.js',
  './js/screens/dashboard.js',
  './js/screens/finance.js',
  './js/screens/goals.js',
  './js/screens/journal.js',
  './js/screens/calendar.js',
  './js/screens/settings.js',
  './js/screens/chat.js',
  './favicon.ico',
  './icons/norte-32-v3.png',
  './icons/norte-120-v3.png',
  './icons/norte-152-v3.png',
  './icons/norte-167-v3.png',
  './icons/norte-180-v3.png',
  './icons/norte-192-v3.png',
  './icons/norte-512-v3.png',
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

/** HTML e manifest: a versão publicada vale mais que a guardada. */
function isDocument(request, url) {
  return request.mode === 'navigate'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('.webmanifest');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Só servimos do cache o que é nosso e da mesma origem.
  if (url.origin !== location.origin) return;

  if (isDocument(request, url)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(event, request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(VERSION);
      await cache.put(request, copy);
    }
    return response;
  } catch {
    // Offline: devolve o que tiver guardado.
    return (await caches.match(request)) ?? (await caches.match('./index.html'));
  }
}

async function cacheFirst(event, request) {
  const cached = await caches.match(request);
  if (cached) {
    // Atualiza em segundo plano para a próxima abertura já ter o novo.
    event.waitUntil(refresh(request));
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(VERSION).then((cache) => cache.put(request, copy)));
    }
    return response;
  } catch {
    return caches.match('./index.html');
  }
}

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
