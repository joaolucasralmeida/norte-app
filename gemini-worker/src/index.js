/**
 * Worker do assistente do Norte.
 *
 * Existe por um motivo só: **guardar a chave da API**. O app roda inteiro no
 * navegador e o repositório é público — qualquer chave ali seria lida por
 * qualquer pessoa. Aqui ela fica numa variável secreta do Cloudflare, que
 * nunca chega ao navegador.
 *
 * Rotas:
 *   POST /v1/agent/chat     conversa com o Gemini, resposta em SSE
 *   GET  /v1/diag           o que a chave alcança — para depurar sem adivinhar
 *   GET  /v1/healthz
 *
 * Havia uma `POST /v1/prices/search`, busca de preço sem IA na API do
 * Mercado Livre. Saiu quando o Mercado Livre fechou a busca pública: a rota
 * existia só para ela.
 */

import { runAgent, listModels } from './gemini.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight(request, env);

    try {
      if (url.pathname === '/v1/healthz') {
        return json({
          status: 'ok',
          provider: 'gemini',
          hasKey: Boolean(env.GEMINI_API_KEY),
          // Diz se a busca está realmente ativa, não só configurada — é a
          // primeira coisa que se quer saber quando o assistente "não
          // pesquisa" e ninguém sabe se é chave, interruptor ou cota.
          search: Boolean(env.TAVILY_API_KEY) && String(env.SEARCH_ENABLED ?? '1').trim() !== '0',
        }, request, env);
      }
      if (url.pathname === '/v1/diag') return diag(request, env);
      if (url.pathname === '/v1/agent/chat' && request.method === 'POST') return chat(request, env);

      return json({ error: 'not_found' }, request, env, 404);
    } catch (error) {
      return json({ error: 'internal', detail: String(error.message ?? error) }, request, env, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * Decide o cabeçalho `Access-Control-Allow-Origin`.
 *
 * Três casos, e o do meio é fácil de errar:
 * · **sem `Origin`** — navegação direta na barra de endereço, `curl`, um
 *   monitor de uptime. Não é requisição entre sites, então não há CORS a
 *   aplicar: deixa passar sem cabeçalho nenhum. (Tratar ausência como
 *   proibido quebrava `/v1/diag`, que o README manda abrir no navegador.)
 * · **origem na lista** — devolve a origem.
 * · **origem fora da lista** — `null`, e quem chamou recebe 403. Sem isso,
 *   qualquer site usaria este Worker como proxy e queimaria a cota.
 *
 * Exportada para poder ser testada sem subir o Worker.
 */
export function resolveOrigin(origem, listaBruta) {
  if (!origem) return { permitido: true, header: null };

  const permitidas = String(listaBruta ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);

  if (permitidas.length === 0) return { permitido: true, header: '*' }; // só em desenvolvimento
  if (permitidas.includes(origem)) return { permitido: true, header: origem };
  return { permitido: false, header: null };
}

function corsHeaders(request, env) {
  const { permitido, header } = resolveOrigin(request.headers.get('origin'), env.ALLOWED_ORIGINS);
  if (!permitido) return null;
  if (!header) return {};

  return {
    'access-control-allow-origin': header,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function preflight(request, env) {
  const headers = corsHeaders(request, env);
  return new Response(null, { status: headers ? 204 : 403, headers: headers ?? {} });
}

function json(body, request, env, status = 200) {
  const cors = corsHeaders(request, env);
  if (!cors) return new Response('origem não autorizada', { status: 403 });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

async function diag(request, env) {
  if (!env.GEMINI_API_KEY) {
    return json({ ok: false, erro: 'GEMINI_API_KEY não configurada no Worker.' }, request, env);
  }
  return json(await listModels(env), request, env);
}

async function chat(request, env) {
  const cors = corsHeaders(request, env);
  if (!cors) return new Response('origem não autorizada', { status: 403 });

  if (!env.GEMINI_API_KEY) {
    return json({ error: 'sem_chave' }, request, env, 503);
  }

  const body = await request.json().catch(() => ({}));
  const messages = sanearMensagens(body.messages);
  if (!messages) return json({ error: 'mensagens_invalidas' }, request, env, 400);

  const snapshot = sanearSnapshot(body.finance_snapshot, body.consents);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const emit = (event, data) => {
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      .catch(() => {}); // cliente fechou a conexão
  };

  // Não dá await: a resposta precisa começar a fluir já.
  runAgent({ env, messages, snapshot, emit })
    .catch((error) => emit('error', { code: 'internal', message: String(error.message ?? error), retryable: true }))
    .finally(() => writer.close().catch(() => {}));

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      ...cors,
    },
  });
}

// ---------------------------------------------------------------------------
// Validação da entrada
// ---------------------------------------------------------------------------

function sanearMensagens(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) return null;

  const saida = [];
  for (const item of value) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
    const content = typeof item?.content === 'string' ? item.content.slice(0, 4000) : null;
    if (!role || !content) return null;
    saida.push({ role, content });
  }
  return saida[0].role === 'user' ? saida : null;
}

/**
 * Minimização: mesmo que o app mande campos a mais, só a lista abaixo chega
 * ao modelo. É a rede de segurança para "alguém adicionou transações ao
 * snapshot sem perceber".
 */
function sanearSnapshot(value, consents) {
  if (consents?.send_finance_snapshot !== true) return { enabled: false };
  if (!value || value.enabled !== true) return { enabled: false };

  const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

  return {
    enabled: true,
    currency: typeof value.currency === 'string' ? value.currency.slice(0, 3) : 'BRL',
    monthly_income_avg: numero(value.monthly_income_avg),
    monthly_expense_avg: numero(value.monthly_expense_avg),
    savings_capacity_avg: numero(value.savings_capacity_avg),
    active_goals: Array.isArray(value.active_goals)
      ? value.active_goals.slice(0, 10).map((g) => ({
          title: String(g?.title ?? '').slice(0, 80),
          target: numero(g?.target) ?? 0,
          remaining: numero(g?.remaining) ?? 0,
        }))
      : [],
  };
}
