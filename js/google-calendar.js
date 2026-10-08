/**
 * Google Calendar, somente leitura, direto do navegador.
 *
 * Sem servidor: usa o Google Identity Services (GIS), que é o caminho que o
 * Google oferece para aplicações que rodam inteiras no navegador. O
 * *client ID* é público por natureza — não existe segredo aqui, e por isso
 * dá para publicar o site num repositório aberto sem expor nada.
 *
 * O token de acesso **não é guardado em lugar nenhum**: vive em memória e
 * dura cerca de uma hora. Ao reabrir o app, pedimos um novo em silêncio —
 * o Google devolve sem perguntar nada, porque a autorização já foi dada.
 * Guardar o token em localStorage seria mais cômodo e menos seguro.
 *
 * Escopo pedido: `calendar.readonly`. O app lê a agenda e nunca escreve.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

let gisPromise = null;
let tokenClient = null;
let accessToken = null;
let expiresAt = 0;

export class GoogleCalendarError extends Error {
  constructor(message, { needsConsent = false, cause } = {}) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.needsConsent = needsConsent;
    this.cause = cause;
  }
}

/** Carrega o SDK do Google uma única vez. */
function loadGIS() {
  if (gisPromise) return gisPromise;

  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google);

    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve(window.google);
      else reject(new GoogleCalendarError('O SDK do Google carregou incompleto.'));
    };
    script.onerror = () => {
      gisPromise = null;
      reject(new GoogleCalendarError(
        'Não consegui carregar o Google. Verifique sua conexão — esta parte do app precisa de internet.',
      ));
    };
    document.head.append(script);
  });

  return gisPromise;
}

function ensureTokenClient(clientId) {
  if (tokenClient && tokenClient.__clientId === clientId) return tokenClient;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GOOGLE_SCOPE,
    callback: () => {}, // substituído a cada pedido
  });
  tokenClient.__clientId = clientId;
  return tokenClient;
}

export function hasValidToken() {
  return Boolean(accessToken) && Date.now() < expiresAt - 60_000;
}

export function forgetToken() {
  accessToken = null;
  expiresAt = 0;
}

/**
 * Pede um token de acesso.
 *
 * @param {boolean} interactive `false` tenta em silêncio (sem janela), o que
 *   funciona quando o usuário já autorizou antes. É o que roda ao abrir o app.
 */
export async function requestToken(clientId, { interactive = true } = {}) {
  if (!clientId) throw new GoogleCalendarError('Client ID do Google não configurado.');
  if (hasValidToken()) return accessToken;

  await loadGIS();
  const client = ensureTokenClient(clientId);

  return new Promise((resolve, reject) => {
    client.callback = (response) => {
      if (response.error) {
        // `consent_required` e afins: só dá para resolver com a janela aberta.
        reject(new GoogleCalendarError(
          describeError(response.error),
          { needsConsent: !interactive },
        ));
        return;
      }
      accessToken = response.access_token;
      expiresAt = Date.now() + (Number(response.expires_in ?? 3600) * 1000);
      resolve(accessToken);
    };

    client.error_callback = (error) => {
      reject(new GoogleCalendarError(describeError(error?.type ?? 'unknown'), { needsConsent: true }));
    };

    try {
      // `prompt: ''` evita reperguntar a quem já autorizou.
      client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (error) {
      reject(new GoogleCalendarError('Não consegui abrir a janela de autorização.', { cause: error }));
    }
  });
}

function describeError(code) {
  switch (code) {
    case 'popup_closed':
    case 'popup_failed_to_open':
      return 'A janela de autorização não abriu ou foi fechada. Se você está usando o app pelo ícone da tela de início, tente conectar pelo Safari e depois volte.';
    case 'access_denied':
      return 'Você recusou o acesso à agenda.';
    case 'consent_required':
    case 'interaction_required':
      return 'O Google pediu uma nova autorização.';
    default:
      return `O Google recusou a autorização (${code}).`;
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function call(path, token, params = {}) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

  if (response.status === 401 || response.status === 403) {
    forgetToken();
    throw new GoogleCalendarError(
      'A autorização expirou ou foi revogada. Conecte a conta de novo.',
      { needsConsent: true },
    );
  }
  if (!response.ok) {
    throw new GoogleCalendarError(`O Google respondeu ${response.status}.`);
  }
  return response.json();
}

export async function listCalendars(token) {
  const data = await call('users/me/calendarList', token, { minAccessRole: 'reader', maxResults: 100 });
  return (data.items ?? []).map((item) => ({
    id: item.id,
    name: item.summaryOverride ?? item.summary ?? item.id,
    color: item.backgroundColor ?? null,
    primary: Boolean(item.primary),
    selected: item.selected !== false,
  }));
}

/**
 * Eventos futuros de uma agenda.
 *
 * `singleEvents: true` faz o Google expandir as repetições em ocorrências
 * individuais — sem isso, um compromisso semanal viria como uma regra só e
 * não apareceria nos dias certos.
 */
export async function listEvents(token, calendarId, { days = 120 } = {}) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);

  const data = await call(`calendars/${encodeURIComponent(calendarId)}/events`, token, {
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: 250,
    showDeleted: 'false',
  });

  return (data.items ?? [])
    .filter((item) => item.status !== 'cancelled')
    .map((item) => normalize(item, calendarId));
}

function normalize(item, calendarId) {
  // `date` = dia inteiro; `dateTime` = com hora.
  const startDate = item.start?.date ?? null;
  const startDateTime = item.start?.dateTime ?? null;

  let date;
  let time = null;

  if (startDate) {
    date = startDate;
  } else if (startDateTime) {
    const parsed = new Date(startDateTime);
    date = localISODate(parsed);
    time = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  } else {
    return null;
  }

  return {
    id: `gcal-${item.id}`,
    title: item.summary ?? '(sem título)',
    date,
    time,
    notes: item.location ?? '',
    kind: 'external',
    source: 'google',
    calendarId,
    done: false,
    reminderMinutes: [],
  };
}

function localISODate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** Busca tudo de uma vez, tolerando falha de uma agenda específica. */
export async function fetchAllEvents(token, calendarIds, options) {
  const results = await Promise.allSettled(
    calendarIds.map((id) => listEvents(token, id, options)),
  );

  const events = [];
  const failures = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') events.push(...result.value.filter(Boolean));
    else failures.push({ calendarId: calendarIds[index], reason: result.reason?.message });
  });

  return { events, failures };
}
