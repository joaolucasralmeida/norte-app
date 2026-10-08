/**
 * Boot, roteamento e re-render.
 *
 * Sem framework de propósito: zero build, zero npm, zero dependência que
 * quebra em dois anos. Para publicar, basta copiar esta pasta. Para editar,
 * basta um editor de texto — nada precisa estar instalado no seu PC.
 */

import { load, subscribe, state } from './store.js';
import { el, clear, initSheet, toast } from './ui.js';
import { renderDashboard } from './screens/dashboard.js';
import { renderFinance } from './screens/finance.js';
import { renderGoals } from './screens/goals.js';
import { renderJournal } from './screens/journal.js';
import { renderCalendar } from './screens/calendar.js';
import { renderSettings } from './screens/settings.js';
import { openChat } from './screens/chat.js';

const ROUTES = {
  inicio: { title: 'Início', render: renderDashboard, tab: true },
  financeiro: { title: 'Financeiro', render: renderFinance, tab: true },
  metas: { title: 'Metas', render: renderGoals, tab: true },
  diario: { title: 'Diário', render: renderJournal, tab: true },
  calendario: { title: 'Calendário', render: renderCalendar, tab: true },
  configuracoes: { title: 'Configurações', render: renderSettings, tab: false },
};

const DEFAULT_ROUTE = 'inicio';

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  return ROUTES[hash] ? hash : DEFAULT_ROUTE;
}

export function navigate(route) {
  location.hash = `#/${route}`;
}

function render() {
  const name = currentRoute();
  const route = ROUTES[name];
  const screen = document.getElementById('screen');

  document.getElementById('screen-title').textContent = route.title;

  // Preserva a posição de rolagem ao re-renderizar a mesma tela: sem isso,
  // marcar uma parcela como paga joga a lista de volta para o topo.
  const previousScroll = screen.dataset.route === name ? screen.scrollTop : 0;

  clear(screen).append(route.render());
  screen.dataset.route = name;
  screen.scrollTop = previousScroll;

  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.route === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
}

function wireChrome() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => navigate(tab.dataset.route));
  }
  document.getElementById('btn-chat').addEventListener('click', () => openChat());
  document.getElementById('btn-settings').addEventListener('click', () => navigate('configuracoes'));

  window.addEventListener('hashchange', render);
  // Telas pedem re-render por evento para não dependerem umas das outras.
  window.addEventListener('norte:rerender', render);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // `file://` não aceita service worker: é preciso servir por http(s).
  if (location.protocol === 'file:') return;

  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (error) {
    console.warn('Service worker não registrado:', error.message);
  }
}

/**
 * Convite para instalar na tela de início.
 *
 * No iOS não existe prompt programático: o usuário precisa usar Compartilhar
 * › Adicionar à Tela de Início. Mostramos a dica só quando o app está num
 * navegador comum, e só uma vez.
 */
function maybeSuggestInstall() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (standalone || localStorage.getItem('norte.installHintSeen')) return;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!isIOS) return;

  setTimeout(() => {
    toast('Dica: toque em Compartilhar › Adicionar à Tela de Início para usar como app.');
    localStorage.setItem('norte.installHintSeen', '1');
  }, 1500);
}

async function boot() {
  initSheet();
  wireChrome();

  try {
    await load();
  } catch (error) {
    document.getElementById('screen').append(
      el('div', { class: 'empty' }, [
        el('h3', {}, 'Não consegui abrir seus dados'),
        el('p', {}, error.message),
        el('p', { class: 'caption' },
          'Se você estiver em uma aba privada do Safari, o armazenamento fica bloqueado. Tente em uma aba normal.'),
      ]),
    );
    return;
  }

  subscribe(() => render());
  render();

  registerServiceWorker();
  maybeSuggestInstall();
}

boot();
