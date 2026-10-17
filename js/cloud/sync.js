/**
 * Sincronização entre o aparelho e o Supabase.
 *
 * O desenho é **local primeiro**: o IndexedDB continua sendo de onde o app lê
 * para desenhar a tela, e o Supabase é onde os dados moram de verdade. Isso
 * mantém o app funcionando sem internet — ele vive na tela de início de um
 * celular, e um app que mostra tela branca no elevador não serve.
 *
 * O ciclo é:
 *   1. `puxar()`  — traz do servidor o que mudou desde a última vez
 *   2. `empurrar()` — envia o que foi criado, alterado ou apagado aqui
 *
 * Conflito é resolvido por "o mais recente vence", usando o `updated_at` que
 * o próprio banco carimba. Não é perfeito: editar a mesma meta nos dois
 * aparelhos no mesmo minuto faz uma das edições sumir inteira. A alternativa
 * seria mesclar campo a campo, o que exige guardar histórico e ainda assim
 * erra — para um app pessoal, o custo não se paga.
 */

import * as db from '../db.js';
import { getClient } from './client.js';

// ---------------------------------------------------------------------------
// De/para entre o app e o banco
// ---------------------------------------------------------------------------

/**
 * Colunas enviadas por tabela, na ordem em que as tabelas precisam subir.
 *
 * A ordem importa: `transactions` aponta para `accounts` e `plans`, e
 * `contributions` aponta para `goals` e `transactions`. Enviar um filho antes
 * do pai faz o banco recusar a linha por chave estrangeira.
 *
 * A lista é explícita, e não "tudo o que o objeto tiver", de propósito: o app
 * carrega campos que não têm coluna (uma meta antiga guarda `quoteId`, da
 * busca de preços que foi removida). Mandar um campo desconhecido faz o
 * PostgREST recusar o registro inteiro.
 */
const TABELAS = [
  ['accounts', ['id', 'name', 'kind', 'initialBalanceCents', 'color', 'archived', 'sortOrder', 'createdAt']],
  ['categories', ['id', 'name', 'icon', 'color', 'kind', 'sortOrder', 'createdAt']],
  ['plans', ['id', 'title', 'totalCents', 'count', 'firstDueDate', 'intervalMonths', 'createdAt']],
  ['goals', ['id', 'title', 'targetCents', 'targetDate', 'priority', 'status', 'productURL', 'imageURL', 'notes', 'createdAt']],
  ['transactions', ['id', 'title', 'amountCents', 'kind', 'date', 'accountId', 'destinationAccountId',
    'categoryId', 'notes', 'paid', 'paidAt', 'installmentIndex', 'installmentCount', 'planId', 'goalId', 'createdAt']],
  ['contributions', ['id', 'goalId', 'amountCents', 'date', 'note', 'transactionId', 'createdAt']],
  ['notes', ['id', 'title', 'body', 'tags', 'createdAt', 'updatedAt']],
  ['events', ['id', 'title', 'date', 'time', 'notes', 'reminderMinutes', 'createdAt']],
];

/** Nome da tabela no banco para cada coleção local (hoje são iguais). */
const tabelaDe = (store) => store;

/**
 * Campos cuja conversão automática erraria.
 *
 * `productURL` viraria `product_u_r_l` na regra geral, porque a sigla tem
 * três maiúsculas seguidas. E `updatedAt` da anotação é o "editado em" que o
 * usuário vê, que não é o carimbo de sincronização de mesmo nome.
 */
const EXCECOES = {
  productURL: 'product_url',
  imageURL: 'image_url',
  'notes.updatedAt': 'edited_at',
};

function paraColuna(store, campo) {
  return EXCECOES[`${store}.${campo}`]
    ?? EXCECOES[campo]
    ?? campo.replace(/[A-Z]/g, (letra) => `_${letra.toLowerCase()}`);
}

function paraRemoto(store, registro, campos) {
  const saida = {};
  for (const campo of campos) {
    if (registro[campo] === undefined) continue;
    saida[paraColuna(store, campo)] = registro[campo];
  }
  return saida;
}

function paraLocal(store, linha, campos) {
  const saida = {};
  for (const campo of campos) {
    const valor = linha[paraColuna(store, campo)];
    if (valor !== undefined && valor !== null) saida[campo] = valor;
  }
  // Campos que o app espera como `null` explícito, não ausentes.
  for (const campo of ['destinationAccountId', 'categoryId', 'planId', 'goalId',
    'paidAt', 'targetDate', 'productURL', 'imageURL', 'transactionId', 'time']) {
    if (campos.includes(campo) && saida[campo] === undefined) saida[campo] = null;
  }
  return saida;
}

// ---------------------------------------------------------------------------
// Estado da sincronização
// ---------------------------------------------------------------------------

const CHAVE_ULTIMO_PULL = 'sync.lastPulledAt';
const CHAVE_SEMEADO = 'sync.seeded';

/** Uma data antes de qualquer registro, para a primeira sincronização. */
const INICIO_DOS_TEMPOS = '1970-01-01T00:00:00Z';

