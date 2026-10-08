import { state } from '../store.js';
import {
  totalBalance, accountBalance, monthSummary, expensesByCategory, derivedEvents,
} from '../domain.js';
import { money, signedMoney, percent, fmtMonth, fmtDate, monthKey, todayISO } from '../format.js';
import { el, card, sectionTitle, progressBar, emptyState, toast } from '../ui.js';
import { backupStatus, exportBackup } from '../backup.js';
import { navigate } from '../app.js';
import { openTransactionSheet } from './finance.js';
import { openChat } from './chat.js';

export function renderDashboard() {
  const month = monthKey(todayISO());
  const summary = monthSummary(state.transactions, month);
  const screen = el('div', { class: 'stack' });

  const backup = backupStatus();
  if (backup.level === 'warn') screen.append(backupBanner(backup));

  screen.append(
    balanceCard(),
    accountsStrip(),
    monthCard(summary, month),
    categoriesCard(month),
    shortcuts(),
    nextDueCard(),
  );

  return screen;
}

// ---------------------------------------------------------------------------

function backupBanner(backup) {
  // Leva direto à exportação, não às Configurações: quanto menos toques
  // entre o aviso e o arquivo salvo, mais gente faz o backup.
  return el('button', {
    class: 'banner warn',
    onClick: async () => {
      const result = await exportBackup();
      if (result?.cancelled) return;
      toast('Backup gerado. Salve em Arquivos ou mande para você mesmo.');
      window.dispatchEvent(new CustomEvent('norte:rerender'));
    },
  }, [
    el('strong', {}, '⚠ Faça um backup'),
    el('span', {}, `${backup.text} Seus dados ficam só neste aparelho — se você apagar o ícone ou limpar os dados do Safari, eles somem.`),
    el('span', { class: 'banner-cta' }, 'Exportar agora ›'),
  ]);
}

function balanceCard() {
  const realized = totalBalance(state.accounts, state.transactions, false);
  const projected = totalBalance(state.accounts, state.transactions, true);

  return card([
    el('div', { class: 'card-head' }, [
      el('span', { class: 'caption' }, 'SALDO TOTAL'),
      el('span', { class: 'pill' }, fmtMonth(todayISO())),
    ]),
    el('p', { class: 'big-money' }, money(realized)),
    el('p', { class: 'caption' }, `Previsto no fim do mês: ${money(projected)}`),
  ]);
}

function accountsStrip() {
  const active = state.accounts.filter((a) => !a.archived);
  if (active.length === 0) return el('div');

  return el('div', { class: 'stack-sm' }, [
    sectionTitle('Contas'),
    el('div', { class: 'hscroll' }, active.map((account) =>
      el('div', { class: 'mini-card' }, [
        el('div', { class: 'mini-head' }, [
          el('span', { class: 'dot', style: { background: account.color ?? 'var(--accent)' } }),
          el('span', { class: 'mini-title' }, account.name),
        ]),
        el('strong', {}, money(accountBalance(account, state.transactions))),
      ]),
    )),
  ]);
}

function monthCard(summary, month) {
  const max = Math.max(summary.income, summary.expense, 1);

  const bar = (label, cents, color) => el('div', { class: 'bar-row' }, [
    el('div', { class: 'bar-top' }, [
      el('span', { class: 'caption' }, label),
      el('span', { class: 'mono' }, money(cents)),
    ]),
    el('div', { class: 'bar-track' }, [
      el('span', { style: { width: `${(cents / max) * 100}%`, background: color } }),
    ]),
  ]);

  return card([
    el('h2', {}, `Resumo de ${fmtMonth(`${month}-01`)}`),
    bar('Receitas', summary.income, 'var(--positive)'),
    bar('Despesas', summary.expense, 'var(--negative)'),
    el('hr'),
    el('div', { class: 'row' }, [
      el('span', { class: 'row-label' }, 'Resultado'),
      el('span', {
        class: `row-value ${summary.result >= 0 ? 'positive' : 'negative'}`,
      }, signedMoney(summary.result, summary.result >= 0 ? 'income' : 'expense')),
    ]),
  ]);
}

function categoriesCard(month) {
  const slices = expensesByCategory(state.transactions, state.categories, month);

  if (slices.length === 0) {
    return card([
      el('h2', {}, 'Despesas por categoria'),
      el('p', { class: 'caption' }, 'Nenhuma despesa registrada neste mês.'),
    ]);
  }

  const palette = ['#2563EB', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4', '#9CA3AF'];

  return card([
    el('h2', {}, 'Despesas por categoria'),
    ...slices.slice(0, 6).map((slice, index) => el('div', { class: 'cat-row' }, [
      el('div', { class: 'cat-top' }, [
        el('span', {}, slice.name),
        el('span', { class: 'caption mono' }, `${percent(slice.share)} · ${money(slice.cents)}`),
      ]),
      progressBar(slice.share, palette[index % palette.length]),
    ])),
  ]);
}

function shortcuts() {
  const goals = state.goals.filter((g) => g.status === 'active').length;

  return el('div', { class: 'shortcuts' }, [
    el('button', { class: 'shortcut primary', onClick: () => openTransactionSheet() }, [
      el('strong', {}, '+ Transação'),
      el('span', {}, 'única / parcelada'),
    ]),
    el('button', { class: 'shortcut', onClick: () => openChat() }, [
      el('strong', {}, 'Assistente'),
      el('span', {}, 'pesquisar preço'),
    ]),
    el('button', { class: 'shortcut', onClick: () => navigate('metas') }, [
      el('strong', {}, 'Minhas metas'),
      el('span', {}, `${goals} ativa${goals === 1 ? '' : 's'}`),
    ]),
  ]);
}

function nextDueCard() {
  const today = todayISO();
  const next = derivedEvents(state.transactions, state.goals, state.events)
    .filter((event) => !event.done && event.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  if (!next) return el('div');

  return card([
    el('h2', {}, 'Próximo vencimento'),
    el('div', { class: 'row' }, [
      el('div', { class: 'stack-xs' }, [
        el('span', {}, next.title),
        el('span', { class: 'caption' }, fmtDate(next.date)),
      ]),
      next.amountCents ? el('strong', {}, money(next.amountCents)) : null,
    ]),
  ]);
}
