# Assistente do Norte: agente com a API do Gemini

Agente de IA que pesquisa o preço de um produto na web e transforma o desejo de compra em uma meta no app. Roda num Cloudflare Worker, entre o [Norte](../README.md) e a **API REST do Gemini**, sem SDK e sem dependências: menos de mil linhas de JavaScript.

```
App (navegador)  ──POST /v1/agent/chat──▶  Worker  ──generateContent──▶  Gemini
       ▲                                     │  ◀── functionCall ─────────┘
       └──── SSE: texto, fontes, cartão ─────┤
                                             └── pesquisar_preco ──▶ Tavily (busca na web)
```

## O que este código mostra

| | Onde |
|---|---|
| **Chamada de funções (function calling)** com 3 ferramentas declaradas em schema: o Worker executa cada `functionCall` e devolve um `functionResponse`, em loop, até o modelo responder em texto (máx. 5 rodadas) | `src/gemini.js` → `runAgent` |
| **Engenharia de prompt** com regras verificáveis: nunca dar preço de memória, citar a fonte, usar o menor preço do produto *certo*, preferir página de produto a página de busca. O prompt muda quando a busca está desligada, para o modelo não chamar uma ferramenta que não existe | `src/prompt.js` |
| **Resiliência**: lista de modelos em ordem de custo, com troca automática em `404/403/500/503` e três passadas com pausa. O `429` (cota) fica de fora de propósito, para não queimar o resto do nível gratuito | `callWithFallback` |
| **Streaming (SSE)**: a resposta começa a chegar antes de o agente terminar; as fontes aparecem antes do texto | `src/index.js` → `chat` |
| **Segurança**: a chave vai em cabeçalho (`x-goog-api-key`), nunca na URL; CORS restrito ao endereço do app; links devolvidos pelo modelo só passam se forem `https:` (defesa contra injeção de prompt vinda de páginas lidas na busca) | `httpsOrNull`, `resolveOrigin` |
| **O modelo propõe, quem grava é o usuário**: `propor_meta` só desenha um cartão com Sim/Não; limite de 2 propostas por conversa | `executarFerramenta` |
| **Minimização de dados (LGPD)**: o resumo financeiro é opt-in, e o Worker descarta qualquer campo fora da lista antes de chegar ao modelo | `sanearSnapshot` |
| **Diagnóstico**: `/v1/diag` lista os modelos que a chave alcança; os erros do Google são resumidos no log com o ID da cota que estourou | `listModels`, `resumirErro` |
| **10 testes automáticos** que simulam as APIs do Gemini e da Tavily: loop completo, troca de modelo, 429, bloqueio de segurança, limite de propostas, link malicioso e filtro do resumo financeiro | `test/agent.test.js` |

```bash
cd gemini-worker
node --test        # Node 18+, sem instalar nada
```

### Decisões que vieram de testar contra a API real

- **Grounding com Google Search não serve no nível gratuito.** Nos modelos Gemini 3 a API devolveu `429` em toda chamada, até num "oi"; nos 2.5, `404 "no longer available to new users"`. A busca foi para a Tavily, chamada como uma ferramenta comum.
- **A família 3 fica congestionada com frequência**, às vezes com todos os modelos ao mesmo tempo. Com 8 perguntas seguidas, uma passada pela lista deu 4 falhas, duas passadas deram 1 falha e três passadas deram 0.
- **O erro do Google cortado em 400 caracteres escondia justamente qual cota estourou**, que fica em `error.details`. Daí o `resumirErro`.

