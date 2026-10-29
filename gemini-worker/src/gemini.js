/**
 * Loop de conversa com o Gemini, com chamada de funções e saída em SSE.
 *
 * A API do Gemini devolve `functionCall` quando quer usar uma ferramenta.
 * Executamos aqui e devolvemos `functionResponse`, repetindo até o modelo
 * responder em texto. É o mesmo desenho do backend da Claude — o que muda é
 * o formato do JSON.
 *
 * Os eventos SSE emitidos são **os mesmos** que o app já entende
 * (`text_delta`, `price_result`, `proposal`, `error`, `message_stop`), então
 * o lado do navegador não precisou mudar nenhuma linha.
 */

import { buildSystemPrompt, FUNCTION_DECLARATIONS } from './prompt.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TOOL_ROUNDS = 5;

/**
 * Modelos tentados em ordem, do mais barato para o mais capaz.
 *
 * A lista existe porque o catálogo do Gemini muda com frequência e a
 * documentação não publica mais quais modelos entram no nível gratuito:
 * em vez de fixar um nome que pode sumir, tentamos até um responder e
 * lembramos qual funcionou enquanto o isolate viver.
 */
const MODEL_FALLBACKS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
];

/**
 * Note que não há nenhum 2.5 aqui, embora o `/v1/diag` os liste.
 *
 * Eles respondem 404 "no longer available to new users" — contas criadas
 * depois de certo ponto não os alcançam. Mantê-los na lista só acrescentava
 * duas viagens de ida e volta antes de desistir, atrasando a mensagem de
 * erro que o usuário ia receber de qualquer jeito.
 */

/**
 * Quantas vezes percorrer a lista inteira antes de desistir.
 *
 * Medido com a família 3 congestionada: 1 passada falhava metade das
 * perguntas, 2 passadas ~12%, 3 passadas ~0%. As passadas extras só custam
 * tempo quando a chamada já ia falhar de qualquer jeito — um 503 volta na
 * hora, não espera.
 */
const MODEL_PASSES = 3;

let workingModel = null;

function candidates(env) {
  const configured = (env.GEMINI_MODEL ?? '').trim();
  const list = configured ? [configured, ...MODEL_FALLBACKS] : [...MODEL_FALLBACKS];
  if (workingModel) list.unshift(workingModel);
  return [...new Set(list)];
}

// ---------------------------------------------------------------------------
// Chamada à API
// ---------------------------------------------------------------------------

/**
 * A busca na web existe se — e só se — houver chave da Tavily configurada.
 *
 * O interruptor `SEARCH_ENABLED` serve para desligar sem apagar a chave,
 * quando a cota do mês acabar e você preferir uma recusa honesta a um erro
 * a cada pergunta.
 *
 * Sem busca o assistente continua útil: conversa, comenta o planejamento e
 * monta metas com o valor que o usuário informar.
 */
function buscaDisponivel(env) {
  if (!env.TAVILY_API_KEY) return false;
  return String(env.SEARCH_ENABLED ?? '1').trim() !== '0';
}

/** As declarações que o modelo enxerga. Sem busca, a ferramenta some. */
function ferramentas(env) {
  const lista = buscaDisponivel(env)
    ? FUNCTION_DECLARATIONS
    : FUNCTION_DECLARATIONS.filter((f) => f.name !== 'pesquisar_preco');
  return [{ functionDeclarations: lista }];
}

async function callGemini(env, model, contents) {
  const response = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Header em vez de ?key=: a chave não entra na URL nem em log de acesso.
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt(buscaDisponivel(env)) }] },
      contents,
      tools: ferramentas(env),
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(detail.slice(0, 400));
    error.status = response.status;
    // `message` fica curto porque atravessa o código todo; o corpo inteiro
    // vai à parte. Cortar em 400 descartava justamente `error.details`, onde
    // o Google diz *qual* cota estourou — e isso custou uma hora de caça.
    error.detail = detail;
    throw error;
  }
  return response.json();
}

