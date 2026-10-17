/**
 * Assistente de IA.
 *
 * Conversa com o Worker em `gemini-worker/`, que faz o loop de ferramentas
 * com o Gemini. Aqui é só o cliente de SSE e a interface.
 *
 * Sem servidor configurado, a tela explica o que falta em vez de dar erro —
 * o app inteiro continua funcionando offline, este é o único pedaço que
 * depende de rede.
 *
 * Já houve um cartão de preço aqui, com mediana, faixa e lista de ofertas,
 * alimentado pela API pública do Mercado Livre. Ela foi fechada. O que o
 * assistente consegue devolver hoje é texto com fontes citadas — e é isso
 * que a tela mostra. Fingir a precisão do cartão antigo com dados que já não
 * existem seria pior do que mostrar menos.
 */

import { state, setSetting } from '../store.js';
import { ASSISTANT_URL } from '../cloud/config.js';
import { money, parseMoney, safeURL } from '../format.js';
import { el, card, openSheet, closeSheet, toast, field, input } from '../ui.js';
import { criarRolagem } from '../chat-scroll.js';
import { openGoalSheet } from './goals.js';
import { monthSummary, contributedCents, remainingCents } from '../domain.js';
import { contributionsOf } from '../store.js';
import { todayISO, monthKey } from '../format.js';

const messages = [];

/**
 * Qual elemento desenha cada mensagem.
 *
 * Existe para a conversa ser atualizada por partes. Antes, cada pedaço de
 * texto que chegava redesenhava a lista inteira — o que apagava a seleção
 * de texto do leitor, perdia a posição da rolagem e ficava mais lento a
 * cada mensagem acumulada.
 */
const nos = new Map();

let rolagem = null;
let ultimaAncora = null;

export function openChat() {
  const body = el('div', { class: 'chat' });
  const log = el('div', { class: 'chat-log' });
  const espacador = el('div', { class: 'chat-espacador', 'aria-hidden': 'true' });
  const viewport = el('div', {
    class: 'chat-viewport',
    role: 'log',
    'aria-label': 'Conversa com o assistente',
    'aria-relevant': 'additions',
    tabindex: '0',
  }, [log, espacador]);

  const irParaOFim = el('button', {
    class: 'chat-jump',
    hidden: true,
    onClick: () => rolagem.irParaOFim(),
  }, 'Resposta chegando ↓');

  const composer = buildComposer(log);

  body.append(barraDeFerramentas(log), el('div', { class: 'chat-area' }, [viewport, irParaOFim]), composer);

  nos.clear();
  rolagem = criarRolagem(viewport, espacador);
  rolagem.quandoMudar((temConteudoAbaixo) => { irParaOFim.hidden = !temConteudoAbaixo; });

  renderLog(log);
  openSheet({ title: 'Assistente', body, hideConfirm: true });

  // A folha abre com altura animada; medir antes disso daria um espaçador
  // calculado para uma tela que ainda não existe.
  requestAnimationFrame(() => rolagem.irParaOFim());
}

/**
 * Apagar a conversa, com confirmacao no proprio botao.
 *
 * Nao da para usar a folha de confirmacao do app: ela e a MESMA folha onde
 * o chat esta aberto, entao confirmar fechava o chat junto. Em vez de
 * empilhar modais, o botao arma e desarma sozinho.
 */
function barraDeFerramentas(log) {
  let armado = false;
  let desarmar = null;

  const limpar = el('button', { class: 'btn mini-btn danger' }, 'Apagar conversa');

  const voltarAoNormal = () => {
    armado = false;
    clearTimeout(desarmar);
    limpar.textContent = 'Apagar conversa';
    limpar.classList.remove('armado');
  };

  limpar.addEventListener('click', () => {
    if (messages.length === 0) return;

    if (!armado) {
      armado = true;
      limpar.textContent = 'Apagar mesmo?';
      limpar.classList.add('armado');
      // Desarma sozinho: um botao que fica armado para sempre vira uma
      // armadilha para o toque seguinte.
      desarmar = setTimeout(voltarAoNormal, 4000);
      return;
    }

    messages.length = 0;
    nos.clear();
    renderLog(log);
    rolagem.irParaOFim();
    voltarAoNormal();
    toast('Conversa apagada.');
  });

  return el('div', { class: 'chat-barra' }, [limpar]);
}

/**
 * O endereço vem do código. A configuração continua sendo lida, mas só como
 * exceção: quem quiser apontar para um servidor próprio ainda pode, gravando
 * `backendURL`. Ninguém precisa — e ninguém mais vê o campo.
 */
function backendURL() {
  const raw = (state.settings.backendURL ?? '').trim() || ASSISTANT_URL;
  return raw ? raw.replace(/\/+$/, '') : null;
}