> Construído com o [Claude Code](https://claude.com/claude-code): eu defini o produto, as regras do assistente e os testes contra a API real; o agente implementou.

---

## Por que um servidor

Para guardar a chave da API. O Norte roda inteiro no navegador e o repositório é público: uma chave ali seria lida por qualquer pessoa e usaria a sua cota. Aqui ela fica num segredo do Cloudflare e nunca chega ao navegador.

Custo total: **R$ 0**. Cloudflare Workers dá 100 mil requisições por dia no plano gratuito, e o Gemini tem nível gratuito próprio.

---

## Publicar (10 minutos)

### 1. Pegue a chave do Gemini

[aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key**. Copie e guarde — você vai colá-la no passo 4, direto no Cloudflare.

### 2. Crie a conta do Cloudflare

[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Não precisa de cartão.

### 3. Publique

No PC, dentro desta pasta:

```bash
cd gemini-worker
npx wrangler login
npx wrangler deploy
```

O `wrangler login` abre o navegador para você autorizar. Ao final, o deploy imprime a URL, algo como `https://norte-assistente.SEU-SUBDOMINIO.workers.dev`.

> Precisa do Node.js instalado. Se não tiver: [nodejs.org](https://nodejs.org) → versão LTS.

### 4. Guarde a chave como segredo

```bash
npx wrangler secret put GEMINI_API_KEY
```

Ele pergunta o valor e **não** o mostra na tela. A chave fica criptografada no Cloudflare — não entra no Git, não aparece em log, não vai para o navegador.

### 5. Confira se a chave funciona

Abra `https://SUA-URL.workers.dev/v1/diag` no navegador. Ele lista os modelos que a **sua** chave alcança:

```json
{ "ok": true, "total": 12, "models": ["gemini-3.5-flash-lite", "gemini-3.8-flash", "..."] }
```

Se vier `ok: false`, a mensagem diz o que o Google respondeu.

### 6. Ligue no app

No Norte: **Configurações → Assistente de IA → Endereço do servidor** → cole a URL do Worker (sem barra no final).

---

## A busca de preços usa a Tavily

Duas chaves, dois serviços: o **Gemini** conversa, a **Tavily** pesquisa.

A busca embutida do Gemini seria o caminho curto, e não funciona no gratuito. Isto foi medido contra a API real, não suposto:

| Tentativa | Resultado |
|---|---|
| API pública do Mercado Livre | `403` em toda chamada — o endpoint `/sites/MLB/search` foi fechado e não há substituto de catálogo |
| `google_search` nos modelos Gemini 3 | `429 RESOURCE_EXHAUSTED` em **toda** chamada, até num "oi" — exige plano pago |
| `google_search` nos modelos Gemini 2.5, onde é gratuita | `404` — "no longer available to new users" |

A Tavily dá **1.000 buscas por mês sem cartão** e devolve o texto já extraído da página. Cada pergunta de preço gasta 1 crédito.

**Configurar:** crie a chave em [tavily.com](https://tavily.com) e cadastre como **Secret** no Cloudflare com o nome `TAVILY_API_KEY`. Sem ela, a busca simplesmente não existe — e o assistente continua conversando, comentando o planejamento e montando metas com o valor que você informar, instruído a dizer que não consegue consultar preços em vez de chutar.

`SEARCH_ENABLED = "0"` desliga a busca sem apagar a chave, para quando a cota do mês acabar.

Confira em `/v1/healthz`: o campo `search` diz se ela está realmente ativa.

---

## Link e foto do produto

A busca devolve ao modelo os resultados **com a URL** e as imagens **com descrição**, e não só o texto corrido. Era essa a razão de a meta nascer sempre sem link: o endereço da loja existia na resposta e era descartado antes de chegar ao modelo.

O valor alvo é o **menor preço** entre as ofertas que são de fato o produto pedido — a ressalva importa, porque o resultado mais barato costuma ser acessório, usado ou outra capacidade.

Cada resultado é marcado com `pagina_de_busca`, um palpite pelo formato do endereço (`/busca`, `/lista`, `?q=`). Listagem de busca aberta meses depois mostra qualquer coisa; a página do produto continua a mesma. Quando o menor preço está numa listagem e há uma página de produto até 5% mais cara, o modelo usa a página de produto — acima disso, o preço menor vence.

---

## Sobre o modelo

O catálogo do Gemini muda com frequência, e o Google não publica mais quais modelos entram no nível gratuito. Em vez de fixar um nome que pode sumir, o Worker **tenta uma lista em ordem** e fica com o primeiro que a sua chave aceitar:

```
gemini-3.5-flash-lite → gemini-3.1-flash-lite → gemini-3.5-flash → gemini-3.6-flash → gemini-3.7-flash → gemini-3.8-flash
```

Para forçar um específico, edite `GEMINI_MODEL` no `wrangler.toml` e publique de novo. Use `/v1/diag` para ver as opções reais da sua conta.

> Modelos Pro ficaram fora do nível gratuito. Os Flash e Flash-Lite dão conta de sobra do que o app pede.

---

## ⚠ Privacidade: leia antes de ligar o resumo financeiro

**No nível gratuito, o Google pode usar o que você envia para treinar os modelos dele.** No plano pago, não. A exceção são usuários na União Europeia, Suíça e Reino Unido, onde vale a política do plano pago mesmo no gratuito.

Isso colide com a premissa do app, que é manter seus dados no aparelho. Na prática:

- **Perguntas de preço** ("quanto custa um iPhone 15") não revelam nada seu. Sem problema.
- **O resumo financeiro** (médias mensais e metas) é opt-in e vem **desligado**. Pense duas vezes antes de ligá-lo no nível gratuito.
- **Lançamentos, saldos por conta, anotações e agenda nunca são enviados**, nem com o resumo ligado. O Worker ainda filtra o que chega, como rede de segurança.

Se quiser o resumo ligado sem treinar modelo, ative o faturamento no Google AI Studio — o uso continua barato, mas a política muda.

---

## Rotas

| Rota | O que faz |
|---|---|
| `POST /v1/agent/chat` | Conversa com chamada de funções; responde em SSE |
| `GET /v1/diag` | Modelos que a sua chave alcança |
| `GET /v1/healthz` | Checagem simples |

> `/v1/diag` lista modelos que a API **publica**, não necessariamente os que ela **aceita**. Os 2.5 aparecem na lista e recusam a chamada. Para saber se um modelo serve, só chamando.

Eventos SSE: `text_delta`, `tool_started`, `sources`, `proposal`, `error`, `message_stop`.

O `price_result` saiu junto com a busca no Mercado Livre — ele carregava mediana, faixa e lista de ofertas, que não existem mais. Quem o substitui é o `sources`, com os links que fundamentaram a resposta.

---

## Limites e erros

O nível gratuito do Gemini tem teto de requisições por minuto e por dia, que variam por modelo e por projeto — veja os seus em [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit). Ao estourar, a API devolve 429 e o app mostra "o limite gratuito foi atingido, tente em alguns minutos".

O `ALLOWED_ORIGINS` do `wrangler.toml` restringe quem pode chamar o Worker. Se você mudar o endereço do app, atualize lá e publique de novo — senão o navegador bloqueia por CORS.

---

## Estado dos testes

Automáticos: `node --test` (10 testes, sem rede).

Rodado contra a API real em 08/10/2026, com a chave já configurada:

- ✅ conversa, com escolha automática de modelo (caiu em `gemini-3.8-flash`)
- ✅ chamada de funções — o schema está correto
- ✅ `propor_meta` desenha o cartão com o valor informado pelo usuário
- ✅ recusa a inventar preço quando a busca está desligada
- ✅ `/v1/diag` e `/v1/healthz`
- ✅ busca de preço pela Tavily — faixa, fontes citadas e meta proposta

Uma ressalva sobre a qualidade da busca: ela traz variantes junto (o Pro, o de 256GB, aparelhos usados), e a faixa relatada às vezes esticava até um valor que era de outro produto. O prompt instrui a descartar esses destoantes e a usar o preço mais típico — não a média entre o menor e o maior — mas a decisão final é do modelo. **Confira o valor antes de confirmar a meta.**

### Congestionamento do Gemini

Os modelos da família 3 respondem `503 "experiencing high demand"` com frequência, às vezes **todos ao mesmo tempo**. Por isso `callWithFallback` percorre a lista de modelos três vezes, com pausa entre as passadas. Medido com 8 perguntas seguidas: 1 passada → 4 falhas, 2 passadas → 1 falha, 3 passadas → nenhuma.

Se mesmo assim falhar, a mensagem diz que é congestionamento, não configuração — para você não sair procurando o que quebrou.

Para depurar: `npx wrangler tail norte-assistente`. As falhas da API do Gemini são registradas já resumidas (status, cota, mensagem), porque o corpo bruto não cabe numa linha de log.