let rodando = false;

// ---------------------------------------------------------------------------
// Puxar
// ---------------------------------------------------------------------------

/**
 * Preferências — tabela `settings`, formato próprio.
 *
 * Não cabe no laço das outras tabelas: ali cada linha é um registro com
 * `id`, aqui é um par chave/valor com chave composta (usuário + chave). O
 * valor vai como JSON, então texto, número e booleano voltam com o mesmo
 * tipo com que saíram.
 */
async function puxarConfiguracoes(client, desde) {
  const { data, error } = await client
    .from('settings')
    .select('key, value, updated_at')
    .gt('updated_at', desde);

  if (error) throw new Error(`Falha ao baixar configurações: ${error.message}`);

  for (const linha of data ?? []) {
    if (!db.configuracaoSincroniza(linha.key)) continue;
    await db.setMeta(linha.key, linha.value, { silent: true });
  }
  return (data ?? []).length;
}

async function empurrarConfiguracoes(client, pendentes, userId) {
  if (pendentes.length === 0) return [];

  const todas = await db.getAll('meta');
  const porChave = new Map(todas.map((m) => [m.key, m.value]));

  const linhas = pendentes
    .filter((item) => porChave.has(item.id))
    .map((item) => ({ user_id: userId, key: item.id, value: porChave.get(item.id) ?? null }));

  if (linhas.length === 0) return pendentes.map((i) => i.key);

  // `user_id` vai explícito, e não pela coluna com default: o alvo do
  // conflito é a chave composta (user_id, key), e o Postgres precisa dos
  // dois valores para saber se está atualizando ou inserindo.
  const { error } = await client.from('settings').upsert(linhas, { onConflict: 'user_id,key' });
  if (error) throw new Error(`Falha ao enviar configurações: ${error.message}`);

  return pendentes.map((i) => i.key);
}

async function puxar(client) {
  const desde = await db.getMeta(CHAVE_ULTIMO_PULL, INICIO_DOS_TEMPOS);
  // O relógio do servidor é o que vale. Pegamos o instante ANTES de ler, para
  // que uma linha gravada durante a leitura entre na próxima rodada em vez de
  // ser pulada para sempre.
  const agora = new Date().toISOString();
  let recebidos = 0;

  for (const [store, campos] of TABELAS) {
    const { data, error } = await client
      .from(tabelaDe(store))
      .select('*')
      .gt('updated_at', desde)
      .order('updated_at', { ascending: true });

    if (error) throw new Error(`Falha ao baixar ${store}: ${error.message}`);

    const apagados = data.filter((linha) => linha.deleted_at);
    const vivos = data.filter((linha) => !linha.deleted_at);

    // `silent` evita o laço: aplicar o que veio do servidor não pode gerar
    // uma pendência de reenviar aquilo de volta.
    await db.removeMany(store, apagados.map((l) => l.id), { silent: true });
    await db.putMany(store, vivos.map((l) => paraLocal(store, l, campos)), { silent: true });

    recebidos += data.length;
  }

  recebidos += await puxarConfiguracoes(client, desde);

  await db.setMeta(CHAVE_ULTIMO_PULL, agora);
  return recebidos;
}

// ---------------------------------------------------------------------------
// Empurrar
// ---------------------------------------------------------------------------

async function empurrar(client, userId) {
  const fila = await db.outboxAll();
  if (fila.length === 0) return 0;

  const tudo = await db.readEverything();
  const concluidos = [];

  for (const [store, campos] of TABELAS) {
    const pendentes = fila.filter((item) => item.store === store);
    if (pendentes.length === 0) continue;

    const porId = new Map(tudo[store].map((r) => [r.id, r]));

    const upserts = [];
    const exclusoes = [];
    for (const item of pendentes) {
      const registro = porId.get(item.id);
      // Se o registro sumiu do aparelho, a pendência é exclusão mesmo que a
      // fila diga outra coisa — o estado atual manda.
      if (item.op === 'delete' || !registro) exclusoes.push(item);
      else upserts.push({ item, registro });
    }

    if (upserts.length) {
      const { error } = await client
        .from(tabelaDe(store))
        .upsert(upserts.map(({ registro }) => paraRemoto(store, registro, campos)), { onConflict: 'id' });
      if (error) throw new Error(`Falha ao enviar ${store}: ${error.message}`);
      concluidos.push(...upserts.map(({ item }) => item.key));
    }

    if (exclusoes.length) {
      // Exclusão é marcação, não remoção. Apagar de verdade faria o registro
      // voltar: o outro aparelho, que nunca soube da exclusão, reenviaria.
      const { error } = await client
        .from(tabelaDe(store))
        .update({ deleted_at: new Date().toISOString() })
        .in('id', exclusoes.map((i) => i.id));
      if (error) throw new Error(`Falha ao excluir em ${store}: ${error.message}`);
      concluidos.push(...exclusoes.map((i) => i.key));
    }
  }

  concluidos.push(...await empurrarConfiguracoes(
    client,
    fila.filter((item) => item.store === 'meta'),
    userId,
  ));

  await db.outboxClear(concluidos);
  return concluidos.length;
}