function buildComposer(log) {
  const textInput = input({
    placeholder: 'Quero juntar para um iPhone 15, uns R$ 3.800',
    onKeyDown: (event) => { if (event.key === 'Enter') send(); },
  });

  const send = async () => {
    const text = textInput.value.trim();
    if (!text) return;
    textInput.value = '';
    await ask(text, log);
  };

  return el('div', { class: 'chat-composer' }, [
    textInput,
    el('button', { class: 'btn primary', onClick: send, 'aria-label': 'Enviar' }, '↑'),
  ]);
}

/** Desenho completo. Só na abertura e depois de apagar a conversa. */
function renderLog(log) {
  log.replaceChildren();
  nos.clear();
  ultimaAncora = null;

  if (messages.length === 0) {
    log.append(el('p', { class: 'caption center' },
      'Diga o que você quer comprar e por quanto, que eu preparo uma meta para você confirmar.'));
    return;
  }

  for (const message of messages) anexar(log, message);
}

/** Acrescenta uma linha ao fim, sem tocar nas que já estão desenhadas. */
function anexar(log, message) {
  // A dica de boas-vindas sai quando a primeira mensagem chega.
  log.querySelector('.caption.center')?.remove();

  const node = bubbleFor(message, log);
  nos.set(message, node);
  log.append(node);

  // A pergunta do usuário é a âncora da vez: é dela que a resposta desce.
  if (message.type === 'text' && message.role === 'user') ultimaAncora = node;
  return node;
}

/** Redesenha uma linha só — usado quando uma proposta é aceita ou recusada. */
function atualizar(log, message) {
  const antigo = nos.get(message);
  if (!antigo) return;
  const novo = bubbleFor(message, log);
  nos.set(message, novo);
  antigo.replaceWith(novo);
}

function bubbleFor(message, log) {
  if (message.type === 'text') {
    return el('div', { class: `bubble ${message.role}` }, message.text);
  }
  if (message.type === 'sources') return sourcesCard(message.payload);
  if (message.type === 'status') return el('div', { class: 'bubble status' }, message.text);
  if (message.type === 'proposal') return proposalCard(message, log);
  if (message.type === 'error') {
    return el('div', { class: 'bubble error' }, [
      el('strong', {}, '⚠ '), message.text,
    ]);
  }
  return el('div');
}

/**
 * De onde o assistente tirou o que disse.
 *
 * Fica logo abaixo da resposta porque preço sem origem visível é preço
 * enganoso — a regra que sustentava o cartão antigo continua valendo, só
 * mudou o que há para mostrar.
 */
function sourcesCard(payload) {
  const links = payload.links ?? [];
  const queries = payload.queries ?? [];

  return card([
    el('span', { class: 'caption' }, 'FONTES CONSULTADAS'),

    ...links.filter((s) => safeURL(s.url)).map((source) =>
      el('a', {
        href: safeURL(source.url) ?? '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'link',
      }, `${source.title} ↗`)),

    links.length === 0
      ? el('span', { class: 'caption tiny' }, 'A busca não retornou links.')
      : null,

    queries.length
      ? el('span', { class: 'caption tiny' }, `Buscas: ${queries.join(' · ')}`)
      : null,

    el('p', { class: 'caption tiny' },
      'Valores estimados a partir de anúncios na web. Variam por vendedor, frete e região.'),
  ]);
}

/** O agente propõe; quem cria é você. Nada é salvo sem o toque em "Sim". */
function proposalCard(message, log) {
  if (message.status === 'accepted') {
    return card([el('span', { class: 'caption positive' }, '✓ Você aceitou esta proposta.')]);
  }
  if (message.status === 'declined') {
    return card([el('span', { class: 'caption' }, 'Proposta recusada.')]);
  }

  const prefill = message.payload.prefill;

  return card([
    el('span', { class: 'caption accent' }, 'PROPOSTA DO ASSISTENTE'),
    el('strong', {}, prefill.title),
    el('span', { class: 'big-money sm' }, brl(prefill.target_amount)),
    prefill.rationale ? el('span', { class: 'caption' }, prefill.rationale) : null,
    el('p', {}, message.payload.question),

    el('div', { class: 'actions' }, [
      el('button', {
        class: 'btn primary',
        onClick: () => {
          message.status = 'accepted';
          atualizar(log, message);
          closeSheet();
          openGoalSheet(null, {
            title: prefill.title,
            targetCents: Math.round((prefill.target_amount ?? 0) * 100),
            productURL: prefill.product_url,
            imageURL: prefill.image_url,
            priority: prefill.priority ?? 2,
            rationale: prefill.rationale,
          });
        },
      }, 'Sim'),

      el('button', {
        class: 'btn',
        onClick: () => { message.status = 'declined'; atualizar(log, message); },
      }, 'Não'),

      el('button', {
        class: 'btn',
        onClick: () => {
          const links = message.sources?.links ?? [];
          const detalhe = links.length
            ? { type: 'sources', payload: message.sources }
            : {
                type: 'text', role: 'assistant',
                text: 'Este valor não veio de uma pesquisa — foi o que você informou. '
                  + 'Você pode ajustá-lo no formulário da meta.',
              };
          messages.push(detalhe);
          anexar(log, detalhe);
          rolagem.acompanhar(ultimaAncora);
        },
      }, 'Mais detalhes'),
    ]),

    el('p', { class: 'caption tiny' }, 'Nada é salvo até você confirmar o formulário.'),
  ]);
}

