/**
 * Endereço do projeto no Supabase.
 *
 * Estes dois valores são **públicos por desenho** — eles vão dentro da página
 * e qualquer pessoa consegue lê-los no código-fonte. Não é descuido nem
 * vazamento: a chave `anon` não dá acesso a nada sozinha.
 *
 * O que separa os seus dados dos de outro usuário é a Row Level Security do
 * banco (supabase/02_rls.sql), que roda do lado do servidor e não tem como
 * ser contornada pelo navegador. Se a RLS não estiver ligada, nenhuma
 * precaução aqui adianta.
 *
 * A chave que NÃO pode aparecer aqui é a `service_role`: essa ignora a RLS.
 * Ela nunca deve sair do servidor.
 */

export const SUPABASE_URL = 'https://jkzsucknezplwedrigjo.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_3DBiBrg6lkDO2Hx9D8fFzg_1mwOb4_4';

/** Sem configuração, o app funciona como sempre funcionou: só neste aparelho. */
export const cloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/**
 * Endereço do assistente de IA.
 *
 * Fica aqui, no código, e não numa configuração que cada pessoa precisa
 * digitar em cada aparelho. O endereço é o mesmo para todo mundo e não é
 * segredo: as chaves do Gemini e da Tavily vivem dentro do Worker, que nunca
 * as devolve. O que o app manda para cá é só a pergunta.
 *
 * Era uma configuração por um motivo que deixou de existir: antes o servidor
 * não estava publicado, e cada um apontava para o seu. Hoje há um só.
 */
export const ASSISTANT_URL = 'https://norte-assistente.duo-marketing.workers.dev';
