-- =============================================================================
-- Norte — Row Level Security
-- =============================================================================
--
-- ESTE É O ARQUIVO QUE PROTEGE OS DADOS. O schema sozinho não protege nada.
--
-- O Supabase expõe cada tabela como API REST pública, e a chave `anon` que
-- vai dentro do app é visível para qualquer pessoa que abra o código-fonte da
-- página — isso é por desenho, não é vazamento. O que impede um usuário de
-- ler os lançamentos de outro é exclusivamente a RLS.
--
-- Sem rodar este arquivo, qualquer pessoa com uma conta no app leria e
-- apagaria os dados financeiros de todo mundo.
--
-- A regra é sempre a mesma: você só enxerga as linhas em que `user_id` é
-- você. `with check` cobre a inserção e a atualização — sem ele, dá para
-- gravar uma linha carimbada com o id de outra pessoa.
--
-- Execute depois de 01_schema.sql.
-- =============================================================================

alter table public.profiles        enable row level security;
alter table public.accounts        enable row level security;
alter table public.categories      enable row level security;
alter table public.plans           enable row level security;
alter table public.goals           enable row level security;
alter table public.transactions    enable row level security;
alter table public.contributions   enable row level security;
alter table public.notes           enable row level security;
alter table public.events          enable row level security;
alter table public.external_events enable row level security;
alter table public.settings        enable row level security;

-- -----------------------------------------------------------------------------
-- Perfis — a chave é `id`, não `user_id`
-- -----------------------------------------------------------------------------

drop policy if exists "perfil proprio" on public.profiles;
create policy "perfil proprio" on public.profiles
  for all
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Demais tabelas
-- -----------------------------------------------------------------------------
-- Uma política `for all` por tabela, escrita em laço para não haver a chance
-- de esquecer uma — que é exatamente como esse tipo de falha acontece.
--
-- `(select auth.uid())` em vez de `auth.uid()` puro é proposital: o Postgres
-- avalia a subconsulta uma vez e reaproveita, em vez de chamar a função a
-- cada linha. Em tabelas com muitos lançamentos a diferença é grande.

do $rls$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'plans', 'goals', 'transactions',
    'contributions', 'notes', 'events', 'external_events', 'settings'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', 'dados proprios', t);
    execute format(
      'create policy %I on public.%I for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      'dados proprios', t
    );
  end loop;
end;
$rls$;

-- -----------------------------------------------------------------------------
-- Conferência
-- -----------------------------------------------------------------------------
-- Rode isto depois. Toda linha precisa vir com rls = true e policies = 1.
-- Uma tabela com rls = false é uma tabela aberta ao mundo.

select
  c.relname                                     as tabela,
  c.relrowsecurity                              as rls,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- =============================================================================
-- Correções de auditoria (17/10/2026)
-- =============================================================================
-- Duas falhas encontradas testando duas contas reais uma contra a outra.

-- 1. ESCALADA DE PRIVILÉGIO. Um membro comum se promovia a admin com um
--    PATCH no próprio perfil, e dali podia convidar pessoas e gerar links de
--    acesso. A tentativa original era `revoke update (role) ... from
--    authenticated`, que NÃO funciona: no Postgres, revogar uma coluna não
--    subtrai de um GRANT dado na tabela inteira — e o Supabase concede a
--    tabela inteira a `authenticated` por padrão. A revogação foi aceita sem
--    erro e não teve efeito nenhum.
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

create or replace function public.proteger_papel()
returns trigger language plpgsql security definer set search_path = public
as $papel$
declare
  quem text := coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role', 'postgres');
begin
  if new.role is distinct from old.role and quem not in ('service_role', 'postgres') then
    raise exception 'O papel so pode ser alterado pelo servidor.';
  end if;
  return new;
end;
$papel$;
revoke execute on function public.proteger_papel() from public, anon, authenticated;
drop trigger if exists proteger_papel on public.profiles;
create trigger proteger_papel before update on public.profiles
  for each row execute function public.proteger_papel();

-- 2. FUNÇÃO EXPOSTA NA API. Tudo que vive em `public` vira endpoint em
--    /rest/v1/rpc/. `is_admin()` é SECURITY DEFINER e precisa ser executável
--    por `authenticated` (a política de profiles a chama), mas não precisa
--    ser chamável de fora. Mudou para um schema que o PostgREST não publica.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = public
as $is_admin$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$is_admin$;
grant execute on function private.is_admin() to authenticated;

drop policy if exists "admin ve todos os perfis" on public.profiles;
create policy "admin ve todos os perfis" on public.profiles
  for select using (private.is_admin());

drop function if exists public.is_admin();

-- 3. Diz se uma conta já definiu senha. A função `convidar` usa isto para
--    recusar gerar link de acesso a conta ativa: sem a trava, um admin
--    pediria um link para o e-mail de outra pessoa e entraria na conta dela.
create or replace function public.conta_ativada(p_email text)
returns boolean language sql stable security definer set search_path = auth, public
as $ativada$
  select coalesce((select coalesce(u.encrypted_password, '') <> '' from auth.users u
                    where lower(u.email) = lower(p_email) limit 1), false);
$ativada$;
revoke execute on function public.conta_ativada(text) from public, anon, authenticated;
grant execute on function public.conta_ativada(text) to service_role;
