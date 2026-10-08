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
// v2 acrescentou `externalEvents` (agendas importadas). Subir a versão é o
// que dispara a criação do store novo em quem já tinha o app instalado.
const DB_VERSION = 2;

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
        const keyPath = name === 'meta' ? 'key' : 'id';
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

export async function put(store, value) {
  const db = await openDB();
  const { transaction, done } = tx(db, [store], 'readwrite');
  transaction.objectStore(store).put(value);
  await done;
  return value;
}

/** Grava vários registros em uma única transação — usado pelo parcelamento. */
export async function putMany(store, values) {
  if (values.length === 0) return;
  const db = await openDB();
  const { transaction, done } = tx(db, [store], 'readwrite');
  const objectStore = transaction.objectStore(store);
  for (const value of values) objectStore.put(value);
  await done;
}

export async function remove(store, id) {
  const db = await openDB();
  const { transaction, done } = tx(db, [store], 'readwrite');
  transaction.objectStore(store).delete(id);
  await done;
}

export async function removeMany(store, ids) {
  if (ids.length === 0) return;
  const db = await openDB();
  const { transaction, done } = tx(db, [store], 'readwrite');
  const objectStore = transaction.objectStore(store);
  for (const id of ids) objectStore.delete(id);
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