/**
 * Tenta os modelos em ordem até um aceitar, e repete a lista uma segunda vez
 * depois de uma pausa.
 *
 * A segunda passada existe porque o 503 do Gemini diz literalmente "spikes in
 * demand are usually temporary". Já aconteceu de a família 3 inteira estar
 * congestionada no mesmo segundo; um segundo e meio depois, respondia. Sem a
 * repetição, o usuário recebia erro numa pergunta em cada duas.
 */
async function callWithFallback(env, contents) {
  let last = null;

  for (let passo = 0; passo < MODEL_PASSES; passo += 1) {
    if (passo > 0) await new Promise((r) => setTimeout(r, 1500));

    for (const model of candidates(env)) {
      try {
        const data = await callGemini(env, model, contents);
        workingModel = model;
        return { data, model };
      } catch (error) {
        last = error;
        console.error('modelo recusou', model, error.status ?? 0, resumirErro(error));
        // Erros que dizem "este modelo não serve agora" — o próximo da lista
        // pode servir:
        //   404 modelo inexistente · 403 sem acesso
        //   503 modelo lotado      · 500 falha passageira do lado do Google
        // O 503 é o mais comum e o menos óbvio: a capacidade do Gemini varia
        // por modelo ao longo do dia.
        //
        // O 429 fica de fora de propósito. Ele é cota, não capacidade, e
        // desfilar por todos os modelos só queimaria o resto do nível
        // gratuito mais rápido. Melhor dizer que o limite acabou.
        if (![404, 403, 500, 503].includes(error.status)) throw error;

        // Um modelo que acabou de falhar não deve continuar sendo o
        // preferido na segunda passada.
        if (workingModel === model) workingModel = null;
      }
    }
  }

  throw last ?? new Error('Nenhum modelo disponível.');
}

// ---------------------------------------------------------------------------
// Busca na web — Tavily
// ---------------------------------------------------------------------------

/**
 * Por que uma API de busca separada, e não a do próprio modelo.
 *
 * A busca embutida do Gemini (grounding com Google Search) seria o caminho
 * curto, e não funciona no nível gratuito — isto foi medido contra a API
 * real, não suposto:
 *
 * · nos modelos Gemini 3, que esta conta alcança, a busca exige plano pago,
 *   e com ela ligada a API devolve 429 em **toda** chamada, até num "oi";
 * · nos modelos 2.5, onde a busca é gratuita, a API responde 404 — "no
 *   longer available to new users".
 *
 * A Tavily dá 1.000 buscas por mês sem cartão e devolve o texto já extraído
 * da página, em vez de HTML que o modelo teria de decifrar. O encaixe é o
 * mesmo de antes: o Gemini chama `pesquisar_preco`, nós pesquisamos aqui, e
 * o resultado volta como `functionResponse`.
 */
const TAVILY_URL = 'https://api.tavily.com/search';

/** Quantos resultados pedir. Cinco cobre a faixa de preço sem inchar o contexto. */
const TAVILY_MAX_RESULTS = 5;

/**
 * Distingue a página de um produto de uma listagem de busca.
 *
 * Boa parte dos resultados de comparador vem como "lista.loja.com.br/termo"
 * ou ".../busca?q=termo". Salvar isso na meta dá um link que, aberto meses
 * depois, mostra qualquer coisa — ou nada, se o termo sumir do catálogo. A
 * página do produto continua sendo a mesma coisa.
 *
 * A marcação é um palpite por formato de endereço, não uma certeza; por isso
 * ela orienta a escolha do modelo em vez de descartar o resultado. Descartar
 * deixaria buscas legítimas sem link nenhum.
 */
function ehPaginaDeBusca(url) {
  try {
    const { pathname, search } = new URL(url);
    const alvo = `${pathname}${search}`.toLowerCase();
    return /(^|\/)(busca|buscar|search|lista|pesquisa)(\/|\?|$)/.test(alvo)
      || /[?&](q|query|busca|search|k)=/.test(alvo);
  } catch {
    return false;
  }
}

