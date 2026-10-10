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
