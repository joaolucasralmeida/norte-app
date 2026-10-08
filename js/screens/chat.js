/**
 * Assistente de IA.
 *
 * Reaproveita o backend Node deste mesmo projeto (`backend/`), que já faz o
 * loop de ferramentas com a Claude API e a busca de preços. Aqui é só o
 * cliente de SSE e a interface.
 *
 * Sem servidor configurado, a tela explica o que falta em vez de dar erro —
 * o app inteiro continua funcionando offline, este é o único pedaço que
 * depende de rede.
 */

import { state, saveQuote, setSetting } from '../store.js';
import { money, fmtCollectedAt, parseMoney } from '../format.js';
import { el, card, openSheet, closeSheet, toast, field, input, progressBar } from '../ui.js';
import { openGoalSheet } from './goals.js';
import { monthSummary, contributedCents, remainingCents } from '../domain.js';
import { contributionsOf } from '../store.js';
import { todayISO, monthKey } from '../format.js';

const messages = [];

export function openChat() {
  const body = el('div', { class: 'chat' });
  const log = el('div', { class: 'chat-log' });
  const composer = buildComposer(log);

  body.append(log, composer);
  renderLog(log);

  openSheet({ title: 'Assistente', body, hideConfirm: true });
}

function backendURL() {
  const raw = (state.settings.backendURL ?? '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

function buildComposer(log) {
  const textInput = input({
    placeholder: 'Quanto custa um iPhone 15 128GB?',
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

function renderLog(log) {
  log.replaceChildren();

  if (!backendURL()) {
    log.append(card([
      el('strong', {}, 'Assistente não configurado'),
      el('p', { class: 'caption' },
        'O chat e a busca de preços precisam do servidor deste projeto publicado em algum lugar com https. ' +
        'Configure o endereço em Configurações › Assistente de IA.'),
      el('p', { class: 'caption tiny' },
        'Sem isso, todo o resto do app funciona normalmente e sem internet.'),
    ]));
    return;
  }

  if (messages.length === 0) {
    log.append(el('p', { class: 'caption center' },
      'Pergunte um preço e eu preparo uma meta de compra para você confirmar.'));
    return;
  }

  for (const message of messages) log.append(bubbleFor(message, log));
  log.scrollTop = log.scrollHeight;
}

function bubbleFor(message, log) {
  if (message.type === 'text') {
    return el('div', { class: `bubble ${message.role}` }, message.text);
  }
  if (message.type === 'price') return priceCard(message.result);
  if (message.type === 'proposal') return proposalCard(message, log);
  if (message.type === 'error') {
    return el('div', { class: 'bubble error' }, [
      el('strong', {}, '⚠ '), message.text,
    ]);
  }
  return el('div');
}

/**
 * Card de preço: faixa, mediana, amostra, fontes e **horário da coleta**.
 * Preço sem data e sem fonte é preço enganoso — mesma regra do app nativo.
 */
function priceCard(result) {
  const position = result.max_price > result.min_price
    ? (result.median_price - result.min_price) / (result.max_price - result.min_price)
    : 0.5;

  return card([
    el('div', { class: 'row' }, [
      el('strong', {}, result.query),
      el('span', { class: 'badge ok' }, `${result.sample_size} ofertas`),
    ]),

    progressBar(position),

    el('div', { class: 'price-range' }, [
      el('div', {}, [el('span', { class: 'caption' }, 'mín'), el('strong', {}, brl(result.min_price))]),
      el('div', { class: 'center' }, [
        el('span', { class: 'caption' }, 'mediana'),
        el('strong', { class: 'big' }, brl(result.median_price)),
      ]),
      el('div', { class: 'right' }, [el('span', { class: 'caption' }, 'máx'), el('strong', {}, brl(result.max_price))]),
    ]),

    el('div', { class: 'stack-xs' }, [
      el('span', { class: 'caption' }, 'FONTES'),
      ...(result.sources ?? []).map((source) =>
        el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', class: 'link' },
          `${source.name} ↗`)),
      el('span', { class: 'caption tiny' }, fmtCollectedAt(result.fetched_at)),
    ]),

    el('p', { class: 'caption tiny' }, result.disclaimer ?? ''),
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
          renderLog(log);
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
        onClick: () => { message.status = 'declined'; renderLog(log); },
      }, 'Não'),

      el('button', {
        class: 'btn',
        onClick: () => {
          const offers = message.offers ?? [];
          messages.push({
            type: 'text', role: 'assistant',
            text: offers.length
              ? 'Ofertas consideradas:\n' + offers.slice(0, 5)
                  .map((o) => `• ${o.seller}: ${brl(o.price)}`).join('\n')
              : 'Não guardei o detalhe das ofertas desta consulta.',
          });
          renderLog(log);
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

  messages.push({ type: 'text', role: 'user', text });
  const assistant = { type: 'text', role: 'assistant', text: '' };
  renderLog(log);

  const history = messages
    .filter((m) => m.type === 'text')
    .map((m) => ({ role: m.role, content: m.text }));

  let lastOffers = [];

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
          if (!messages.includes(assistant)) messages.push(assistant);
          assistant.text += data.text ?? '';
          renderLog(log);
        } else if (currentEvent === 'price_result') {
          lastOffers = data.offers ?? [];
          messages.push({ type: 'price', result: data });
          await saveQuote({
            query: data.query,
            medianCents: Math.round(data.median_price * 100),
            minCents: Math.round(data.min_price * 100),
            maxCents: Math.round(data.max_price * 100),
            sampleSize: data.sample_size,
            source: data.sources?.[0]?.name ?? null,
            fetchedAt: data.fetched_at,
          });
          renderLog(log);
        } else if (currentEvent === 'proposal') {
          messages.push({ type: 'proposal', payload: data, status: 'pending', offers: lastOffers });
          renderLog(log);
        } else if (currentEvent === 'error') {
          messages.push({ type: 'error', text: data.message ?? 'Algo deu errado.' });
          renderLog(log);
        }
      }
    }
  } catch (error) {
    messages.push({
      type: 'error',
      text: navigator.onLine
        ? `Não consegui falar com o assistente. ${error.message}`
        : 'Você está sem conexão. O assistente volta quando a internet voltar.',
    });
    renderLog(log);
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
