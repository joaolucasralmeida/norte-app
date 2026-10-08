import { state, saveEvent, deleteEvent, togglePaid } from '../store.js';
import { derivedEvents, EVENT_KINDS } from '../domain.js';
import { money, fmtDayHeader, fmtMonth, todayISO, toISODate, fromISODate, addMonthsISO, monthKey } from '../format.js';
import {
  el, card, openSheet, toast, confirmAction, field, input, select, sectionTitle,
} from '../ui.js';
import { shareICS } from '../ics.js';

let viewMonth = monthKey(todayISO());
let selectedDate = todayISO();
let kindFilter = null;

export function renderCalendar() {
  return el('div', { class: 'stack' }, [
    filters(),
    monthGrid(),
    dayList(),
    exportCard(),
    el('button', {
      class: 'fab',
      onClick: () => openEventSheet(),
      'aria-label': 'Novo evento',
    }, '+'),
  ]);
}

function allEvents() {
  return derivedEvents(state.transactions, state.goals, state.events, state.externalEvents);
}

function filters() {
  const kinds = Object.entries(EVENT_KINDS);

  return el('div', { class: 'hscroll chips' }, [
    el('button', {
      class: `chip ${kindFilter === null ? 'active' : ''}`.trim(),
      onClick: () => { kindFilter = null; rerender(); },
    }, 'Tudo'),
    ...kinds.map(([key, meta]) =>
      el('button', {
        class: `chip ${kindFilter === key ? 'active' : ''}`.trim(),
        onClick: () => { kindFilter = kindFilter === key ? null : key; rerender(); },
      }, [el('span', { class: 'dot', style: { background: meta.color } }), meta.label]),
    ),
  ]);
}

function monthGrid() {
  const events = allEvents().filter((e) => !kindFilter || e.kind === kindFilter);

  const markers = new Map();
  for (const event of events) {
    if (!event.date.startsWith(viewMonth)) continue;
    if (!markers.has(event.date)) markers.set(event.date, new Set());
    markers.get(event.date).add(event.kind);
  }

  const [year, month] = viewMonth.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const leading = first.getDay(); // domingo = 0, igual ao padrão pt-BR

  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push(el('span', { class: 'day empty' }));

  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = toISODate(new Date(year, month - 1, day));
    const kinds = [...(markers.get(iso) ?? [])];
    const isToday = iso === todayISO();

    cells.push(el('button', {
      class: `day ${iso === selectedDate ? 'selected' : ''} ${isToday ? 'today' : ''}`.trim(),
      onClick: () => { selectedDate = iso; rerender(); },
      'aria-label': `${day}, ${kinds.length ? kinds.map((k) => EVENT_KINDS[k].label).join(', ') : 'sem eventos'}`,
    }, [
      el('span', { class: 'day-number' }, String(day)),
      el('span', { class: 'day-dots' }, kinds.slice(0, 3).map((kind) =>
        el('i', { style: { background: EVENT_KINDS[kind].color } }))),
    ]));
  }

  const shift = (delta) => {
    viewMonth = monthKey(addMonthsISO(`${viewMonth}-01`, delta));
    rerender();
  };

  return card([
    el('div', { class: 'row' }, [
      el('strong', {}, fmtMonth(`${viewMonth}-01`)),
      el('span', { class: 'nav-arrows' }, [
        el('button', { class: 'icon-btn', onClick: () => shift(-1), 'aria-label': 'Mês anterior' }, '‹'),
        el('button', { class: 'icon-btn', onClick: () => shift(1), 'aria-label': 'Próximo mês' }, '›'),
      ]),
    ]),
    el('div', { class: 'weekdays' }, ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((d, i) =>
      el('span', { key: i }, d))),
    el('div', { class: 'days' }, cells),
  ]);
}

function dayList() {
  const events = allEvents()
    .filter((event) => event.date === selectedDate)
    .filter((event) => !kindFilter || event.kind === kindFilter);

  return el('div', { class: 'stack-sm' }, [
    el('h3', { class: 'day-head' }, fmtDayHeader(selectedDate)),

    events.length === 0
      ? card([el('p', { class: 'caption' }, 'Nenhum evento neste dia.')])
      : el('div', { class: 'stack-sm' }, events.map(eventRow)),

    el('button', { class: 'btn dashed', onClick: () => openEventSheet(selectedDate) },
      '+ Novo evento neste dia'),
  ]);
}

