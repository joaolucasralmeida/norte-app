import {
  state, saveGoal, deleteGoal, addContribution, deleteContribution, contributionsOf,
} from '../store.js';
import { contributedCents, remainingCents, goalProgress, goalProjection, requiredMonthly } from '../domain.js';
import { money, percent, parseMoney, fmtDate, fmtMonth, todayISO, safeURL } from '../format.js';
import {
  el, card, emptyState, progressBar, openSheet, closeSheet, toast, confirmAction,
  field, input, moneyInput, select, segmented, toggle, sectionTitle,
} from '../ui.js';

let openGoalId = null;

export function renderGoals() {
  if (openGoalId) {
    const goal = state.goals.find((g) => g.id === openGoalId);
    if (goal) return goalDetail(goal);
    openGoalId = null;
  }

  const screen = el('div', { class: 'stack' });

  if (state.goals.length === 0) {
    screen.append(emptyState({
      icon: '◎',
      title: 'Nenhuma meta ainda',
      message: 'Crie uma meta de compra e acompanhe quanto falta a cada aporte.',
      actionLabel: 'Criar meta',
      onAction: () => openGoalSheet(),
    }));
    return screen;
  }

  screen.append(summaryCard(), grid(), newGoalButton());
  return screen;
}

function newGoalButton() {
  return el('button', { class: 'fab', onClick: () => openGoalSheet(), 'aria-label': 'Nova meta' }, '+');
}

function summaryCard() {
  const target = state.goals.reduce((sum, g) => sum + g.targetCents, 0);
  const saved = state.goals.reduce((sum, g) => sum + contributedCents(contributionsOf(g.id)), 0);
  const ratio = target > 0 ? saved / target : 0;

  return card([
    el('div', { class: 'row' }, [
      el('div', { class: 'stack-xs' }, [
        el('span', { class: 'caption' }, 'GUARDADO NO TOTAL'),
        el('strong', {}, `${money(saved)} de ${money(target)}`),
      ]),
      el('span', { class: 'big-percent' }, percent(ratio)),
    ]),
  ], 'accent-soft');
}

function grid() {
  const sorted = [...state.goals].sort((a, b) =>
    (a.status === 'achieved') - (b.status === 'achieved') || a.priority - b.priority);

  return el('div', { class: 'goal-grid' }, sorted.map(goalCard));
}

function goalCard(goal) {
  const contributions = contributionsOf(goal.id);
  const progress = goalProgress(goal, contributions);
  const remaining = remainingCents(goal, contributions);
  const achieved = goal.status === 'achieved' || remaining === 0;
  const projection = goalProjection(goal, contributions);

  return el('button', {
    class: `goal-card ${achieved ? 'achieved' : ''}`.trim(),
    onClick: () => { openGoalId = goal.id; rerender(); },
  }, [
    el('div', { class: 'goal-hero' }, [
      safeURL(goal.imageURL)
        ? el('img', { src: safeURL(goal.imageURL), alt: '', loading: 'lazy', onError: (e) => e.target.remove() })
        : el('span', { class: 'goal-emoji' }, '🛍️'),
      el('span', { class: `badge ${achieved ? 'ok' : priorityClass(goal.priority)}` },
        achieved ? 'atingida' : priorityLabel(goal.priority)),
    ]),
    el('div', { class: 'goal-body' }, [
      el('strong', {}, goal.title),
      el('span', { class: 'caption' }, achieved ? 'meta atingida' : `faltam ${money(remaining)}`),
      progressBar(progress, achieved ? 'var(--positive)' : 'var(--accent)'),
      el('div', { class: 'goal-foot' }, [
        el('strong', {}, percent(progress)),
        el('span', { class: 'caption' }, money(goal.targetCents)),
      ]),
      el('span', { class: 'caption tiny' },
        achieved ? 'concluída'
          : projection ? `previsão: ${fmtMonth(projection.dateISO)}`
          : 'sem dados p/ previsão'),
    ]),
  ]);
}

const priorityLabel = (p) => (p === 1 ? 'alta' : p === 3 ? 'baixa' : 'média');
const priorityClass = (p) => (p === 1 ? 'high' : p === 3 ? 'low' : 'medium');

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------

