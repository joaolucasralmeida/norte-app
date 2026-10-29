/**
 * Testes do loop de chamada de funções, sem rede e sem chave.
 *
 * `fetch` é trocado por um dublê que responde como a API do Gemini
 * (`generateContent`) e a da Tavily responderiam. Assim dá para verificar o
 * que importa no desenho — o vai e volta de `functionCall`/`functionResponse`,
 * a troca de modelo quando um está lotado, os limites de ação do modelo — sem
 * gastar cota nem depender do humor do servidor do Google.
 *
 * Rodar: `node --test` dentro de gemini-worker/ (Node 18+).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runAgent } from '../src/gemini.js';
import worker, { resolveOrigin } from '../src/index.js';

const ENV = { GEMINI_API_KEY: 'chave-de-teste', TAVILY_API_KEY: 'tavily-de-teste', GEMINI_MODEL: '' };

// ---------------------------------------------------------------------------
// Dublês
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let chamadas;

/** Uma resposta da API do Gemini com as `parts` dadas. */
const gemini = (parts, extra = {}) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', ...extra }],
});

const respostaJson = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/**
 * Instala um `fetch` falso. `roteiro` é a fila de respostas do Gemini, uma por
 * chamada; cada item é um objeto (vira 200) ou `{ status }` (vira erro).
 */
function simular(roteiro, tavily = null) {
  const fila = [...roteiro];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    chamadas.push({ url: String(url), headers: init.headers ?? {}, body });

    if (String(url).startsWith('https://api.tavily.com/')) {
      return respostaJson(tavily ?? { answer: '', results: [], images: [] });
    }

    const proxima = fila.shift();
    if (!proxima) throw new Error(`chamada inesperada ao Gemini: ${url}`);
    if (proxima.status) {
      return respostaJson({ error: { code: proxima.status, message: 'simulado' } }, proxima.status);
    }
    return respostaJson(proxima);
  };
}

const chamadasAoGemini = () => chamadas.filter((c) => c.url.includes('generativelanguage'));

async function conversar(pergunta, env = ENV, snapshot = { enabled: false }) {
  const eventos = [];
  await runAgent({
    env,
    messages: [{ role: 'user', content: pergunta }],
    snapshot,
    emit: (event, data) => eventos.push({ event, data }),
  });
  return eventos;
}

const doTipo = (eventos, tipo) => eventos.filter((e) => e.event === tipo).map((e) => e.data);