async function buscarNaWeb(env, consulta) {
  const termo = String(consulta ?? '').trim();
  if (termo.length < 2) {
    const erro = new Error('consulta curta demais');
    erro.status = 400;
    throw erro;
  }

  const response = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      // "preço" explícito na consulta: o usuário pergunta "quanto custa um
      // iPhone 15", mas quem vai ler os resultados é um buscador, não o
      // modelo — e buscador responde melhor a palavra-chave.
      query: `preço ${termo} comprar`,
      // `basic` custa 1 crédito; `advanced` custa 2 e não melhora nada para
      // uma faixa de preço. Com 1.000 por mês, não há razão para gastar o
      // dobro.
      search_depth: 'basic',
      max_results: TAVILY_MAX_RESULTS,
      topic: 'general',
      country: 'brazil',
      language: 'pt',
      // Resumo pronto da própria Tavily. Serve de âncora: se ele divergir
      // dos trechos, o modelo tem como perceber.
      include_answer: true,
      // Fotos do produto, para a meta não nascer com um emoji genérico.
      // A descrição é o que permite ao modelo escolher a foto do produto em
      // vez do logotipo da loja ou de um banner de promoção — sem ela, a
      // escolha seria no escuro.
      include_images: true,
      include_image_descriptions: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const erro = new Error('busca falhou');
    erro.status = response.status;
    erro.detail = await response.text();
    console.error('busca na Tavily falhou', response.status, erro.detail.slice(0, 200));
    throw erro;
  }

  const data = await response.json();
  const resultados = Array.isArray(data.results) ? data.results : [];
  const imagens = Array.isArray(data.images) ? data.images : [];

  return {
    resumo: String(data.answer ?? '').trim(),

    // O modelo recebe os resultados **com a URL**, e não só o texto corrido.
    // Essa era a razão de a meta nunca nascer com link: o endereço da loja
    // existia na resposta da busca e era descartado antes de chegar nele.
    resultados: resultados.slice(0, TAVILY_MAX_RESULTS).map((r) => ({
      titulo: String(r.title ?? 'sem título').slice(0, 140),
      url: httpsOrNull(r.url),
      trecho: String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 400),
      pagina_de_busca: ehPaginaDeBusca(r.url),
    })).filter((r) => r.url),

    imagens: imagens.slice(0, 6).map((img) => ({
      url: httpsOrNull(typeof img === 'string' ? img : img?.url),
      descricao: String((typeof img === 'object' && img?.description) || '').slice(0, 160),
    })).filter((img) => img.url),

    fontes: {
      links: resultados
        .filter((r) => r.url)
        .slice(0, 6)
        .map((r) => ({ title: r.title ?? 'Fonte', url: r.url })),
      queries: [termo],
      fetched_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export async function runAgent({ env, messages, snapshot, emit }) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let propostasFeitas = 0;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const { data } = await callWithFallback(env, contents);

      const candidate = data.candidates?.[0];
      if (!candidate) {
        emit('error', { code: 'internal', message: 'O Gemini respondeu vazio.', retryable: true });
        break;
      }

      // Bloqueio por política de segurança do Google.
      if (candidate.finishReason === 'SAFETY' || data.promptFeedback?.blockReason) {
        emit('error', {
          code: 'refused',
          message: 'Não consigo responder a esse pedido. Tente perguntar de outro jeito.',
          retryable: false,
        });
        break;
      }

      const parts = candidate.content?.parts ?? [];
      const texto = parts.filter((p) => p.text).map((p) => p.text).join('');
      const chamadas = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

      if (texto) emit('text_delta', { text: texto });

      if (chamadas.length === 0) break;

      // O turno do modelo precisa voltar ao histórico antes das respostas.
      contents.push({ role: 'model', parts });

      const respostas = [];
      for (const chamada of chamadas) {
        const resultado = await executarFerramenta(chamada, {
          env, emit, snapshot, podePropor: propostasFeitas < 2,
        });
        if (chamada.name === 'propor_meta') propostasFeitas += 1;

        respostas.push({
          functionResponse: { name: chamada.name, response: resultado },
        });
      }

      contents.push({ role: 'user', parts: respostas });
    }
  } catch (error) {
    emitirFalha(error, emit);
  }

  emit('message_stop', { stop_reason: 'end_turn', model: workingModel });
}