function goalDetail(goal) {
  const contributions = contributionsOf(goal.id);
  const saved = contributedCents(contributions);
  const remaining = remainingCents(goal, contributions);
  const progress = goalProgress(goal, contributions);
  const projection = goalProjection(goal, contributions);
  const monthly = requiredMonthly(goal, contributions);

  return el('div', { class: 'stack' }, [
    el('button', { class: 'back-link', onClick: () => { openGoalId = null; rerender(); } }, '‹ Metas'),

    el('div', { class: 'goal-hero large' }, [
      safeURL(goal.imageURL)
        ? el('img', { src: safeURL(goal.imageURL), alt: '', onError: (e) => e.target.remove() })
        : el('span', { class: 'goal-emoji' }, '🛍️'),
    ]),

    el('div', { class: 'stack-xs' }, [
      el('h2', {}, goal.title),
      safeURL(goal.productURL)
        ? el('a', { href: safeURL(goal.productURL), target: '_blank', rel: 'noopener noreferrer', class: 'link' },
            new URL(safeURL(goal.productURL)).hostname + ' ↗')
        : null,
    ]),

    card([
      el('div', { class: 'row' }, [
        el('div', { class: 'stack-xs' }, [
          el('span', { class: 'caption' }, 'JÁ GUARDADO'),
          el('strong', { class: 'big-money sm' }, money(saved)),
        ]),
        el('div', { class: 'stack-xs right' }, [
          el('span', { class: 'caption' }, 'META'),
          el('strong', {}, money(goal.targetCents)),
        ]),
      ]),
      progressBar(progress, remaining === 0 ? 'var(--positive)' : 'var(--accent)'),
      el('div', { class: 'row' }, [
        el('strong', {}, `${percent(progress)} concluído`),
        el('strong', { class: remaining === 0 ? 'positive' : 'warn' },
          remaining === 0 ? 'meta atingida 🎉' : `faltam ${money(remaining)}`),
      ]),
    ]),

    projection
      ? card([
          el('h2', {}, `Previsão: ${fmtMonth(projection.dateISO)}`),
          el('p', { class: 'caption' },
            `Com a média de ${money(projection.monthlyAverageCents)}/mês dos últimos 90 dias, faltam cerca de ${projection.months} aportes.`),
          monthly && goal.targetDate
            ? el('p', { class: 'caption' },
                `Para bater em ${fmtDate(goal.targetDate)}, seriam ${money(monthly)}/mês.`)
            : null,
        ])
      : card([
          el('h2', {}, 'Sem dados para previsão'),
          el('p', { class: 'caption' }, 'Registre pelo menos dois aportes para eu estimar quando a meta termina.'),
        ]),

    el('div', { class: 'actions' }, [
      el('button', { class: 'btn primary grow', onClick: () => openContributionSheet(goal) }, '+ Adicionar aporte'),
      el('button', { class: 'btn', onClick: () => openGoalSheet(goal) }, 'Editar'),
    ]),

    card([
      sectionTitle('Aportes'),
      contributions.length === 0
        ? el('p', { class: 'caption' }, 'Nenhum aporte ainda.')
        : el('div', { class: 'stack-xs' }, contributions.slice(0, 12).map((contribution) =>
            el('div', { class: 'row contribution' }, [
              el('div', { class: 'stack-xs' }, [
                el('span', {}, fmtDate(contribution.date)),
                contribution.note ? el('span', { class: 'caption' }, contribution.note) : null,
                contribution.transactionId ? el('span', { class: 'caption tiny' }, 'transferido de uma conta') : null,
              ]),
              el('div', { class: 'row-value' }, [
                el('span', { class: 'amount income' }, `+ ${money(contribution.amountCents)}`),
                el('button', {
                  class: 'mini-btn danger',
                  onClick: async () => {
                    const ok = await confirmAction({
                      title: 'Remover aporte?',
                      message: `${money(contribution.amountCents)} de ${fmtDate(contribution.date)}.`,
                      confirmLabel: 'Remover', destructive: true,
                    });
                    if (!ok) return;
                    await deleteContribution(contribution.id);
                    rerender();
                  },
                }, '×'),
              ]),
            ]),
          )),
    ]),

    el('button', {
      class: 'btn danger',
      onClick: async () => {
        const ok = await confirmAction({
          title: 'Excluir meta?',
          message: `"${goal.title}" e todos os seus aportes serão removidos.`,
          confirmLabel: 'Excluir', destructive: true,
        });
        if (!ok) return;
        await deleteGoal(goal.id);
        openGoalId = null;
        toast('Meta excluída.');
        rerender();
      },
    }, 'Excluir meta'),
  ]);
}

// ---------------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------------

