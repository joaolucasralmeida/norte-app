import { state, saveTransaction, saveInstallmentPlan, togglePaid, deleteTransaction, deletePlan } from '../store.js';
import { planInstallments, planFromInstallmentAmount } from '../domain.js';
import { money, signedMoney, parseMoney, fmtDayHeader, fmtMonth, todayISO, monthKey, addMonthsISO } from '../format.js';
import {
  el, card, emptyState, openSheet, closeSheet, toast, confirmAction,
  field, input, moneyInput, select, segmented, toggle,
} from '../ui.js';

let filterMonth = monthKey(todayISO());
let searchTerm = '';
let onlyUnpaid = false;

export function renderFinance() {
  const screen = el('div', { class: 'stack' });

  screen.append(
    monthNav(),
    searchBar(),
    transactionList(),
    el('button', { class: 'fab', onClick: () => openTransactionSheet(), 'aria-label': 'Nova transação' }, '+'),
  );

  return screen;
}

function monthNav() {
  const shift = (delta) => {
    filterMonth = monthKey(addMonthsISO(`${filterMonth}-01`, delta));
    rerender();
  };

  return el('div', { class: 'month-nav' }, [
    el('button', { class: 'icon-btn', onClick: () => shift(-1), 'aria-label': 'Mês anterior' }, '‹'),
    el('strong', {}, fmtMonth(`${filterMonth}-01`)),
    el('button', { class: 'icon-btn', onClick: () => shift(1), 'aria-label': 'Próximo mês' }, '›'),
  ]);
}

function searchBar() {
  return el('div', { class: 'toolbar' }, [
    input({
      type: 'search',
      placeholder: 'Buscar lançamento',
      value: searchTerm,
      onInput: (event) => { searchTerm = event.target.value; refreshList(); },
    }),
    el('button', {
      class: `chip ${onlyUnpaid ? 'active' : ''}`.trim(),
      onClick: () => { onlyUnpaid = !onlyUnpaid; rerender(); },
    }, 'Previstas'),
  ]);
}

