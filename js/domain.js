/**
 * Regras de domínio — porte direto do app Swift (InstallmentPlanner e
 * GoalMath). Funções puras sobre números inteiros em centavos: dá para
 * testar sem banco, sem DOM e sem rede.
 */

import { addMonthsISO, daysBetween, todayISO, fromISODate, toISODate } from './format.js';

export const DomainError = {
  INVALID_AMOUNT: 'invalid_amount',
  INVALID_COUNT: 'invalid_count',
  TOO_SMALL: 'installment_too_small',
  INVALID_TRANSFER: 'invalid_transfer',
};

// ---------------------------------------------------------------------------
// Parcelamento
// ---------------------------------------------------------------------------

/**
 * Divide um total em N parcelas.
 *
 * Regra do centavo: R$ 1.000 em 3 dá 333,333…; arredondar todas para baixo
 * perderia um centavo do total. O resto vai **na última** parcela, para a
 * soma fechar exatamente — invariante coberta por teste.
 *
 * @param {number} totalCents  valor total, em centavos, positivo
 * @param {number} count       1..480
 * @param {string} firstDueISO 'yyyy-mm-dd'
 * @param {number} intervalMonths 1 = mensal
 */
export function planInstallments(totalCents, count, firstDueISO, intervalMonths = 1) {
  if (!Number.isFinite(totalCents) || totalCents <= 0) throw new Error(DomainError.INVALID_AMOUNT);
  if (!Number.isInteger(count) || count < 1 || count > 480) throw new Error(DomainError.INVALID_COUNT);
  if (totalCents < count) throw new Error(DomainError.TOO_SMALL);

  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const step = Math.max(1, intervalMonths);

  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    count,
    amountCents: index === count - 1 ? base + remainder : base,
    dueDate: addMonthsISO(firstDueISO, index * step),
    label: `${index + 1}/${count}`,
  }));
}

/** Caminho inverso: o usuário digitou o valor da parcela. */
export function planFromInstallmentAmount(installmentCents, count, firstDueISO, intervalMonths = 1) {
  if (!Number.isFinite(installmentCents) || installmentCents <= 0) {
    throw new Error(DomainError.INVALID_AMOUNT);
  }
  return planInstallments(installmentCents * count, count, firstDueISO, intervalMonths);
}

// ---------------------------------------------------------------------------
// Saldos
// ---------------------------------------------------------------------------

/** Multiplicador do valor na conta de origem. Transferência sai como saída. */
function signFor(kind) {
  if (kind === 'income') return 1;
  return -1; // expense e transfer saem da conta de origem
}

/**
 * @param {object} account
 * @param {Array}  transactions todas as transações (filtramos aqui)
 * @param {boolean} includeUnpaid saldo previsto inclui o que ainda não foi pago
 */
export function accountBalance(account, transactions, includeUnpaid = false) {
  let total = account.initialBalanceCents ?? 0;

  for (const tx of transactions) {
    if (!includeUnpaid && !tx.paid) continue;

    if (tx.accountId === account.id) total += signFor(tx.kind) * tx.amountCents;
    // Transferência também credita a conta de destino.
    if (tx.kind === 'transfer' && tx.destinationAccountId === account.id) total += tx.amountCents;
  }
  return total;
}

export function totalBalance(accounts, transactions, includeUnpaid = false) {
  return accounts
    .filter((a) => !a.archived)
    .reduce((sum, account) => sum + accountBalance(account, transactions, includeUnpaid), 0);
}

/** Receitas e despesas de um mês ('yyyy-mm'). */
export function monthSummary(transactions, month, includeUnpaid = true) {
  let income = 0;
  let expense = 0;

  for (const tx of transactions) {
    if (!tx.date.startsWith(month)) continue;
    if (!includeUnpaid && !tx.paid) continue;
    if (tx.kind === 'income') income += tx.amountCents;
    if (tx.kind === 'expense') expense += tx.amountCents;
  }
  return { income, expense, result: income - expense };
}

export function expensesByCategory(transactions, categories, month) {
  const totals = new Map();

  for (const tx of transactions) {
    if (tx.kind !== 'expense' || !tx.date.startsWith(month)) continue;
    const name = categories.find((c) => c.id === tx.categoryId)?.name ?? 'Sem categoria';
    totals.set(name, (totals.get(name) ?? 0) + tx.amountCents);
  }

  const grand = [...totals.values()].reduce((a, b) => a + b, 0);
  if (grand === 0) return [];

  return [...totals.entries()]
    .map(([name, cents]) => ({ name, cents, share: cents / grand }))
    .sort((a, b) => b.cents - a.cents);
}

// ---------------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------------

export function contributedCents(contributions) {
  return contributions.reduce((sum, c) => sum + c.amountCents, 0);
}