export function openGoalSheet(existing = null, prefill = null) {
  const form = {
    title: existing?.title ?? prefill?.title ?? '',
    amount: existing ? String(existing.targetCents / 100).replace('.', ',')
      : prefill ? String(prefill.targetCents / 100).replace('.', ',') : '',
    productURL: existing?.productURL ?? prefill?.productURL ?? '',
    imageURL: existing?.imageURL ?? prefill?.imageURL ?? '',
    hasTargetDate: Boolean(existing?.targetDate),
    targetDate: existing?.targetDate ?? todayISO(),
    priority: existing?.priority ?? prefill?.priority ?? 2,
    initial: '',
    wantsInitial: false,
  };

  const body = el('div', { class: 'stack' });

  const build = () => {
    const children = [
      field('Título', input({
        value: form.title, placeholder: 'Ex.: iPhone 15 128GB',
        onInput: (e) => { form.title = e.target.value; },
      })),

      field('Valor alvo', moneyInput({
        value: form.amount, onInput: (e) => { form.amount = e.target.value; },
      })),

      field('Link do produto', input({
        type: 'url', value: form.productURL, placeholder: 'https://…',
        onInput: (e) => { form.productURL = e.target.value; },
      }), 'Opcional'),

      field('Foto (URL)', input({
        type: 'url', value: form.imageURL, placeholder: 'https://…',
        onInput: (e) => { form.imageURL = e.target.value; },
      }), 'Opcional'),

      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Prioridade'),
        segmented([
          { value: 1, label: 'Alta' }, { value: 2, label: 'Média' }, { value: 3, label: 'Baixa' },
        ], form.priority, (value) => { form.priority = value; build(); }),
      ]),

      toggle('Definir data alvo', form.hasTargetDate, (value) => { form.hasTargetDate = value; build(); },
        'Vira um evento no Calendário, com aviso uma semana antes.'),
    ];

    if (form.hasTargetDate) {
      children.push(field('Data alvo', input({
        type: 'date', value: form.targetDate, onInput: (e) => { form.targetDate = e.target.value; },
      })));
    }

    if (!existing) {
      children.push(toggle('Fazer um aporte inicial', form.wantsInitial, (value) => {
        form.wantsInitial = value; build();
      }));
      if (form.wantsInitial) {
        children.push(field('Valor do aporte', moneyInput({
          value: form.initial, onInput: (e) => { form.initial = e.target.value; },
        })));
      }
    }

    if (prefill?.rationale) {
      children.push(el('p', { class: 'caption accent' }, `✦ ${prefill.rationale}`));
    }

    body.replaceChildren(...children);
  };

  build();

  openSheet({
    title: existing ? 'Editar meta' : 'Nova meta',
    body,
    onConfirm: async () => {
      const goal = await saveGoal({
        id: existing?.id,
        createdAt: existing?.createdAt,
        status: existing?.status,
        title: form.title,
        targetCents: parseMoney(form.amount),
        targetDate: form.hasTargetDate ? form.targetDate : null,
        priority: form.priority,
        productURL: safeURL(form.productURL),
        imageURL: safeURL(form.imageURL),
        quoteId: prefill?.quoteId ?? existing?.quoteId ?? null,
      });

      if (!existing && form.wantsInitial) {
        const cents = parseMoney(form.initial);
        if (cents > 0) await addContribution({ goalId: goal.id, amountCents: cents });
      }

      toast('Meta salva.');
      rerender();
      return true;
    },
  });
}

function openContributionSheet(goal) {
  const contributions = contributionsOf(goal.id);
  const form = { amount: '', date: todayISO(), note: '', fromAccountId: '' };

  const remainingNode = el('p', { class: 'caption' });
  const updateRemaining = () => {
    const after = Math.max(0, remainingCents(goal, contributions) - parseMoney(form.amount));
    remainingNode.textContent = `Depois deste aporte faltarão ${money(after)}.`;
  };

  const accounts = state.accounts.filter((a) => !a.archived && a.kind !== 'goal_reserve');

  const body = el('div', { class: 'stack' }, [
    field('Valor', moneyInput({
      onInput: (e) => { form.amount = e.target.value; updateRemaining(); },
    })),
    field('Data', input({ type: 'date', value: form.date, onInput: (e) => { form.date = e.target.value; } })),
    field('Observação', input({ placeholder: 'Opcional', onInput: (e) => { form.note = e.target.value; } })),
    field('Transferir de uma conta', select(
      [{ value: '', label: 'Só registrar o aporte' },
       ...accounts.map((a) => ({ value: a.id, label: a.name }))],
      { onChange: (e) => { form.fromAccountId = e.target.value; } },
    ), 'Com uma conta escolhida, o valor sai dela e aparece também no Financeiro.'),
    remainingNode,
  ]);

  updateRemaining();

  openSheet({
    title: 'Novo aporte',
    body,
    onConfirm: async () => {
      await addContribution({
        goalId: goal.id,
        amountCents: parseMoney(form.amount),
        date: form.date,
        note: form.note,
        fromAccountId: form.fromAccountId || null,
      });
      toast('Aporte registrado.');
      rerender();
      return true;
    },
  });
}

function rerender() {
  window.dispatchEvent(new CustomEvent('norte:rerender'));
}