const brl = (reais) => money(Math.round((reais ?? 0) * 100));

// ---------------------------------------------------------------------------
// Rede
// ---------------------------------------------------------------------------

async function ask(text, log) {
  const base = backendURL();
  if (!base) return;

  const pergunta = { type: 'text', role: 'user', text };
  messages.push(pergunta);
  const assistant = { type: 'text', role: 'assistant', text: '' };

  // A pergunta sobe para perto do topo, e a resposta cresce no espaço
  // aberto abaixo dela em vez de empurrar a conversa para cima.
  rolagem.ancorar(anexar(log, pergunta));

  const history = messages
    .filter((m) => m.type === 'text')
    .map((m) => ({ role: m.role, content: m.text }));

  let lastSources = null;
  let pending = null; // o aviso "Pesquisando…", enquanto estiver na tela

  try {
    const response = await fetch(`${base}/v1/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        conversation_id: crypto.randomUUID?.() ?? String(Date.now()),
        messages: history,
        locale: 'pt-BR',
        country: 'BR',
        finance_snapshot: snapshot(),
        consents: {
          store_search_logs: false,
          send_finance_snapshot: Boolean(state.settings.sendSnapshot),
        },
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`O servidor respondeu ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    // Parser SSE: um evento pode chegar partido em vários pedaços de rede,
    // então acumulamos até encontrar a linha em branco que fecha o bloco.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');

        if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;

        const data = safeParse(line.slice(5).trim());
        if (!data) continue;

        if (currentEvent === 'text_delta') {
          if (pending) {
            const at = messages.indexOf(pending);
            if (at >= 0) messages.splice(at, 1);
            pending = null;
          }
          if (!messages.includes(assistant)) { messages.push(assistant); anexar(log, assistant); }
          assistant.text += data.text ?? '';
          // Só o texto da bolha muda: nada mais é redesenhado, então a
          // seleção do leitor e a posição da rolagem sobrevivem.
          nos.get(assistant).textContent = assistant.text;
          rolagem.acompanhar(ultimaAncora);
        } else if (currentEvent === 'tool_started') {
          // Aviso efêmero: some assim que a resposta começa a chegar, para
          // não deixar "Pesquisando…" parado na tela depois do resultado.
          pending = { type: 'status', text: data.label ?? 'Trabalhando…' };
          messages.push(pending);
          anexar(log, pending);
          rolagem.acompanhar(ultimaAncora);
        } else if (currentEvent === 'sources') {
          lastSources = data;
          const fontes = { type: 'sources', payload: data };
          messages.push(fontes);
          anexar(log, fontes);
          rolagem.acompanhar(ultimaAncora);
        } else if (currentEvent === 'proposal') {
          const proposta = { type: 'proposal', payload: data, status: 'pending', sources: lastSources };
          messages.push(proposta);
          anexar(log, proposta);
          rolagem.acompanhar(ultimaAncora);
        } else if (currentEvent === 'error') {
          const falha = { type: 'error', text: data.message ?? 'Algo deu errado.' };
          messages.push(falha);
          anexar(log, falha);
          rolagem.acompanhar(ultimaAncora);
        }
      }
    }
  } catch (error) {
    const falha = {
      type: 'error',
      text: navigator.onLine
        ? `Não consegui falar com o assistente. ${error.message}`
        : 'Você está sem conexão. O assistente volta quando a internet voltar.',
    };
    messages.push(falha);
    anexar(log, falha);
    rolagem.acompanhar(ultimaAncora);
  }
}

/** Agregado e opt-in: nunca lançamentos, saldos por conta ou anotações. */
function snapshot() {
  if (!state.settings.sendSnapshot) return { enabled: false };

  const month = monthKey(todayISO());
  const summary = monthSummary(state.transactions, month, false);

  return {
    enabled: true,
    currency: 'BRL',
    monthly_income_avg: summary.income / 100,
    monthly_expense_avg: summary.expense / 100,
    savings_capacity_avg: (summary.income - summary.expense) / 100,
    active_goals: state.goals
      .filter((goal) => goal.status === 'active')
      .slice(0, 10)
      .map((goal) => ({
        title: goal.title,
        target: goal.targetCents / 100,
        remaining: remainingCents(goal, contributionsOf(goal.id)) / 100,
      })),
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
