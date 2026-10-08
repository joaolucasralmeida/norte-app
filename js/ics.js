/**
 * Geração de arquivo .ics (RFC 5545).
 *
 * Este arquivo é o que substitui EventKit **e** as notificações locais do app
 * nativo — e é a parte mais importante desta versão web.
 *
 * A ideia: em vez de tentar fazer o navegador notificar (o que no iOS exigiria
 * Web Push, e Web Push exige um servidor mandando no horário certo), exportamos
 * os vencimentos como um arquivo de calendário. O usuário abre, o iOS importa
 * para o app Calendário, e é o **próprio sistema** que dispara os alertas — de
 * graça, no horário certo, mesmo com o web app fechado, e com confiabilidade
 * que nenhuma solução web alcança.
 *
 * O preço: é uma exportação pontual, não uma sincronização. Mudou a parcela?
 * Exporte de novo. Para evitar evento duplicado, cada um leva um UID estável
 * derivado do id da transação: calendários sérios (o do iOS inclusive) tratam
 * reimportação do mesmo UID como atualização, não como cópia.
 */

import { EVENT_KINDS } from './domain.js';
import { money } from './format.js';

const PRODID = '-//Norte//App de Financas Pessoais//PT-BR';

export function buildICS(events, { calendarName = 'Norte' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    'X-WR-TIMEZONE:America/Sao_Paulo',
  ];

  for (const event of events) {
    lines.push(...buildEvent(event));
  }

  lines.push('END:VCALENDAR');
  return lines.flatMap(foldLine).join('\r\n') + '\r\n';
}

function buildEvent(event) {
  const kind = EVENT_KINDS[event.kind] ?? EVENT_KINDS.manual;
  const stamp = toUTCStamp(new Date());

  const description = [
    event.amountCents ? `Valor: ${money(event.amountCents)}` : '',
    event.notes ?? '',
    'Gerado pelo Norte',
  ].filter(Boolean).join('\\n');

  const lines = [
    'BEGIN:VEVENT',
    // UID estável: reimportar atualiza em vez de duplicar.
    `UID:${event.id}@norte.app`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${description}`,
    `CATEGORIES:${escapeText(kind.label)}`,
  ];

  if (event.time) {
    // Hora local sem Z e sem TZID: o calendário interpreta no fuso do
    // aparelho, que é o que o usuário espera de um compromisso pessoal.
    const start = `${compactDate(event.date)}T${event.time.replace(':', '')}00`;
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${addMinutes(start, 30)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(nextDay(event.date))}`);
  }

  // Repetição: "FREQ=WEEKLY", "FREQ=MONTHLY" etc. Um único evento recorrente
  // cobre o ano inteiro sem encher o calendário de entradas soltas.
  if (event.rrule) lines.push(`RRULE:${event.rrule}`);

  if (event.done) {
    lines.push('STATUS:CANCELLED');
  } else {
    lines.push('STATUS:CONFIRMED');
    for (const minutes of event.reminderMinutes ?? []) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(event.title)}`,
        `TRIGGER:${toTrigger(minutes)}`,
        'END:VALARM',
      );
    }
  }

  lines.push('END:VEVENT');
  return lines;
}

/** -1440 min → "-P1D"; -60 → "-PT1H"; 0 → "PT0S". */
function toTrigger(minutes) {
  if (minutes === 0) return 'PT0S';
  const absolute = Math.abs(minutes);
  const sign = minutes < 0 ? '-' : '';

  if (absolute % 1440 === 0) return `${sign}P${absolute / 1440}D`;
  if (absolute % 60 === 0) return `${sign}PT${absolute / 60}H`;
  return `${sign}PT${absolute}M`;
}

function compactDate(iso) {
  return String(iso).replace(/-/g, '');
}

function nextDay(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const date = new Date(year, month - 1, day + 1);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function addMinutes(compact, minutes) {
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const hour = Number(compact.slice(9, 11));
  const minute = Number(compact.slice(11, 13));

  const date = new Date(year, month - 1, day, hour, minute + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

function toUTCStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escapa os caracteres que o formato reserva (RFC 5545 §3.3.11). */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Dobra linhas acima de 75 octetos. Parsers rigorosos recusam o arquivo
 * inteiro sem isso, e um título longo de parcela passa fácil do limite.
 */
function foldLine(line) {
  const limit = 73;
  if (line.length <= limit) return [line];

  const parts = [line.slice(0, limit)];
  let rest = line.slice(limit);
  while (rest.length > limit - 1) {
    parts.push(' ' + rest.slice(0, limit - 1));
    rest = rest.slice(limit - 1);
  }
  if (rest) parts.push(' ' + rest);
  return parts;
}

/**
 * Entrega o arquivo ao usuário.
 *
 * No iOS, `share()` com arquivo abre a folha nativa e o Calendário aparece
 * como destino — é o caminho que menos atrito tem. Quando não há suporte,
 * cai para download comum, e o Safari oferece "Abrir no Calendário".
 */
export async function shareICS(events, filename = 'norte-calendario.ics') {
  const content = buildICS(events);
  const file = new File([content], filename, { type: 'text/calendar' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Calendário do Norte' });
      return { shared: true };
    } catch (error) {
      if (error.name === 'AbortError') return { shared: false, cancelled: true };
      // Qualquer outra falha cai no download abaixo.
    }
  }

  const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { shared: false, downloaded: true };
}
