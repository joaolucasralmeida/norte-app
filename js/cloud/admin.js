/**
 * Administração de pessoas.
 *
 * Convidar alguém exige a chave `service_role`, que ignora a Row Level
 * Security inteira. Ela não pode existir no navegador — por isso o convite
 * passa pela função `convidar`, que roda no servidor do Supabase e confere
 * lá se quem pediu é admin.
 *
 * A checagem de papel aqui no cliente serve só para esconder o formulário de
 * quem não é admin. Ela não protege nada: quem editar o JavaScript da página
 * faz o botão aparecer. O que protege é a conferência no servidor.
 */

import { SUPABASE_URL } from './config.js';
import { getClient } from './client.js';

/** Papel da pessoa logada, lido do banco (a RLS garante que é o dela). */
export async function meuPapel() {
  const client = await getClient();
  const { data: sessao } = await client.auth.getSession();
  const id = sessao?.session?.user?.id;
  if (!id) return null;

  const { data, error } = await client.from('profiles').select('role, full_name').eq('id', id).single();
  if (error) return null;
  return data;
}

/** Lista de pessoas. Só retorna algo para admin — a política cuida disso. */
export async function listarPessoas() {
  const client = await getClient();
  const { data, error } = await client
    .from('profiles')
    .select('id, full_name, role, created_at')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

const MENSAGENS = {
  ja_cadastrado: 'Essa pessoa já tem conta no Norte.',
  apenas_admin: 'Só um administrador pode convidar.',
  nao_autenticado: 'Sua sessão expirou. Entre de novo.',
  token_invalido: 'Sua sessão expirou. Entre de novo.',
  email_invalido: 'Esse e-mail não parece válido.',
  falha_no_convite: 'O servidor recusou o convite.',
};

export async function convidar(email, nome) {
  const client = await getClient();
  const { data } = await client.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Sua sessão expirou. Entre de novo.');

  const resposta = await fetch(`${SUPABASE_URL}/functions/v1/convidar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, nome }),
  });

  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    throw new Error(MENSAGENS[corpo.erro] ?? corpo.detalhe ?? 'Não consegui enviar o convite.');
  }
  return corpo;
}