function visibleTransactions() {
  const term = searchTerm.trim().toLowerCase();

  return state.transactions
    .filter((tx) => tx.date.startsWith(filterMonth))
    .filter((tx) => !onlyUnpaid || !tx.paid)
    .filter((tx) => {
      if (!term) return true;
      const category = state.categories.find((c) => c.id === tx.categoryId)?.name ?? '';
      return `${tx.title} ${tx.notes} ${category}`.toLowerCase().includes(term);
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

function transactionList() {
  const list = el('div', { class: 'stack', id: 'tx-list' });
  list.append(...buildListChildren());
  return list;
}

function refreshList() {
  const list = document.getElementById('tx-list');
  if (!list) return rerender();
  list.replaceChildren(...buildListChildren());
}

function buildListChildren() {
  const transactions = visibleTransactions();

  if (transactions.length === 0) {
    return [emptyState({
      icon: '≡',
      title: 'Nenhum lançamento',
      message: 'Toque no + para registrar uma receita, uma despesa ou uma compra parcelada.',
      actionLabel: 'Adicionar',
      onAction: () => openTransactionSheet(),
    })];
  }

  const byDay = new Map();
  for (const tx of transactions) {
    if (!byDay.has(tx.date)) byDay.set(tx.date, []);
    byDay.get(tx.date).push(tx);
  }

  return [...byDay.entries()].map(([date, items]) =>
    el('div', { class: 'day-group' }, [
      el('h3', { class: 'day-head' }, fmtDayHeader(date)),
      ...items.map(transactionRow),
    ]),
  );
}

function transactionRow(tx) {
  const category = state.categories.find((c) => c.id === tx.categoryId);
  const account = state.accounts.find((a) => a.id === tx.accountId);

  const subtitle = [
    category?.name,
    account?.name,
    tx.installmentCount > 1 ? `parcela ${tx.installmentIndex}/${tx.installmentCount}` : null,
  ].filter(Boolean).join(' · ');

  return el('div', { class: 'tx' }, [
    el('span', {
      class: 'tx-icon',
      style: { background: (category?.color ?? '#9CA3AF') + '28' },
    }, category?.icon ?? '•'),

    el('div', { class: 'tx-main' }, [
      el('strong', {}, tx.title),
      el('span', { class: 'caption' }, subtitle),
    ]),

    el('div', { class: 'tx-right' }, [
      el('span', { class: `amount ${tx.kind}` }, signedMoney(tx.amountCents, tx.kind)),
      tx.paid
        ? null
        : el('button', { class: 'mini-btn', onClick: () => togglePaid(tx.id) }, 'marcar paga'),
    ]),

    el('button', {
      class: 'tx-more',
      'aria-label': 'Opções',
      onClick: () => openTransactionActions(tx),
    }, '⋯'),
  ]);
}

function openTransactionActions(tx) {
  const body = el('div', { class: 'stack' }, [
    el('button', { class: 'btn', onClick: async () => { await togglePaid(tx.id); closeSheet(); } },
      tx.paid ? 'Marcar como não paga' : 'Marcar como paga'),

    el('button', { class: 'btn', onClick: () => { closeSheet(); openTransactionSheet(tx); } }, 'Editar'),

    tx.planId
      ? el('button', {
          class: 'btn danger',
          onClick: async () => {
            closeSheet();
            const ok = await confirmAction({
              title: 'Excluir o parcelamento?',
              message: 'As parcelas ainda não pagas serão removidas. As já pagas ficam no histórico.',
              confirmLabel: 'Excluir parcelas futuras',
              destructive: true,
            });
            if (!ok) return;
            const result = await deletePlan(tx.planId);
            toast(`${result.removed} parcela(s) removida(s).`);
            rerender();
          },
        }, 'Excluir parcelamento inteiro')
      : null,

    el('button', {
      class: 'btn danger',
      onClick: async () => {
        closeSheet();
        const ok = await confirmAction({
          title: 'Excluir lançamento?',
          message: `"${tx.title}" será removido. Não dá para desfazer.`,
          confirmLabel: 'Excluir',
          destructive: true,
        });
        if (!ok) return;
        await deleteTransaction(tx.id);
        toast('Lançamento excluído.');
        rerender();
      },
    }, 'Excluir este lançamento'),
  ]);

  openSheet({ title: tx.title, body, hideConfirm: true });
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

export function openTransactionSheet(existing = null) {
  const form = {
    mode: existing?.installmentCount > 1 ? 'installment' : (existing?.kind === 'transfer' ? 'transfer' : 'single'),
    kind: existing?.kind === 'income' ? 'income' : 'expense',
    amount: existing ? String(existing.amountCents / 100).replace('.', ',') : '',
    title: existing?.title ?? '',
    date: existing?.date ?? todayISO(),
    accountId: existing?.accountId ?? state.accounts.find((a) => !a.archived)?.id,
    destinationAccountId: existing?.destinationAccountId ?? null,
    categoryId: existing?.categoryId ?? null,
    count: 6,
    intervalMonths: 1,
    byInstallment: false,
    paid: existing?.paid ?? false,
  };

  const body = el('div', { class: 'stack' });

  const build = () => {
    const accounts = state.accounts.filter((a) => !a.archived);
    const categories = state.categories.filter((c) => c.kind === (form.kind === 'income' ? 'income' : 'expense'));

    const children = [
      segmented([
        { value: 'single', label: 'Única' },
        { value: 'installment', label: 'Parcelada' },
        { value: 'transfer', label: 'Transferência' },
      ], form.mode, (value) => { form.mode = value; if (value === 'transfer') form.kind = 'transfer'; else if (form.kind === 'transfer') form.kind = 'expense'; build(); }),
    ];

    if (form.mode !== 'transfer') {
      children.push(segmented([
        { value: 'income', label: 'Receita' },
        { value: 'expense', label: 'Despesa' },
      ], form.kind, (value) => { form.kind = value; form.categoryId = null; build(); }));
    }

    children.push(field(
      form.mode === 'installment' && form.byInstallment ? 'Valor da parcela' : 'Valor total',
      moneyInput({ value: form.amount, onInput: (e) => { form.amount = e.target.value; updatePreview(); } }),
    ));

    if (form.mode === 'installment') {
      children.push(toggle('Informar valor por parcela', form.byInstallment, (value) => {
        form.byInstallment = value; build();
      }));
    }

    children.push(field('Descrição', input({
      value: form.title, placeholder: 'Ex.: Geladeira Brastemp',
      onInput: (e) => { form.title = e.target.value; },
    })));

    children.push(field('Conta', select(
      accounts.map((a) => ({ value: a.id, label: a.name, selected: a.id === form.accountId })),
      { onChange: (e) => { form.accountId = e.target.value; } },
    )));

    if (form.mode === 'transfer') {
      children.push(field('Conta de destino', select(
        [{ value: '', label: 'Selecione' },
         ...accounts.map((a) => ({ value: a.id, label: a.name, selected: a.id === form.destinationAccountId }))],
        { onChange: (e) => { form.destinationAccountId = e.target.value || null; } },
      )));
    } else {
      children.push(field('Categoria', select(
        [{ value: '', label: 'Sem categoria' },
         ...categories.map((c) => ({ value: c.id, label: `${c.icon} ${c.name}`, selected: c.id === form.categoryId }))],
        { onChange: (e) => { form.categoryId = e.target.value || null; } },
      )));
    }

    children.push(field(
      form.mode === 'installment' ? 'Vencimento da 1ª parcela' : 'Data',
      input({ type: 'date', value: form.date, onInput: (e) => { form.date = e.target.value; updatePreview(); } }),
    ));

    if (form.mode === 'installment') {
      children.push(field('Número de parcelas', input({
        type: 'number', min: 2, max: 480, value: form.count,
        onInput: (e) => { form.count = Number(e.target.value) || 2; updatePreview(); },
      })));

      children.push(field('Repetir a cada', select([
        { value: '1', label: 'Mensal', selected: form.intervalMonths === 1 },
        { value: '2', label: 'Bimestral', selected: form.intervalMonths === 2 },
        { value: '3', label: 'Trimestral', selected: form.intervalMonths === 3 },
        { value: '6', label: 'Semestral', selected: form.intervalMonths === 6 },
        { value: '12', label: 'Anual', selected: form.intervalMonths === 12 },
      ], { onChange: (e) => { form.intervalMonths = Number(e.target.value); updatePreview(); } })));

      children.push(el('div', { id: 'plan-preview', class: 'preview' }));
    } else {
      children.push(toggle('Já foi pago', form.paid, (value) => { form.paid = value; }));
    }

    body.replaceChildren(...children);
    updatePreview();
  };

  const updatePreview = () => {
    const node = document.getElementById('plan-preview');
    if (!node || form.mode !== 'installment') return;

    const cents = parseMoney(form.amount);
    if (cents <= 0 || form.count < 2) {
      node.replaceChildren(el('p', { class: 'caption' }, 'Informe valor e número de parcelas.'));
      return;
    }

    try {
      const installments = form.byInstallment
        ? planFromInstallmentAmount(cents, form.count, form.date, form.intervalMonths)
        : planInstallments(cents, form.count, form.date, form.intervalMonths);

      const total = installments.reduce((sum, i) => sum + i.amountCents, 0);

      node.replaceChildren(
        el('strong', {}, `${installments.length} parcelas de ${money(installments[0].amountCents)}`),
        el('p', { class: 'caption' }, `A soma fecha exatamente ${money(total)} — o resto dos centavos vai na última.`),
        ...installments.slice(0, 3).map((i) => el('div', { class: 'row' }, [
          el('span', { class: 'row-label' }, `${i.label} · ${i.dueDate.split('-').reverse().join('/')}`),
          el('span', { class: 'row-value mono' }, money(i.amountCents)),
        ])),
        installments.length > 3
          ? el('p', { class: 'caption' }, `+ ${installments.length - 3} parcelas…`)
          : null,
        el('p', { class: 'caption accent' }, 'Cada parcela vira um evento na aba Calendário, com lembrete 1 dia antes.'),
      );
    } catch (error) {
      node.replaceChildren(el('p', { class: 'caption negative' }, messageFor(error)));
    }
  };

  build();

  openSheet({
    title: existing ? 'Editar transação' : 'Nova transação',
    body,
    confirmLabel: 'Salvar',
    onConfirm: async () => {
      const cents = parseMoney(form.amount);

      if (form.mode === 'installment') {
        await saveInstallmentPlan({
          title: form.title || 'Parcelamento',
          totalCents: cents,
          installmentCents: cents,
          count: form.count,
          firstDueDate: form.date,
          intervalMonths: form.intervalMonths,
          accountId: form.accountId,
          categoryId: form.categoryId,
          entersInstallmentValue: form.byInstallment,
        });
        toast(`${form.count} parcelas criadas.`);
      } else {
        await saveTransaction({
          id: existing?.id,
          createdAt: existing?.createdAt,
          title: form.title,
          amountCents: cents,
          kind: form.mode === 'transfer' ? 'transfer' : form.kind,
          date: form.date,
          accountId: form.accountId,
          destinationAccountId: form.destinationAccountId,
          categoryId: form.categoryId,
          paid: form.mode === 'transfer' ? true : form.paid,
        });
        toast('Lançamento salvo.');
      }
      rerender();
      return true;
    },
  });
}

function messageFor(error) {
  switch (error.message) {
    case 'installment_too_small': return 'O valor por parcela ficaria menor que um centavo.';
    case 'invalid_count': return 'O número de parcelas precisa estar entre 1 e 480.';
    case 'invalid_amount': return 'Informe um valor maior que zero.';
    default: return error.message;
  }
}

function rerender() {
  window.dispatchEvent(new CustomEvent('norte:rerender'));
}