export function remainingCents(goal, contributions) {
  return Math.max(0, goal.targetCents - contributedCents(contributions));
}

/** 0..1, saturado — a barra de progresso nunca estoura. */
export function goalProgress(goal, contributions) {
  if (!goal.targetCents) return 0;
  return Math.min(1, Math.max(0, contributedCents(contributions) / goal.targetCents));
}

/**
 * Projeção de conclusão pela média de aportes dos últimos `windowDays`.
 *
 * Devolve `null` quando não há base: com menos de dois aportes na janela,
 * qualquer data seria chute, e a interface precisa dizer "sem dados
 * suficientes" em vez de inventar um mês.
 */
export function goalProjection(goal, contributions, { windowDays = 90, todayIso = todayISO() } = {}) {
  const remaining = remainingCents(goal, contributions);
  if (remaining <= 0) return null;

  const recent = contributions.filter(
    (c) => c.amountCents > 0 && daysBetween(c.date, todayIso) <= windowDays && daysBetween(c.date, todayIso) >= 0,
  );
  if (recent.length < 2) return null;

  const monthlyAverage = contributedCents(recent) / (windowDays / 30);
  if (monthlyAverage <= 0) return null;

  const months = Math.ceil(remaining / monthlyAverage);
  if (months <= 0 || months > 1200) return null; // > 100 anos não ajuda ninguém

  const date = fromISODate(todayIso);
  date.setMonth(date.getMonth() + months);

  return { monthlyAverageCents: Math.round(monthlyAverage), months, dateISO: toISODate(date) };
}

/** Quanto guardar por mês para bater a meta até a data alvo. */
export function requiredMonthly(goal, contributions, todayIso = todayISO()) {
  if (!goal.targetDate) return null;
  const remaining = remainingCents(goal, contributions);
  if (remaining <= 0) return null;

  const months = Math.max(1, Math.round(daysBetween(todayIso, goal.targetDate) / 30));
  return Math.ceil(remaining / months);
}

// ---------------------------------------------------------------------------
// Eventos de calendário a partir das parcelas
// ---------------------------------------------------------------------------

/**
 * Deriva os eventos do calendário das transações — não há tabela separada.
 *
 * No app nativo os eventos eram entidades persistidas, porque precisavam
 * carregar o vínculo com o EventKit. Aqui o calendário é só uma leitura das
 * parcelas não pagas mais os eventos manuais, o que elimina de uma vez toda a
 * classe de bug de "evento duplicado" e de sincronização.
 */
export function derivedEvents(transactions, goals, manualEvents = [], externalEvents = []) {
  const fromInstallments = transactions
    .filter((tx) => tx.kind === 'expense' && tx.installmentCount > 1)
    .map((tx) => ({
      id: `tx-${tx.id}`,
      title: `Parcela ${tx.installmentIndex}/${tx.installmentCount} — ${tx.title}`,
      date: tx.date,
      kind: 'installment',
      amountCents: tx.amountCents,
      done: tx.paid,
      transactionId: tx.id,
      reminderMinutes: [-1440],
    }));

  const fromBills = transactions
    .filter((tx) => tx.kind === 'expense' && tx.installmentCount <= 1 && !tx.paid)
    .map((tx) => ({
      id: `tx-${tx.id}`,
      title: tx.title,
      date: tx.date,
      kind: 'bill',
      amountCents: tx.amountCents,
      done: false,
      transactionId: tx.id,
      reminderMinutes: [-1440],
    }));

  const fromGoals = goals
    .filter((goal) => goal.targetDate && goal.status === 'active')
    .map((goal) => ({
      id: `goal-${goal.id}`,
      title: `Meta: ${goal.title}`,
      date: goal.targetDate,
      kind: 'goal_deadline',
      amountCents: goal.targetCents,
      done: false,
      goalId: goal.id,
      reminderMinutes: [-10080],
    }));

  const manual = manualEvents.map((event) => ({
    id: event.id,
    title: event.title,
    date: event.date,
    kind: 'manual',
    notes: event.notes,
    time: event.time,
    done: false,
    reminderMinutes: event.reminderMinutes ?? [-60],
  }));

  // Vêm prontos de google-calendar.js ou do parser de .ics.
  const externos = externalEvents.map((event) => ({ ...event, kind: 'external' }));

  return [...fromInstallments, ...fromBills, ...fromGoals, ...manual, ...externos]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
}

export const EVENT_KINDS = {
  installment: { label: 'Parcela', color: '#EF4444' },
  bill: { label: 'Conta a pagar', color: '#F59E0B' },
  goal_deadline: { label: 'Prazo de meta', color: '#8B5CF6' },
  manual: { label: 'Pessoal', color: '#6B7280' },
  external: { label: 'Agenda', color: '#0EA5E9' },
};
