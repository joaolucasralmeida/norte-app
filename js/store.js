/**
 * Estado da aplicação.
 *
 * Tudo é carregado do IndexedDB uma vez no boot e mantido em memória: um
 * usuário pessoal tem milhares de registros, não milhões, e com o conjunto
 * inteiro na mão a renderização fica trivial e instantânea. Toda escrita
 * grava no banco **e** atualiza o estado, nessa ordem.
 */

import * as db from './db.js';
import { planInstallments, planFromInstallmentAmount } from './domain.js';
import { todayISO } from './format.js';

export const state = {
  accounts: [],
  categories: [],
  transactions: [],
  plans: [],
  goals: [],
  contributions: [],
  notes: [],
  events: [],
  /** Eventos vindos de agendas externas (Google ao vivo, ou .ics importado). */
  externalEvents: [],
  quotes: [],
  settings: {},
  storage: { supported: false, persisted: false },
};

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(state);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function load() {
  const data = await db.readEverything();

  state.accounts = data.accounts ?? [];
  state.categories = data.categories ?? [];
  state.transactions = data.transactions ?? [];
  state.plans = data.plans ?? [];
  state.goals = data.goals ?? [];
  state.contributions = data.contributions ?? [];
  state.notes = data.notes ?? [];
  state.events = data.events ?? [];
  state.externalEvents = data.externalEvents ?? [];
  state.quotes = data.quotes ?? [];
  state.settings = Object.fromEntries((data.meta ?? []).map((m) => [m.key, m.value]));

  if (state.accounts.length === 0 && state.categories.length === 0) {
    await seedDefaults();
  }

  state.storage = await db.requestPersistentStorage();
  emit();
}

export async function setSetting(key, value) {
  state.settings[key] = value;
  await db.setMeta(key, value);
  emit();
}

// ---------------------------------------------------------------------------
// Contas e categorias
// ---------------------------------------------------------------------------

const DEFAULT_EXPENSES = [
  ['Moradia', '🏠', '#2563EB'], ['Mercado', '🛒', '#10B981'], ['Transporte', '🚗', '#F59E0B'],
  ['Alimentação', '🍽️', '#EF4444'], ['Saúde', '⚕️', '#EC4899'], ['Educação', '📚', '#8B5CF6'],
  ['Lazer', '🎮', '#06B6D4'], ['Vestuário', '👕', '#F97316'], ['Assinaturas', '🔁', '#6366F1'],
  ['Contas', '📄', '#64748B'], ['Pets', '🐾', '#84CC16'], ['Outros', '•••', '#9CA3AF'],
];

const DEFAULT_INCOMES = [
  ['Salário', '💼', '#10B981'], ['Freelance', '💻', '#14B8A6'],
  ['Rendimentos', '📈', '#22C55E'], ['Outros', '•••', '#9CA3AF'],
];

async function seedDefaults() {
  const categories = [
    ...DEFAULT_EXPENSES.map(([name, icon, color], i) => ({
      id: db.newId(), name, icon, color, kind: 'expense', sortOrder: i,
    })),
    ...DEFAULT_INCOMES.map(([name, icon, color], i) => ({
      id: db.newId(), name, icon, color, kind: 'income', sortOrder: i,
    })),
  ];

  const accounts = [
    { id: db.newId(), name: 'Conta corrente', kind: 'checking', initialBalanceCents: 0, color: '#2563EB', archived: false, sortOrder: 0 },
    { id: db.newId(), name: 'Dinheiro', kind: 'cash', initialBalanceCents: 0, color: '#10B981', archived: false, sortOrder: 1 },
    { id: db.newId(), name: 'Reserva de metas', kind: 'goal_reserve', initialBalanceCents: 0, color: '#8B5CF6', archived: false, sortOrder: 2 },
  ];

  await db.putMany('categories', categories);
  await db.putMany('accounts', accounts);
  state.categories = categories;
  state.accounts = accounts;
}

export async function saveAccount(account) {
  const record = { sortOrder: state.accounts.length, archived: false, ...account, id: account.id ?? db.newId() };
  await db.put('accounts', record);
  upsert(state.accounts, record);
  emit();
  return record;
}

export async function deleteAccount(id) {
  // Conta com lançamento não some: sumiria o histórico junto. Arquiva.
  const hasTransactions = state.transactions.some((t) => t.accountId === id);
  if (hasTransactions) {
    const account = state.accounts.find((a) => a.id === id);
    if (account) await saveAccount({ ...account, archived: true });
    return { archived: true };
  }
  await db.remove('accounts', id);
  state.accounts = state.accounts.filter((a) => a.id !== id);
  emit();
  return { archived: false };
}

export async function saveCategory(category) {
  const record = { sortOrder: state.categories.length, ...category, id: category.id ?? db.newId() };
  await db.put('categories', record);
  upsert(state.categories, record);
  emit();
  return record;
}

// ---------------------------------------------------------------------------
// Transações
// ---------------------------------------------------------------------------

