/**
 * Persistência em IndexedDB.
 *
 * Por que IndexedDB e não localStorage: localStorage é síncrono (trava a
 * interface), limitado a ~5 MB e guarda só string. IndexedDB guarda objetos,
 * é assíncrono e tem cota bem maior.
 *
 * ⚠ Os dados vivem **só neste aparelho e neste navegador**. A Apple afirma
 * que o apagamento automático de 7 dias não vale para web apps na tela de
 * início, mas há relatos de desenvolvedores em contrário e nenhuma garantia
 * documentada. Por isso: `navigator.storage.persist()` no boot, e o backup
 * é tratado como funcionalidade central, não como extra (ver backup.js).
 */

const DB_NAME = 'norte';
// v2 acrescentou `externalEvents` (agendas importadas).
// v3 acrescentou `outbox` (fila de sincronização com o Supabase).
// Subir a versão é o que dispara a criação do store novo em quem já tinha o
// app instalado.
const DB_VERSION = 3;

/** Cada coleção vira um object store com chave `id`. */
export const STORES = [
  'accounts',
  'categories',
  'transactions',
  'plans',
  'goals',
  'contributions',
  'notes',
  'events',
  'externalEvents',
  'quotes',
  'meta',
  'outbox',
];

/**
 * Coleções que sobem para o Supabase.
 *
 * Ficam de fora: `externalEvents` (espelho de uma agenda de terceiros, que se
 * refaz sozinho a cada sincronização), `quotes` (resquício da busca de preços
 * antiga, hoje sem uso), `meta` (preferências, que sobem por outro caminho) e
 * `outbox` (a própria fila).
 */
export const SYNCED_STORES = [
  'accounts',
  'categories',
  'plans',
  'goals',
  'transactions',
  'contributions',
  'notes',
  'events',
];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    // O IndexedDB pode simplesmente não responder: basta um pedido de
    // exclusão ou de upgrade pendente em outra aba para a abertura ficar
    // esperando para sempre, sem erro e sem `onblocked`. Sem este limite, o
    // app fica com a tela em branco e nenhuma pista do motivo.
    const limite = setTimeout(() => {
      dbPromise = null;
      reject(new Error(
        'O banco de dados não respondeu. Isso costuma acontecer quando o app '
        + 'está aberto em outra aba. Feche as demais e tente de novo.',
      ));
    }, 8000);

    const concluir = (fn) => (...args) => { clearTimeout(limite); fn(...args); };

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const keyPath = name === 'meta' || name === 'outbox' ? 'key' : 'id';
        db.createObjectStore(name, { keyPath });
      }
    };

    request.onsuccess = concluir(() => {
      const db = request.result;

      // Quando uma aba nova precisar subir a versão do banco, esta conexão
      // precisa sair da frente sozinha — senão a outra aba trava esperando.
      // Sem isto, abrir o app no Safari e pelo ícone ao mesmo tempo, numa
      // atualização que muda o schema, deixa um dos dois sem funcionar.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };

      resolve(db);
    });

    request.onerror = concluir(() => reject(request.error));

    request.onblocked = concluir(() => reject(new Error(
      'O banco está aberto em outra aba com uma versão anterior do app. '
      + 'Feche as outras abas do Norte e recarregue esta.',
    )));
  });

  return dbPromise;
}

function tx(db, stores, mode) {
  const transaction = db.transaction(stores, mode);
  return {
    transaction,
    done: new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Transação abortada'));
    }),
  };
}

function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(store) {
  const db = await openDB();
  const { transaction } = tx(db, [store], 'readonly');
  return toPromise(transaction.objectStore(store).getAll());
}

/**
 * Marca um registro como pendente de envio ao servidor.
 *
 * A fila fica aqui, dentro do `db.js`, e não em cada tela, por um motivo
 * prático: existem dezenas de pontos que gravam dados, e bastaria esquecer
 * um para aquele tipo de registro nunca sincronizar — uma falha silenciosa,
 * que só apareceria quando faltasse justamente aquele dado no outro
 * aparelho. Passando tudo por aqui, não há como esquecer.
 *
 * A exclusão precisa entrar na fila pelo mesmo motivo. Se o celular apaga um
 * lançamento e o servidor nunca fica sabendo, a próxima sincronização traz o
 * registro de volta — ele ressuscita.
 *
 * `silent` é usado pela própria sincronização ao aplicar o que veio do
 * servidor: sem isso, receber uma mudança criaria uma pendência de reenvio
 * dela mesma, em laço.
 */
function enfileirar(objectStore, store, id, op) {
  objectStore.put({ key: `${store}:${id}`, store, id, op, at: new Date().toISOString() });
}

/** Stores envolvidos numa escrita — inclui a fila quando o registro sincroniza. */
function alvos(store, silent) {
  return !silent && SYNCED_STORES.includes(store) ? [store, 'outbox'] : [store];
}