/**
 * Traduz o código HTTP da Tavily para algo que o usuário possa agir.
 *
 * Vale distinguir o 429 do 432: um passa sozinho em alguns segundos, o outro
 * só no mês que vem. Dizer "tente de novo" para quem esgotou a cota do mês é
 * mandar a pessoa bater numa porta trancada.
 */
function mensagemDeBusca(status) {
  if (status === 401) {
    return {
      code: 'internal',
      message: 'A chave da busca foi recusada. Confira TAVILY_API_KEY no servidor.',
      retryable: false,
    };
  }
  if (status === 432 || status === 433) {
    return {
      code: 'quota_exhausted',
      message: 'As buscas gratuitas do mês acabaram. Você ainda pode criar metas informando o valor.',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: 'Muitas buscas seguidas. Tente de novo em alguns segundos.',
      retryable: true,
    };
  }
  return { code: 'provider_unavailable', message: 'Não consegui pesquisar agora.', retryable: true };
}

async function executarFerramenta(chamada, { env, emit, snapshot, podePropor }) {
  const args = chamada.args ?? {};

  switch (chamada.name) {
    case 'pesquisar_preco': {
      emit('tool_started', { tool: 'pesquisar_preco', label: 'Pesquisando na web…' });
      try {
        const { resumo, resultados, imagens, fontes } = await buscarNaWeb(env, args.produto);

        // As fontes vão para o app assim que chegam, antes de o modelo
        // escrever a resposta: preço sem origem visível é preço enganoso, e
        // essa regra sobreviveu à troca de provedor e à troca de fonte.
        if (fontes?.links?.length) emit('sources', fontes);

        if (!resumo && resultados.length === 0) {
          return { status: 'error', motivo: 'sem_resultados' };
        }

        return { status: 'ok', resumo, resultados, imagens };
      } catch (error) {
        emit('error', mensagemDeBusca(error.status ?? 0));
        // Volta como resultado de ferramenta, nunca como exceção: é assim que
        // o modelo consegue dizer "não encontrei" em vez de travar.
        return { status: 'error', motivo: 'busca_indisponivel', sugestao: 'pedir ao usuario um valor estimado' };
      }
    }

    case 'propor_meta': {
      if (!podePropor) {
        return { status: 'error', motivo: 'limite_de_propostas' };
      }
      if (!args.titulo || !(Number(args.valor_alvo) > 0)) {
        return { status: 'error', motivo: 'dados_invalidos' };
      }

      const id = crypto.randomUUID();
      // Nenhum efeito colateral: isto só desenha um cartão. Quem grava é o app.
      emit('proposal', {
        proposal_id: id,
        kind: 'create_goal',
        question: 'Deseja transformar isso em uma meta de compra?',
        options: ['sim', 'nao', 'mais_detalhes'],
        prefill: {
          title: String(args.titulo),
          target_amount: Number(args.valor_alvo),
          currency: 'BRL',
          product_url: httpsOrNull(args.url_produto),
          image_url: httpsOrNull(args.url_imagem),
          target_date: null,
          priority: [1, 2, 3].includes(Number(args.prioridade)) ? Number(args.prioridade) : 2,
          rationale: args.justificativa ? String(args.justificativa) : null,
        },
      });

      return { status: 'proposta_exibida', proposta_id: id, aguardando: 'confirmacao_do_usuario' };
    }

    case 'consultar_resumo_financeiro':
      return snapshot?.enabled
        ? {
            status: 'ok',
            moeda: snapshot.currency ?? 'BRL',
            receita_media_mensal: snapshot.monthly_income_avg ?? null,
            despesa_media_mensal: snapshot.monthly_expense_avg ?? null,
            capacidade_de_poupanca_mensal: snapshot.savings_capacity_avg ?? null,
            metas_ativas: snapshot.active_goals ?? [],
          }
        : { status: 'indisponivel', motivo: 'usuario_nao_autorizou' };

    default:
      return { status: 'error', motivo: 'ferramenta_desconhecida' };
  }
}