export async function saveTransaction(input) {
  const record = {
    id: input.id ?? db.newId(),
    title: (input.title ?? '').trim() || 'Lançamento',
    amountCents: input.amountCents,
    kind: input.kind,
    date: input.date ?? todayISO(),
    accountId: input.accountId,
    destinationAccountId: input.destinationAccountId ?? null,
    categoryId: input.categoryId ?? null,
    notes: input.notes ?? '',
    paid: Boolean(input.paid),
    paidAt: input.paid ? (input.paidAt ?? todayISO()) : null,
    installmentIndex: input.installmentIndex ?? 0,
    installmentCount: input.installmentCount ?? 0,
    planId: input.planId ?? null,
    goalId: input.goalId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  if (record.amountCents <= 0) throw new Error('Informe um valor maior que zero.');
  if (!record.accountId) throw new Error('Escolha uma conta para o lançamento.');
  if (record.kind === 'transfer') {
    if (!record.destinationAccountId || record.destinationAccountId === record.accountId) {
      throw new Error('Escolha uma conta de destino diferente da origem.');
    }
    record.categoryId = null;
  }

  await db.put('transactions', record);
  upsert(state.transactions, record);
  emit();
  return record;
}

/**
 * Cria o plano e as N parcelas numa transação só.
 * Cada parcela vira automaticamente um evento no Calendário — mas aqui isso
 * é derivado, não gravado (ver `derivedEvents`), então não há como duplicar.
 */
export async function saveInstallmentPlan({
  title, totalCents, installmentCents, count, firstDueDate, intervalMonths,
  accountId, categoryId, entersInstallmentValue,
}) {
  const installments = entersInstallmentValue
    ? planFromInstallmentAmount(installmentCents, count, firstDueDate, intervalMonths)
    : planInstallments(totalCents, count, firstDueDate, intervalMonths);

  const plan = {
    id: db.newId(),
    title: title.trim(),
    totalCents: installments.reduce((sum, i) => sum + i.amountCents, 0),
    count,
    firstDueDate,
    intervalMonths,
    createdAt: new Date().toISOString(),
  };

  const transactions = installments.map((installment) => ({
    id: db.newId(),
    title: plan.title,
    amountCents: installment.amountCents,
    kind: 'expense',
    date: installment.dueDate,
    accountId,
    destinationAccountId: null,
    categoryId: categoryId ?? null,
    notes: '',
    paid: false,
    paidAt: null,
    installmentIndex: installment.index,
    installmentCount: installment.count,
    planId: plan.id,
    goalId: null,
    createdAt: new Date().toISOString(),
  }));

  await db.put('plans', plan);
  await db.putMany('transactions', transactions);

  state.plans.push(plan);
  state.transactions.push(...transactions);
  emit();
  return { plan, transactions };
}

export async function togglePaid(id) {
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx) return;
  const updated = { ...tx, paid: !tx.paid, paidAt: !tx.paid ? todayISO() : null };
  await db.put('transactions', updated);
  upsert(state.transactions, updated);
  emit();
}

export async function deleteTransaction(id) {
  await db.remove('transactions', id);
  state.transactions = state.transactions.filter((t) => t.id !== id);
  emit();
}

/** Exclui as parcelas **não pagas** de um plano; as pagas viram avulsas. */
export async function deletePlan(planId) {
  const ofPlan = state.transactions.filter((t) => t.planId === planId);
  const unpaid = ofPlan.filter((t) => !t.paid);
  const paid = ofPlan.filter((t) => t.paid);

  await db.removeMany('transactions', unpaid.map((t) => t.id));
  const detached = paid.map((t) => ({ ...t, planId: null }));
  await db.putMany('transactions', detached);
  await db.remove('plans', planId);

  const removedIds = new Set(unpaid.map((t) => t.id));
  state.transactions = state.transactions.filter((t) => !removedIds.has(t.id));
  for (const t of detached) upsert(state.transactions, t);
  state.plans = state.plans.filter((p) => p.id !== planId);
  emit();

  return { removed: unpaid.length, kept: paid.length };
}

// ---------------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------------