beforeEach(() => { chamadas = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// Silencia os console.error de propósito dos caminhos de falha.
console.error = () => {};

// ---------------------------------------------------------------------------
// Loop de ferramentas
// ---------------------------------------------------------------------------

test('pesquisa o preço, devolve o resultado ao modelo e propõe a meta', async () => {
  simular(
    [
      gemini([{ functionCall: { name: 'pesquisar_preco', args: { produto: 'iPhone 15 128GB' } } }]),
      gemini([
        { text: 'Encontrei de R$ 4.299 a R$ 4.799; o menor é na Loja A.' },
        {
          functionCall: {
            name: 'propor_meta',
            args: {
              titulo: 'iPhone 15 128GB',
              valor_alvo: 4299,
              url_produto: 'https://loja-a.com.br/iphone-15-128',
              url_imagem: 'https://loja-a.com.br/foto.jpg',
            },
          },
        },
      ]),
      gemini([{ text: 'Preparei a meta para você confirmar.' }]),
    ],
    {
      answer: 'O iPhone 15 128GB custa a partir de R$ 4.299.',
      results: [
        { title: 'iPhone 15 128GB', url: 'https://loja-a.com.br/iphone-15-128', content: 'R$ 4.299 à vista' },
        { title: 'Busca iphone', url: 'https://loja-b.com.br/busca?q=iphone', content: 'R$ 4.799' },
      ],
      images: [{ url: 'https://loja-a.com.br/foto.jpg', description: 'iPhone 15 preto' }],
    },
  );

  const eventos = await conversar('Quanto custa um iPhone 15 de 128GB?');

  // Três idas ao Gemini: pede a busca, pede a proposta, responde em texto.
  const g = chamadasAoGemini();
  assert.equal(g.length, 3);

  // O resultado da busca volta ao modelo como functionResponse, com a URL —
  // sem ela a meta nasceria sem link.
  const segunda = g[1].body.contents;
  const devolvida = segunda.at(-1).parts[0].functionResponse;
  assert.equal(devolvida.name, 'pesquisar_preco');
  assert.equal(devolvida.response.status, 'ok');
  assert.equal(devolvida.response.resultados[0].url, 'https://loja-a.com.br/iphone-15-128');
  assert.equal(devolvida.response.resultados[0].pagina_de_busca, false);
  assert.equal(devolvida.response.resultados[1].pagina_de_busca, true);

  // O turno do modelo entra no histórico antes da resposta da ferramenta.
  assert.equal(segunda.at(-2).role, 'model');
  assert.ok(segunda.at(-2).parts[0].functionCall);

  // Para o app: progresso, fontes, texto e o cartão de proposta.
  assert.equal(doTipo(eventos, 'tool_started')[0].tool, 'pesquisar_preco');
  assert.equal(doTipo(eventos, 'sources')[0].links.length, 2);
  const [proposta] = doTipo(eventos, 'proposal');
  assert.equal(proposta.prefill.target_amount, 4299);
  assert.equal(proposta.prefill.product_url, 'https://loja-a.com.br/iphone-15-128');
  assert.equal(doTipo(eventos, 'message_stop').length, 1);
});

test('a chave vai no cabeçalho, nunca na URL', async () => {
  simular([gemini([{ text: 'Oi!' }])]);
  await conversar('oi');

  const [c] = chamadasAoGemini();
  assert.equal(c.headers['x-goog-api-key'], 'chave-de-teste');
  assert.ok(!c.url.includes('key='));
  assert.ok(!c.url.includes('chave-de-teste'));
});

test('sem chave da Tavily, a ferramenta de busca some e o prompt avisa', async () => {
  simular([gemini([{ text: 'Não consigo consultar preços nesta configuração.' }])]);
  await conversar('Quanto custa uma geladeira?', { GEMINI_API_KEY: 'x' });

  const [c] = chamadasAoGemini();
  const nomes = c.body.tools[0].functionDeclarations.map((f) => f.name);
  assert.ok(!nomes.includes('pesquisar_preco'));
  assert.ok(nomes.includes('propor_meta'));
  assert.match(c.body.systemInstruction.parts[0].text, /pesquisa de preços está desativada/);
});

// ---------------------------------------------------------------------------
// Troca de modelo e erros
// ---------------------------------------------------------------------------

test('modelo lotado (503) cai para o próximo da lista', async () => {
  simular([{ status: 503 }, gemini([{ text: 'Respondi pelo segundo modelo.' }])]);
  const eventos = await conversar('oi');

  const g = chamadasAoGemini();
  assert.equal(g.length, 2);
  const modelo = (url) => url.match(/models\/([^:]+):/)[1];
  assert.notEqual(modelo(g[0].url), modelo(g[1].url));
  assert.equal(doTipo(eventos, 'message_stop')[0].model, modelo(g[1].url));
});

test('cota estourada (429) não percorre a lista: para e avisa', async () => {
  simular([{ status: 429 }]);
  const eventos = await conversar('oi');

  assert.equal(chamadasAoGemini().length, 1);
  assert.equal(doTipo(eventos, 'error')[0].code, 'rate_limited');
});

test('bloqueio de segurança vira recusa, não erro genérico', async () => {
  simular([gemini([], { finishReason: 'SAFETY' })]);
  const eventos = await conversar('...');
  assert.equal(doTipo(eventos, 'error')[0].code, 'refused');
});

// ---------------------------------------------------------------------------
// Limites do que o modelo consegue fazer
// ---------------------------------------------------------------------------

test('no máximo duas propostas de meta por conversa', async () => {
  const propor = (titulo) => ({ functionCall: { name: 'propor_meta', args: { titulo, valor_alvo: 100 } } });
  simular([gemini([propor('A'), propor('B'), propor('C')]), gemini([{ text: 'ok' }])]);

  const eventos = await conversar('quero três coisas');
  assert.equal(doTipo(eventos, 'proposal').length, 2);

  const respostas = chamadasAoGemini()[1].body.contents.at(-1).parts;
  assert.equal(respostas[2].functionResponse.response.motivo, 'limite_de_propostas');
});

test('link que não é https é descartado (injeção de prompt)', async () => {
  simular([
    gemini([{
      functionCall: {
        name: 'propor_meta',
        args: { titulo: 'Fone', valor_alvo: 200, url_produto: 'javascript:alert(1)', url_imagem: 'http://x.com/a.jpg' },
      },
    }]),
    gemini([{ text: 'ok' }]),
  ]);

  const [proposta] = doTipo(await conversar('fone'), 'proposal');
  assert.equal(proposta.prefill.product_url, null);
  assert.equal(proposta.prefill.image_url, null);
});

// ---------------------------------------------------------------------------
// Worker de ponta a ponta
// ---------------------------------------------------------------------------

async function lerSSE(response) {
  const texto = await response.text();
  return texto.trim().split('\n\n').map((bloco) => {
    const [linhaEvento, linhaDados] = bloco.split('\n');
    return { event: linhaEvento.slice(7), data: JSON.parse(linhaDados.slice(6)) };
  });
}

test('o resumo financeiro chega ao modelo filtrado, e só com consentimento', async () => {
  simular([
    gemini([{ functionCall: { name: 'consultar_resumo_financeiro', args: {} } }]),
    gemini([{ text: 'Dá para guardar R$ 800 por mês.' }]),
  ]);

  const env = { ...ENV, ALLOWED_ORIGINS: 'https://app.exemplo' };
  const request = new Request('https://worker.exemplo/v1/agent/chat', {
    method: 'POST',
    headers: { origin: 'https://app.exemplo', 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Quanto consigo guardar?' }],
      consents: { send_finance_snapshot: true },
      finance_snapshot: {
        enabled: true,
        monthly_income_avg: 5000,
        monthly_expense_avg: 4200,
        savings_capacity_avg: 800,
        // Campos que o app não deveria mandar — o Worker tem de barrar.
        transactions: [{ descricao: 'Farmácia', valor: 87.9 }],
        accounts: [{ nome: 'Conta corrente', saldo: 1234 }],
      },
    }),
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const eventos = await lerSSE(response);
  assert.ok(eventos.some((e) => e.event === 'text_delta'));

  const resumo = chamadasAoGemini()[1].body.contents.at(-1).parts[0].functionResponse.response;
  assert.equal(resumo.capacidade_de_poupanca_mensal, 800);
  const enviado = JSON.stringify(chamadasAoGemini().map((c) => c.body));
  assert.ok(!enviado.includes('Farmácia'));
  assert.ok(!enviado.includes('Conta corrente'));
});

test('CORS: sem origem passa, origem fora da lista é barrada', () => {
  const lista = 'https://joaolucasralmeida.github.io';
  assert.deepEqual(resolveOrigin(null, lista), { permitido: true, header: null });
  assert.deepEqual(resolveOrigin(lista, lista), { permitido: true, header: lista });
  assert.deepEqual(resolveOrigin('https://outro.site', lista), { permitido: false, header: null });
});
