/**
 * Backup e restauração.
 *
 * Isto não é um extra: é o que impede você de perder tudo.
 *
 * Os dados vivem apenas no armazenamento deste navegador. A Apple afirma que
 * o apagamento automático de 7 dias do Safari não vale para web apps na tela
 * de início, mas há relatos de desenvolvedores em contrário e nenhuma
 * documentação atual que garanta. Some-se a isso o óbvio: trocar de aparelho,
 * apagar o ícone ou limpar os dados do site zera tudo.
 *
 * Por isso o app insiste no backup e mostra há quanto tempo foi o último.
 */

import * as db from './db.js';
import { state, setSetting } from './store.js';
import { money, fmtDate, toISODate } from './format.js';

export const SCHEMA = 'norte.web.backup/1';
const LAST_BACKUP_KEY = 'lastBackupAt';
/**
 * Acima disso, a tela inicial passa a cobrar um backup.
 * Uma semana: curto o bastante para a perda doer pouco, longo o bastante
 * para o aviso não virar paisagem.
 */
export const BACKUP_WARNING_DAYS = 7;

export function buildBackup() {
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    app: 'Norte Web',
    counts: {
      accounts: state.accounts.length,
      transactions: state.transactions.length,
      goals: state.goals.length,
      contributions: state.contributions.length,
      notes: state.notes.length,
      events: state.events.length,
    },
    data: {
      accounts: state.accounts,
      categories: state.categories,
      transactions: state.transactions,
      plans: state.plans,
      goals: state.goals,
      contributions: state.contributions,
      notes: state.notes,
      events: state.events,
      quotes: state.quotes,
      meta: Object.entries(state.settings).map(([key, value]) => ({ key, value })),
    },
  };
}

export async function exportBackup() {
  const payload = buildBackup();
  const filename = `norte-backup-${toISODate(new Date())}.json`;
  const content = JSON.stringify(payload, null, 2);
  const file = new File([content], filename, { type: 'application/json' });

  let delivered = false;

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Backup do Norte' });
      delivered = true;
    } catch (error) {
      if (error.name === 'AbortError') return { cancelled: true };
    }
  }

  if (!delivered) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  await setSetting(LAST_BACKUP_KEY, new Date().toISOString());
  return { filename, size: content.length };
}

/**
 * Restaura substituindo tudo.
 *
 * Mesclar seria pior: sem servidor e sem relógio comum não dá para decidir
 * qual versão de um registro é a mais recente, e o resultado seriam
 * duplicatas silenciosas num extrato financeiro. Substituir é previsível, e
 * a tela avisa antes.
 */
export async function importBackup(fileOrText) {
  const text = typeof fileOrText === 'string' ? fileOrText : await fileOrText.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Este arquivo não é um backup válido do Norte.');
  }

  if (payload?.schema !== SCHEMA || typeof payload.data !== 'object') {
    throw new Error('Formato de backup não reconhecido.');
  }

  const data = payload.data;
  await db.clearAll();

  for (const store of ['accounts', 'categories', 'transactions', 'plans',
                       'goals', 'contributions', 'notes', 'events', 'quotes']) {
    const rows = Array.isArray(data[store]) ? data[store] : [];
    await db.putMany(store, rows);
  }
  if (Array.isArray(data.meta)) await db.putMany('meta', data.meta);

  return {
    generatedAt: payload.generatedAt,
    counts: payload.counts ?? {},
  };
}

export function lastBackupAt() {
  const raw = state.settings[LAST_BACKUP_KEY];
  return raw ? new Date(raw) : null;
}

export function backupStatus() {
  const last = lastBackupAt();
  if (!last) {
    return {
      level: state.transactions.length > 0 ? 'warn' : 'none',
      text: 'Você ainda não fez backup.',
    };
  }

  const days = Math.floor((Date.now() - last.getTime()) / 86_400_000);
  if (days >= BACKUP_WARNING_DAYS) {
    return { level: 'warn', text: `Último backup há ${days} dias (${fmtDate(last)}).` };
  }
  return { level: 'ok', text: `Último backup: ${fmtDate(last)}.` };
}

/**
 * Evento recorrente semanal para o app Calendário do iPhone.
 *
 * É o mais perto de "backup automático" que dá para chegar sem servidor:
 * o iOS não tem API de execução periódica em segundo plano para web apps —
 * `Periodic Background Sync` não existe no Safari — então ninguém consegue
 * gerar um arquivo sozinho enquanto o app está fechado. O que dá para fazer
 * é garantir que **você** seja lembrado no horário certo, e aí é um toque.
 */
export function backupReminderEvent({ weekday = 0, hour = 20 } = {}) {
  // Próximo domingo às 20h, repetindo toda semana.
  const start = new Date();
  start.setDate(start.getDate() + ((weekday - start.getDay() + 7) % 7 || 7));

  return {
    id: 'norte-backup-semanal',
    title: 'Fazer backup do Norte',
    date: toISODate(start),
    time: `${String(hour).padStart(2, '0')}:00`,
    notes: 'Abra o Norte, vá em Configurações e toque em Exportar backup. Leva 10 segundos.',
    kind: 'manual',
    rrule: 'FREQ=WEEKLY',
    reminderMinutes: [0],
    done: false,
  };
}

/** Resumo em texto do que há no app — usado na tela de Configurações. */
export function dataSummary() {
  const totalCents = state.transactions.reduce((sum, t) => sum + t.amountCents, 0);
  return [
    `${state.transactions.length} lançamentos`,
    `${state.goals.length} metas`,
    `${state.notes.length} anotações`,
    `movimentando ${money(totalCents)}`,
  ].join(' · ');
}