// ---------------------------------------------------------------------------
// Primeira vez
// ---------------------------------------------------------------------------

/**
 * Envia para o servidor os dados que já existiam neste aparelho.
 *
 * Só acontece com o servidor **vazio**. Se já houver qualquer coisa lá, estes
 * dados locais podem ser uma cópia velha — subi-los sobrescreveria o que
 * outro aparelho gravou depois, e o usuário veria dados reaparecerem como
 * eram semanas atrás. Nesse caso o servidor manda, e o `puxar()` cuida.
 */
async function semearSeServidorVazio(client) {
  if (await db.getMeta(CHAVE_SEMEADO, false)) return false;

  for (const [store] of TABELAS) {
    const { count, error } = await client
      .from(tabelaDe(store))
      .select('id', { count: 'exact', head: true });
    if (error) throw new Error(`Falha ao conferir ${store}: ${error.message}`);
    if (count > 0) {
      await db.setMeta(CHAVE_SEMEADO, true);
      return false;
    }
  }

  await db.outboxSeedExisting();
  await db.setMeta(CHAVE_SEMEADO, true);
  return true;
}

/**
 * Sobe as preferências que já existiam antes de elas passarem a sincronizar.
 *
 * `semearSeServidorVazio` roda uma vez e só; quem já tinha usado o app antes
 * desta mudança já tinha passado por lá, com o servidor cheio de lançamentos
 * e vazio de configurações. Sem este empurrão, o endereço do assistente
 * digitado no celular ficaria preso nele até alguém reescrevê-lo — e a
 * queixa que originou tudo isto continuaria valendo para quem já usava.
 *
 * Roda uma vez por aparelho, controlado pela própria chave.
 */
const CHAVE_CONFIGS_SEMEADAS = 'sync.settingsSeeded';

async function semearConfiguracoesExistentes() {
  if (await db.getMeta(CHAVE_CONFIGS_SEMEADAS, false)) return 0;

  let enfileiradas = 0;
  for (const { key, value } of await db.getAll('meta')) {
    if (!db.configuracaoSincroniza(key) || value === undefined) continue;
    // Regravar com o mesmo valor é o que coloca a chave na fila de envio.
    await db.setMeta(key, value);
    enfileiradas += 1;
  }

  await db.setMeta(CHAVE_CONFIGS_SEMEADAS, true, { silent: true });
  return enfileiradas;
}

// ---------------------------------------------------------------------------
// Entrada pública
// ---------------------------------------------------------------------------

/**
 * Uma rodada completa. Devolve o que aconteceu, para a interface contar.
 *
 * Empurrar vem depois de puxar de propósito: assim uma alteração feita aqui,
 * que é a mais recente, não é sobrescrita por uma versão mais antiga do
 * servidor que acabou de chegar.
 */
export async function sincronizar() {
  if (rodando) return { pulado: true };
  rodando = true;

  try {
    const client = await getClient();

    // As preferências usam chave composta (usuário + chave), então o id
    // precisa ir explícito no upsert — a coluna com default não serve para
    // o Postgres resolver o conflito.
    const { data: sessao } = await client.auth.getSession();
    const userId = sessao?.session?.user?.id;
    if (!userId) throw new Error('Sem sessão para sincronizar.');

    const semeado = await semearSeServidorVazio(client);
    await semearConfiguracoesExistentes();
    const recebidos = await puxar(client);
    const enviados = await empurrar(client, userId);
    return { recebidos, enviados, semeado };
  } finally {
    rodando = false;
  }
}

/** Quantas alterações estão esperando para subir. */
export async function pendencias() {
  return (await db.outboxAll()).length;
}

/**
 * Apaga a cópia local.
 *
 * Chamado ao sair da conta: num computador compartilhado, deixar os dados no
 * IndexedDB significaria que o próximo a abrir o app veria tudo sem precisar
 * de senha. O servidor continua intacto.
 */
export async function limparCopiaLocal() {
  for (const store of db.SYNCED_STORES) await db.clearStore(store);
  await db.clearStore('outbox');

  // As preferências também saem. Elas agora pertencem à conta, não ao
  // aparelho: deixar o endereço do assistente de quem saiu entregaria a
  // configuração dele para o próximo a entrar no mesmo computador. Voltam
  // sozinhas na primeira sincronização de quem logar.
  for (const { key } of await db.getAll('meta')) {
    // `remove` e não `setMeta(key, undefined)`: o segundo deixaria a chave
    // existindo com valor vazio, e `state.settings` passaria a ter campos
    // que respondem `undefined` em vez de simplesmente não existirem.
    if (db.configuracaoSincroniza(key)) await db.remove('meta', key);
  }

  await db.setMeta(CHAVE_ULTIMO_PULL, INICIO_DOS_TEMPOS, { silent: true });
  await db.setMeta(CHAVE_SEMEADO, false, { silent: true });
}
