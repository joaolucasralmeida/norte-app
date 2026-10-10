/**
 * Convida alguém para o Norte, por e-mail.
 *
 * Roda no servidor porque criar usuário exige a chave `service_role`, que
 * ignora toda a Row Level Security. Essa chave não pode existir no navegador
 * em hipótese alguma — quem a tivesse leria e apagaria os dados de todos os
 * usuários. Aqui ela vem do ambiente da função e nunca sai daqui.
 *
 * Dois caminhos, e só dois:
 *
 * · **Primeiro acesso** — enquanto não houver NENHUM usuário no projeto, uma
 *   chamada sem autenticação pode criar o primeiro, como admin. É a única
 *   forma de sair do zero sem alguém digitar uma senha em algum lugar. A
 *   janela fecha sozinha e para sempre no instante em que o primeiro usuário
 *   existe: a partir daí esta porta responde 403.
 *
 * · **Convite normal** — exige um token válido de alguém com papel `admin`.
 *
 * O convidado recebe um link e define a própria senha. Senha nenhuma é
 * gerada, transmitida ou armazenada por este código.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  // Só o app publicado chama esta função. Sem a restrição, qualquer site
  // poderia usá-la como porta de entrada para disparar convites.
  'access-control-allow-origin': 'https://joaolucasralmeida.github.io',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  vary: 'origin',
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ erro: 'metodo_nao_permitido' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let corpo: { email?: string; nome?: string };
  try {
    corpo = await req.json();
  } catch {
    return json({ erro: 'json_invalido' }, 400);
  }

  const email = String(corpo.email ?? '').trim().toLowerCase();
  const nome = String(corpo.nome ?? '').trim().slice(0, 120);

  // Validação simples e suficiente: o Supabase valida de verdade depois.
  // O que importa aqui é não repassar lixo nem cabeçalho injetado.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    return json({ erro: 'email_invalido' }, 400);
  }

  // -------------------------------------------------------------------------
  // Quem está chamando?
  // -------------------------------------------------------------------------

  const { data: existentes, error: erroLista } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (erroLista) return json({ erro: 'falha_ao_verificar_usuarios' }, 500);

  const projetoVazio = (existentes?.users?.length ?? 0) === 0;
  let papel: 'admin' | 'member' = 'admin';

  if (!projetoVazio) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ erro: 'nao_autenticado' }, 401);

    const { data: autor, error: erroAutor } = await admin.auth.getUser(token);
    if (erroAutor || !autor?.user) return json({ erro: 'token_invalido' }, 401);

    const { data: perfil } = await admin
      .from('profiles')
      .select('role')
      .eq('id', autor.user.id)
      .single();

    if (perfil?.role !== 'admin') return json({ erro: 'apenas_admin' }, 403);
    papel = 'member';
  }

  // -------------------------------------------------------------------------
  // Convite
  // -------------------------------------------------------------------------

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: nome },
    redirectTo: 'https://joaolucasralmeida.github.io/norte-app/',
  });

  if (error) {
    // "já registrado" não é falha de sistema, é informação para quem convidou.
    const jaExiste = /already|registered|exists/i.test(error.message);
    return json({ erro: jaExiste ? 'ja_cadastrado' : 'falha_no_convite', detalhe: error.message },
      jaExiste ? 409 : 502);
  }

  // O gatilho `handle_new_user` já criou o perfil com papel 'member'. Só o
  // primeiro usuário precisa ser promovido, e isso não passa pelo navegador.
  if (papel === 'admin' && data.user) {
    await admin.from('profiles').update({ role: 'admin' }).eq('id', data.user.id);
  }

  return json({ ok: true, email, papel });
});
