-- =============================================================================
-- Norte — colunas de sincronização
-- =============================================================================
--
-- Acrescenta o que falta para dois aparelhos conversarem. Idempotente: pode
-- rodar antes ou depois do 01, e mais de uma vez.
--
-- `updated_at` resolve "quem ganha". Os dois aparelhos podem alterar a mesma
-- meta sem saber um do outro; na hora de juntar, vence a alteração mais
-- recente. Não é perfeito — se você editar o título no celular e o valor no
-- PC no mesmo minuto, uma das duas edições se perde inteira. É o custo de não
-- ter um servidor mediando cada tecla, e para um app pessoal é aceitável.
--
-- `deleted_at` existe porque apagar de verdade não sincroniza. Se o celular
-- some com um lançamento e o PC nunca ouve falar disso, na próxima sincronia
-- o PC reenvia o registro e ele ressuscita. A linha some da tela, mas fica no
-- banco marcada — é a única forma de a exclusão viajar entre aparelhos.
--
-- Execute depois de 01_schema.sql e 02_rls.sql.
-- =============================================================================

do $sync$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'plans', 'goals', 'transactions',
    'contributions', 'notes', 'events'
  ]
  loop
    execute format(
      'alter table public.%I add column if not exists updated_at timestamptz not null default now()', t);
    execute format(
      'alter table public.%I add column if not exists deleted_at timestamptz', t);

    -- A sincronização pergunta "o que mudou desde a última vez?". Sem este
    -- índice, a pergunta varre a tabela toda a cada abertura do app.
    execute format(
      'create index if not exists %I on public.%I (user_id, updated_at desc)',
      t || '_sync_idx', t);
  end loop;
end;
$sync$;

-- `external_events` fica de fora de propósito: ela é espelho de outra agenda,
-- e a sincronização dela já é "apaga tudo daquela origem e regrava".

-- A anotação tem um "editado em" que é dela, mostrado ao usuário, e que não
-- é a mesma coisa que o `updated_at` da sincronização — este último muda
-- também quando o servidor só recebe o registro de volta. Misturar os dois
-- faria o Diário exibir datas de edição que nunca aconteceram.
alter table public.notes add column if not exists edited_at timestamptz;

-- -----------------------------------------------------------------------------
-- Carimbo automático
-- -----------------------------------------------------------------------------
-- Em vez de confiar que todo caminho de escrita lembre de atualizar o campo.
-- O cliente pode esquecer; o banco não.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $touch$
begin
  new.updated_at := now();
  return new;
end;
$touch$;

do $triggers$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'plans', 'goals', 'transactions',
    'contributions', 'notes', 'events'
  ]
  loop
    execute format('drop trigger if exists touch_%I on public.%I', t, t);
    execute format(
      'create trigger touch_%I before update on public.%I for each row execute function public.touch_updated_at()',
      t, t);
  end loop;
end;
$triggers$;

-- -----------------------------------------------------------------------------
-- Conferência
-- -----------------------------------------------------------------------------

select table_name, count(*) filter (where column_name in ('updated_at', 'deleted_at')) as colunas_de_sync
from information_schema.columns
where table_schema = 'public'
  and table_name in ('accounts', 'categories', 'plans', 'goals', 'transactions',
                     'contributions', 'notes', 'events')
group by table_name
order by table_name;
-- Todas precisam vir com colunas_de_sync = 2.
