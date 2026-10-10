/**
 * Formatação pt-BR.
 *
 * Dinheiro é SEMPRE inteiro em centavos no app inteiro. JavaScript não tem
 * decimal: `0.1 + 0.2` dá `0.30000000000000004`, e somar lançamento é
 * exatamente o tipo de conta onde esse erro aparece no extrato do usuário.
 * Converter para reais só acontece na hora de exibir.
 */

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PERCENT = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });

const DATE_SHORT = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const DATE_MEDIUM = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
const DATE_DAY = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const DATE_MONTH = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function money(cents) {
  return BRL.format((cents ?? 0) / 100);
}

/** "+ R$ 500,00" / "− R$ 500,00" — o sinal vem do tipo, não do valor. */
export function signedMoney(cents, kind) {
  const text = money(Math.abs(cents ?? 0));
  if (kind === 'income') return `+ ${text}`;
  if (kind === 'expense') return `− ${text}`; // U+2212, alinha melhor que hífen
  return text;
}

/**
 * Converte o que o usuário digitou em centavos.
 * Aceita "1234,56", "1.234,56", "1234.56" e "1234".
 */
export function parseMoney(input) {
  if (typeof input === 'number') return Math.round(input * 100);
  const raw = String(input ?? '').trim();
  if (!raw) return 0;

  // Se tem vírgula, ela é o separador decimal e o ponto é de milhar (pt-BR).
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;

  const value = Number.parseFloat(normalized.replace(/[^\d.-]/g, ''));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

export function percent(fraction) {
  return PERCENT.format(Math.max(0, Math.min(1, fraction || 0)));
}

export const fmtShortDate = (d) => DATE_SHORT.format(toDate(d));
export const fmtDate = (d) => DATE_MEDIUM.format(toDate(d));
export const fmtDayHeader = (d) => capitalize(DATE_DAY.format(toDate(d)));
export const fmtMonth = (d) => capitalize(DATE_MONTH.format(toDate(d)));
export const fmtDateTime = (d) => DATE_TIME.format(toDate(d));

/** "coletado em 07/10/2026 11:03" — todo preço exibido precisa disso. */
export const fmtCollectedAt = (d) => `coletado em ${fmtDateTime(d)}`;

function toDate(value) {
  if (value instanceof Date) return value;

  const text = String(value);
  // `new Date('2026-10-01')` é interpretado como UTC pela especificação, e no
  // Brasil (UTC−3) isso volta 30/09 21:00 — o mês inteiro aparece errado no
  // cabeçalho e a parcela "muda de dia". Datas puras são parseadas local.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return fromISODate(text);

  return new Date(text);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- Datas como texto ISO curto (yyyy-mm-dd) -------------------------------
// Guardamos datas assim no banco: comparável como string, imune a fuso e
// legível no backup. `new Date('2026-11-10')` seria interpretado como UTC e
// poderia voltar como dia 9 à noite no Brasil — daí o parse manual.

export function toISODate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function fromISODate(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function todayISO() {
  return toISODate(new Date());
}

/** Soma meses preservando o fim de mês (31/01 + 1 mês = 28/02). */
export function addMonthsISO(iso, months) {
  const date = fromISODate(iso);
  const targetDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(targetDay, lastDay));
  return toISODate(date);
}

export function monthKey(iso) {
  return String(iso).slice(0, 7); // yyyy-mm
}

export function daysBetween(isoA, isoB) {
  const ms = fromISODate(isoB) - fromISODate(isoA);
  return Math.round(ms / 86_400_000);
}

/**
 * Deixa passar só `https:`, para URLs que vieram de fora.
 *
 * O assistente propõe link de produto e imagem, e o cartão de fontes exibe o
 * que a busca devolveu. Nada disso foi escrito por nós. Um `javascript:` ali
 * viraria código executado no clique, com a sessão do usuário — e o caminho
 * até lá é curto: basta uma página que o modelo leia conter a instrução.
 *
 * `http:` também fica de fora: o app é servido por https, e um recurso em
 * http seria bloqueado pelo navegador de qualquer forma.
 */
export function safeURL(valor) {
  const limpo = typeof valor === 'string' ? valor.trim() : '';
  if (!limpo) return null;
  try {
    const url = new URL(limpo);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