/** O app abre esses links: só aceita https bem formado. */
function httpsOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Condensa o erro do Google no que serve para depurar.
 *
 * O corpo bruto não cabe no log: `wrangler tail` corta a linha por volta de
 * 600 caracteres, e a mensagem do Google gasta esse espaço todo com duas URLs
 * de documentação — justamente antes de `details`, onde fica o identificador
 * da cota que estourou. Sem isso, "você excedeu sua cota" não diz *qual*.
 */
function resumirErro(error) {
  const bruto = String(error.detail ?? error.message ?? error);

  let corpo;
  try {
    corpo = JSON.parse(bruto);
  } catch {
    return bruto.slice(0, 300);
  }

  const detalhes = corpo?.error?.details ?? [];
  const cotas = detalhes
    .flatMap((d) => d.violations ?? [])
    .map((v) => v.quotaId ?? v.quotaMetric)
    .filter(Boolean);
  const espera = detalhes.find((d) => d.retryDelay)?.retryDelay;

  return JSON.stringify({
    status: corpo?.error?.status,
    // A mensagem vem cortada porque a do Google gasta centenas de caracteres
    // com URLs de documentação; os primeiros 180 dizem o que importa.
    msg: String(corpo?.error?.message ?? '').slice(0, 180),
    cotas,
    espera,
    modelo: detalhes.flatMap((d) => Object.values(d.quotaDimensions ?? {})),
  });
}

function emitirFalha(error, emit) {
  const status = error.status ?? 0;

  // O usuário recebe uma frase genérica — ele não pode fazer nada com o JSON
  // de erro do Google. Mas sem o detalhe em algum lugar, depurar vira
  // adivinhação: `wrangler tail` mostra esta linha. Não há segredo aqui: a
  // chave vai em cabeçalho e nunca aparece no corpo da resposta de erro.
  console.error('falha na chamada ao Gemini', status, resumirErro(error));

  if (status === 429) {
    emit('error', {
      code: 'rate_limited',
      message: 'O limite gratuito do Gemini foi atingido. Tente de novo em alguns minutos.',
      retryable: true,
    });
    return;
  }
  if (status === 401 || status === 403) {
    emit('error', {
      code: 'internal',
      message: 'A chave do Gemini foi recusada. Confira GEMINI_API_KEY no servidor.',
      retryable: false,
    });
    return;
  }
  if (status === 404) {
    emit('error', {
      code: 'internal',
      message: 'Nenhum modelo do Gemini disponível para esta chave. Veja /v1/diag.',
      retryable: false,
    });
    return;
  }
  if (status === 503) {
    // Chegar aqui significa que a lista inteira falhou, duas vezes. É
    // congestionamento do Google, não problema de configuração — e vale
    // dizer isso, para o usuário não sair procurando o que ele quebrou.
    emit('error', {
      code: 'provider_unavailable',
      message: 'Os servidores do Gemini estão congestionados agora. Tente de novo em instantes.',
      retryable: true,
    });
    return;
  }

  emit('error', { code: 'internal', message: 'O assistente está indisponível agora.', retryable: true });
}

/** Modelos que a chave realmente alcança — usado por /v1/diag. */
export async function listModels(env) {
  const response = await fetch(`${API_BASE}/models`, {
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    return { ok: false, status: response.status, detail: (await response.text()).slice(0, 300) };
  }

  const data = await response.json();
  const usaveis = (data.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));

  return { ok: true, total: usaveis.length, models: usaveis, preferido: workingModel };
}
