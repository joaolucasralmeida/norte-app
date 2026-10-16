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
const VERSION = 'norte-v20';

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
  './js/chart.js',
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
  './js/screens/auth.js',
  './js/cloud/config.js',
  './js/cloud/client.js',
  './js/cloud/sync.js',
  './js/cloud/admin.js',
  // A biblioteca do Supabase fica no nosso domínio, e não num CDN, justamente
  // para caber neste cache: num CDN, o app não abriria sem rede.
  './vendor/supabase.js',
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
      //
      // `cache: 'reload'` não é detalhe: sem ele, `cache.add` aceita o que
      // estiver no cache HTTP do navegador, e o GitHub Pages serve os
      // arquivos com `max-age=600`. Publicar e abrir o app dentro desses
      // dez minutos gravava a versão ANTIGA dentro do cache da versão nova
      // — e ali ela ficaria até a publicação seguinte. Foi assim que o app
      // rodou com um `app.js` novo e um `auth.js` velho ao mesmo tempo, o
      // que num módulo ES quebra a importação inteira.
      .then((cache) => Promise.allSettled(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      ))
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

/**
 * Código também vai pela rede primeiro.
 *
 * O HTML já era buscado na rede, mas o JavaScript vinha do cache — e os dois
 * precisam combinar. Quando não combinavam, o app carregava um `app.js` novo
 * importando um `auth.js` velho: em módulos ES isso derruba a importação
 * inteira, e a tela volta para a versão anterior **sem erro no console**.
 *
 * Custou três rodadas de "corrigi, testei, deu o mesmo erro" até aparecer.
 * Imagem e ícone continuam vindo do cache: eles têm o número da versão no
 * nome, então nunca ficam fora de sincronia.
 */
function isCode(url) {
  return url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Só servimos do cache o que é nosso e da mesma origem.
  if (url.origin !== location.origin) return;

  if (isDocument(request, url) || isCode(url)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(event, request));
});

/** Rede lenta não pode virar tela branca: depois disso, usa o cache. */
const TIMEOUT_DE_REDE = 3000;

async function networkFirst(request) {
  try {
    // `AbortSignal.timeout` em vez de esperar indefinidamente: num celular
    // com sinal ruim, a rede não falha — ela demora. Sem o limite, o app
    // ficaria em branco esperando algo que já está guardado aqui.
    const response = await fetch(request, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(TIMEOUT_DE_REDE),
    });
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(VERSION);
      await cache.put(request, copy);
    }
    return response;
  } catch {
    const guardado = await caches.match(request);
    if (guardado) return guardado;

    // Só a navegação cai para a página inicial. Devolver HTML no lugar de um
    // `.js` que faltou criaria um erro de sintaxe incompreensível.
    return request.mode === 'navigate'
      ? (await caches.match('./index.html')) ?? Response.error()
      : Response.error();
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