export async function saveGoal(input) {
  const record = {
    id: input.id ?? db.newId(),
    title: (input.title ?? '').trim(),
    targetCents: input.targetCents,
    targetDate: input.targetDate || null,
    priority: input.priority ?? 2,
    status: input.status ?? 'active',
    productURL: input.productURL || null,
    imageURL: input.imageURL || null,
    notes: input.notes ?? '',
    quoteId: input.quoteId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  if (!record.title) throw new Error('Dê um nome para a meta.');
  if (!record.targetCents || record.targetCents <= 0) throw new Error('Informe o valor alvo.');

  await db.put('goals', record);
  upsert(state.goals, record);
  emit();
  return record;
}

export async function deleteGoal(id) {
  const ids = state.contributions.filter((c) => c.goalId === id).map((c) => c.id);
  await db.removeMany('contributions', ids);
  await db.remove('goals', id);
  state.contributions = state.contributions.filter((c) => c.goalId !== id);
  state.goals = state.goals.filter((g) => g.id !== id);
  emit();
}

/**
 * Registra um aporte. Com `fromAccountId`, cria também a transferência
 * correspondente no financeiro — o dinheiro sai de uma conta de verdade.
 */
export async function addContribution({ goalId, amountCents, date, note, fromAccountId }) {
  if (!amountCents || amountCents <= 0) throw new Error('Informe um valor maior que zero.');

  const contribution = {
    id: db.newId(),
    goalId,
    amountCents,
    date: date ?? todayISO(),
    note: note ?? '',
    transactionId: null,
    createdAt: new Date().toISOString(),
  };

  if (fromAccountId) {
    const goal = state.goals.find((g) => g.id === goalId);
    const reserve = state.accounts.find((a) => a.kind === 'goal_reserve');
    const transaction = await saveTransaction({
      title: `Aporte meta ${goal?.title ?? ''}`.trim(),
      amountCents,
      kind: 'transfer',
      date: contribution.date,
      accountId: fromAccountId,
      destinationAccountId: reserve?.id ?? fromAccountId,
      paid: true,
      goalId,
    });
    contribution.transactionId = transaction.id;
  }

  await db.put('contributions', contribution);
  state.contributions.push(contribution);

  // Meta batida vira "achieved" na hora, sem o usuário precisar fazer nada.
  const goal = state.goals.find((g) => g.id === goalId);
  const total = state.contributions
    .filter((c) => c.goalId === goalId)
    .reduce((sum, c) => sum + c.amountCents, 0);

  if (goal && goal.status === 'active' && total >= goal.targetCents) {
    await saveGoal({ ...goal, status: 'achieved' });
  }

  emit();
  return contribution;
}

export async function deleteContribution(id) {
  const contribution = state.contributions.find((c) => c.id === id);
  if (contribution?.transactionId) await deleteTransaction(contribution.transactionId);
  await db.remove('contributions', id);
  state.contributions = state.contributions.filter((c) => c.id !== id);
  emit();
}

export function contributionsOf(goalId) {
  return state.contributions
    .filter((c) => c.goalId === goalId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------------------
// Diário
// ---------------------------------------------------------------------------

export async function saveNote(input) {
  const record = {
    id: input.id ?? db.newId(),
    title: input.title ?? '',
    body: input.body ?? '',
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.put('notes', record);
  upsert(state.notes, record);
  emit();
  return record;
}

export async function deleteNote(id) {
  await db.remove('notes', id);
  state.notes = state.notes.filter((n) => n.id !== id);
  emit();
}

// ---------------------------------------------------------------------------
// Eventos manuais
// ---------------------------------------------------------------------------

export async function saveEvent(input) {
  const record = {
    id: input.id ?? db.newId(),
    title: (input.title ?? '').trim() || 'Evento',
    date: input.date ?? todayISO(),
    time: input.time ?? null,
    notes: input.notes ?? '',
    reminderMinutes: input.reminderMinutes ?? [-60],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  await db.put('events', record);
  upsert(state.events, record);
  emit();
  return record;
}

export async function deleteEvent(id) {
  await db.remove('events', id);
  state.events = state.events.filter((e) => e.id !== id);
  emit();
}

// ---------------------------------------------------------------------------
// Agendas externas
// ---------------------------------------------------------------------------

/**
 * Substitui os eventos de uma origem (`google` ou `ics`).
 *
 * Substituir em vez de mesclar é proposital: se um compromisso foi apagado
 * ou movido na agenda de origem, mesclar o deixaria preso aqui para sempre.
 * A origem manda — este app só espelha.
 */
export async function replaceExternalEvents(source, events) {
  const antigos = state.externalEvents.filter((e) => e.source === source).map((e) => e.id);
  await db.removeMany('externalEvents', antigos);

  const novos = events.map((event) => ({ ...event, source, syncedAt: new Date().toISOString() }));
  await db.putMany('externalEvents', novos);

  state.externalEvents = [
    ...state.externalEvents.filter((e) => e.source !== source),
    ...novos,
  ];
  emit();
  return novos.length;
}

export async function clearExternalEvents(source) {
  const alvo = state.externalEvents.filter((e) => !source || e.source === source).map((e) => e.id);
  await db.removeMany('externalEvents', alvo);
  state.externalEvents = source
    ? state.externalEvents.filter((e) => e.source !== source)
    : [];
  emit();
}

// ---------------------------------------------------------------------------
// Cotações do assistente
// ---------------------------------------------------------------------------

export async function saveQuote(quote) {
  const record = { id: quote.id ?? db.newId(), ...quote };
  await db.put('quotes', record);
  upsert(state.quotes, record);
  emit();
  return record;
}

// ---------------------------------------------------------------------------

function upsert(collection, record) {
  const index = collection.findIndex((item) => item.id === record.id);
  if (index >= 0) collection[index] = record;
  else collection.push(record);
}

export async function wipeEverything() {
  await db.clearAll();
  for (const key of ['accounts', 'categories', 'transactions', 'plans', 'goals',
                     'contributions', 'notes', 'events', 'externalEvents', 'quotes']) {
    state[key] = [];
  }
  state.settings = {};
  await seedDefaults();
  emit();
}
