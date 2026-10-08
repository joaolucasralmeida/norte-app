/**
 * Conexão com o Supabase: carga da biblioteca e autenticação.
 *
 * A biblioteca é servida de `vendor/supabase.js`, do nosso próprio domínio, e
 * não de um CDN. O motivo é o app ser instalado na tela de início: um import
 * de CDN falharia toda vez que o aparelho estivesse sem rede, e o app não
 * abriria — mesmo tendo todos os dados em cache. Servindo daqui, o service
 * worker guarda o arquivo junto com o resto.
 *
 * É uma build UMD, que publica a variável global `supabase` em vez de
 * exportar módulos. Daí o `<script>` injetado em vez de um `import`.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, cloudConfigured } from './config.js';

let clientPromise = null;

function carregarBiblioteca() {
  if (window.supabase?.createClient) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('vendor/supabase.js', document.baseURI).href;
    script.onload = () => (window.supabase?.createClient
      ? resolve()
      : reject(new Error('A biblioteca do Supabase carregou mas não expôs createClient.')));
    script.onerror = () => reject(new Error('Não consegui carregar a biblioteca do Supabase.'));
    document.head.append(script);
  });
}

export function getClient() {
  if (!cloudConfigured()) {
    return Promise.reject(new Error('A sincronização não está configurada neste app.'));
  }

  if (!clientPromise) {
    clientPromise = carregarBiblioteca().then(() => window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      {
        auth: {
          // A sessão sobrevive a fechar o app — senão seria preciso logar a
          // cada abertura, o que num app de tela de início é inviável.
          persistSession: true,
          autoRefreshToken: true,
          storageKey: 'norte.auth',
          // `detectSessionInUrl` lida com o link do convite por e-mail, que
          // chega com o token no fragmento da URL.
          detectSessionInUrl: true,
        },
      },
    ));
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

export async function currentSession() {
  if (!cloudConfigured()) return null;
  try {
    const client = await getClient();
    const { data } = await client.auth.getSession();
    return data.session ?? null;
  } catch {
    // Sem rede, `getSession` ainda devolve a sessão guardada localmente; se
    // falhar de verdade, tratamos como deslogado e o app segue offline.
    return null;
  }
}

export async function signIn(email, senha) {
  const client = await getClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password: senha,
  });
  if (error) throw new Error(traduzir(error));
  return data.session;
}

export async function signOut() {
  const client = await getClient();
  await client.auth.signOut();
}

export async function sendReset(email) {
  const client = await getClient();
  const { error } = await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: new URL('./', document.baseURI).href,
  });
  if (error) throw new Error(traduzir(error));
}

export async function updatePassword(nova) {
  const client = await getClient();
  const { error } = await client.auth.updateUser({ password: nova });
  if (error) throw new Error(traduzir(error));
}

export async function onAuthChange(callback) {
  const client = await getClient();
  client.auth.onAuthStateChange((evento, sessao) => callback(evento, sessao));
}

/**
 * As mensagens do Supabase vêm em inglês e algumas são enigmáticas para quem
 * só quer entrar no app. Traduzimos as que a pessoa realmente encontra.
 */
function traduzir(error) {
  const texto = String(error?.message ?? '');

  if (/invalid login credentials/i.test(texto)) return 'E-mail ou senha incorretos.';
  if (/email not confirmed/i.test(texto)) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
  if (/password should be at least/i.test(texto)) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (/for security purposes|rate limit|too many/i.test(texto)) {
    return 'Muitas tentativas seguidas. Espere um minuto e tente de novo.';
  }
  if (/failed to fetch|network/i.test(texto)) return 'Sem conexão com o servidor.';
  return texto || 'Não consegui completar a operação.';
}
