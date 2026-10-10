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