export async function put(store, value, { silent = false } = {}) {
  const db = await openDB();
  const stores = alvos(store, silent);
  const { transaction, done } = tx(db, stores, 'readwrite');
  transaction.objectStore(store).put(value);
  if (stores.length > 1) enfileirar(transaction.objectStore('outbox'), store, value.id, 'upsert');
  await done;
  return value;
}

/** Grava vários registros em uma única transação — usado pelo parcelamento. */
export async function putMany(store, values, { silent = false } = {}) {
  if (values.length === 0) return;
  const db = await openDB();
  const stores = alvos(store, silent);
  const { transaction, done } = tx(db, stores, 'readwrite');
  const objectStore = transaction.objectStore(store);
  const fila = stores.length > 1 ? transaction.objectStore('outbox') : null;
  for (const value of values) {
    objectStore.put(value);
    if (fila) enfileirar(fila, store, value.id, 'upsert');
  }
  await done;
}

export async function remove(store, id, { silent = false } = {}) {
  const db = await openDB();
  const stores = alvos(store, silent);
  const { transaction, done } = tx(db, stores, 'readwrite');
  transaction.objectStore(store).delete(id);
  if (stores.length > 1) enfileirar(transaction.objectStore('outbox'), store, id, 'delete');
  await done;
}

export async function removeMany(store, ids, { silent = false } = {}) {
  if (ids.length === 0) return;
  const db = await openDB();
  const stores = alvos(store, silent);
  const { transaction, done } = tx(db, stores, 'readwrite');
  const objectStore = transaction.objectStore(store);
  const fila = stores.length > 1 ? transaction.objectStore('outbox') : null;
  for (const id of ids) {
    objectStore.delete(id);
    if (fila) enfileirar(fila, store, id, 'delete');
  }
  await done;
}

// ---------------------------------------------------------------------------
// Fila de sincronização
// ---------------------------------------------------------------------------

export async function outboxAll() {
  return getAll('outbox');
}

export async function outboxClear(keys) {
  if (keys.length === 0) return;
  const db = await openDB();
  const { transaction, done } = tx(db, ['outbox'], 'readwrite');
  const objectStore = transaction.objectStore('outbox');
  for (const key of keys) objectStore.delete(key);
  await done;
}

/**
 * Enfileira tudo o que já existe no aparelho.
 *
 * Roda uma vez, no primeiro login: os dados criados antes da sincronização
 * existir nunca passaram pela fila e, sem isto, ficariam presos aqui para
 * sempre enquanto o servidor seguisse vazio.
 */
export async function outboxSeedExisting() {
  const db = await openDB();
  const { transaction, done } = tx(db, [...SYNCED_STORES, 'outbox'], 'readwrite');
  const fila = transaction.objectStore('outbox');

  await Promise.all(SYNCED_STORES.map(async (store) => {
    const registros = await toPromise(transaction.objectStore(store).getAll());
    for (const registro of registros) enfileirar(fila, store, registro.id, 'upsert');
  }));

  await done;
}

export async function clearStore(store) {
  const db = await openDB();
  const { transaction, done } = tx(db, [store], 'readwrite');
  transaction.objectStore(store).clear();
  await done;
}

export async function clearAll() {
  const db = await openDB();
  const { transaction, done } = tx(db, STORES, 'readwrite');
  for (const name of STORES) transaction.objectStore(name).clear();
  await done;
}

export async function getMeta(key, fallback = null) {
  const db = await openDB();
  const { transaction } = tx(db, ['meta'], 'readonly');
  const record = await toPromise(transaction.objectStore('meta').get(key));
  return record?.value ?? fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

/** Lê tudo de uma vez — o app mantém o estado em memória (ver store.js). */
export async function readEverything() {
  const db = await openDB();
  const { transaction } = tx(db, STORES, 'readonly');
  const result = {};
  await Promise.all(
    STORES.map(async (name) => {
      result[name] = await toPromise(transaction.objectStore(name).getAll());
    }),
  );
  return result;
}

/**
 * Pede ao navegador para não despejar nossos dados.
 *
 * No iOS a chamada costuma devolver `false` sem prompt, e isso não é erro:
 * só significa que o navegador não promete nada. Ainda assim vale pedir, e
 * vale registrar o resultado para o usuário poder ver em Configurações.
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  try {
    const already = await navigator.storage.persisted?.();
    const persisted = already || (await navigator.storage.persist());
    return { supported: true, persisted };
  } catch {
    return { supported: true, persisted: false };
  }
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return null;
  }
}

export function newId() {
  // `randomUUID` exige contexto seguro (https ou localhost) — o mesmo que o
  // service worker já exige, então o fallback quase nunca roda.
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