function eventRow(event) {
  const meta = EVENT_KINDS[event.kind];

  return el('div', { class: `event ${event.done ? 'done' : ''}`.trim() }, [
    el('span', { class: 'event-bar', style: { background: meta.color } }),
    el('div', { class: 'event-body' }, [
      el('strong', {}, event.title),
      el('span', { class: 'caption' }, [
        event.amountCents ? money(event.amountCents) : null,
        event.time ?? 'dia inteiro',
        reminderLabel(event.reminderMinutes?.[0]),
      ].filter(Boolean).join(' · ')),

      el('div', { class: 'event-actions' }, [
        event.transactionId && !event.done
          ? el('button', {
              class: 'mini-btn',
              onClick: async () => { await togglePaid(event.transactionId); rerender(); },
            }, 'marcar como paga')
          : null,
        event.kind === 'manual'
          ? el('button', {
              class: 'mini-btn',
              onClick: () => openEventSheet(event.date, state.events.find((e) => e.id === event.id)),
            }, 'editar')
          : null,
      ]),
    ]),
  ]);
}

function reminderLabel(minutes) {
  if (minutes === undefined || minutes === null) return null;
  if (minutes === 0) return 'lembrete na hora';
  if (minutes === -1440) return 'lembrete 1 dia antes';
  if (minutes === -10080) return 'lembrete 1 semana antes';
  return `lembrete ${Math.abs(minutes) / 60} h antes`;
}

// ---------------------------------------------------------------------------
// Exportação .ics — substitui as notificações do app nativo
// ---------------------------------------------------------------------------

function exportCard() {
  // Eventos vindos de fora ficam de fora da exportação: devolvê-los ao
  // Calendário criaria uma cópia de algo que já está lá.
  const upcoming = allEvents().filter(
    (event) => !event.done && event.date >= todayISO() && event.kind !== 'external',
  );

  return card([
    sectionTitle('Avisos no seu celular'),
    el('p', { class: 'caption' },
      'Um site não consegue notificar você de forma confiável com o app fechado. ' +
      'Então o Norte exporta os vencimentos para o app Calendário do iPhone — ' +
      'e é o próprio iOS que dispara os alertas, no horário certo, de graça.'),

    el('button', {
      class: 'btn primary',
      disabled: upcoming.length === 0,
      onClick: async () => {
        const result = await shareICS(upcoming);
        if (result.cancelled) return;
        toast(result.shared
          ? 'Escolha "Calendário" para importar os eventos.'
          : 'Arquivo baixado — abra-o para adicionar ao Calendário.');
      },
    }, `Enviar ${upcoming.length} evento(s) para o Calendário`),

    el('p', { class: 'caption tiny' },
      'Reimportar não duplica: cada evento tem um identificador fixo, então o Calendário atualiza o que já existe. ' +
      'Mudou alguma parcela? Exporte de novo.'),
  ]);
}

// ---------------------------------------------------------------------------

function openEventSheet(date = selectedDate, existing = null) {
  const form = {
    title: existing?.title ?? '',
    date: existing?.date ?? date,
    time: existing?.time ?? '',
    notes: existing?.notes ?? '',
    reminder: String(existing?.reminderMinutes?.[0] ?? -60),
  };

  const body = el('div', { class: 'stack' }, [
    field('Título', input({
      value: form.title, placeholder: 'Ex.: Revisar orçamento',
      onInput: (e) => { form.title = e.target.value; },
    })),
    field('Data', input({ type: 'date', value: form.date, onInput: (e) => { form.date = e.target.value; } })),
    field('Hora', input({
      type: 'time', value: form.time, onInput: (e) => { form.time = e.target.value; },
    }), 'Deixe vazio para dia inteiro'),
    field('Lembrete', select([
      { value: '0', label: 'Na hora', selected: form.reminder === '0' },
      { value: '-60', label: '1 hora antes', selected: form.reminder === '-60' },
      { value: '-1440', label: '1 dia antes', selected: form.reminder === '-1440' },
      { value: '-10080', label: '1 semana antes', selected: form.reminder === '-10080' },
    ], { onChange: (e) => { form.reminder = e.target.value; } })),
    field('Notas', el('textarea', {
      class: 'input textarea', rows: 3, value: form.notes,
      onInput: (e) => { form.notes = e.target.value; },
    })),

    el('p', { class: 'caption' },
      'O lembrete viaja no arquivo .ics — exporte para o Calendário depois de salvar para o aviso valer.'),

    existing
      ? el('button', {
          class: 'btn danger',
          onClick: async () => {
            const ok = await confirmAction({
              title: 'Excluir evento?', message: existing.title,
              confirmLabel: 'Excluir', destructive: true,
            });
            if (!ok) return;
            await deleteEvent(existing.id);
            toast('Evento excluído.');
            rerender();
          },
        }, 'Excluir evento')
      : null,
  ]);

  openSheet({
    title: existing ? 'Editar evento' : 'Novo evento',
    body,
    onConfirm: async () => {
      await saveEvent({
        id: existing?.id,
        createdAt: existing?.createdAt,
        title: form.title,
        date: form.date,
        time: form.time || null,
        notes: form.notes,
        reminderMinutes: [Number(form.reminder)],
      });
      toast('Evento salvo.');
      rerender();
      return true;
    },
  });
}

function rerender() {
  window.dispatchEvent(new CustomEvent('norte:rerender'));
}
