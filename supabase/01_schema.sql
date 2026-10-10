-- =============================================================================
-- Norte — esquema do banco no Supabase
-- =============================================================================
--
-- Espelha as coleções que hoje vivem no IndexedDB do navegador (ver
-- web/js/db.js). Os nomes dos campos viram snake_case, convenção do Postgres;
-- o cliente JavaScript faz a tradução.
--
-- Duas decisões que valem explicação:
--
-- 1. `id` é TEXT, não UUID. O app gera o id no próprio aparelho com
--    `crypto.randomUUID()`, mas tem um caminho de reserva que produz
--    "id-abc123-xyz" quando a página não está em contexto seguro. Uma coluna
--    UUID recusaria esses registros na sincronização — e o erro só apareceria
--    no aparelho de alguém, meses depois.
--
-- 2. Dinheiro é BIGINT em centavos, nunca FLOAT. 0,1 + 0,2 não dá 0,3 em ponto
--    flutuante, e num app de finanças isso vira diferença de saldo que ninguém
--    consegue explicar. Mesma regra que o app já segue.
--
-- Execute no SQL Editor do Supabase, de uma vez só.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Perfis
-- -----------------------------------------------------------------------------
-- `auth.users` é gerenciada pelo Supabase e não deve ser alterada. Qualquer
-- dado nosso sobre a pessoa mora aqui.

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  created_at  timestamptz not null default now()
);

-- Cria o perfil junto com a conta. Sem isto, todo cadastro dependeria de um
-- segundo passo que alguém esqueceria.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $func$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$func$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Financeiro
-- -----------------------------------------------------------------------------

create table if not exists public.accounts (
  id                     text primary key,
  user_id                uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name                   text not null,
  kind                   text not null default 'checking'
                           check (kind in ('checking', 'savings', 'cash', 'credit_card', 'goal_reserve', 'other')),
  initial_balance_cents  bigint not null default 0,
  color                  text,
  archived               boolean not null default false,
  sort_order             integer not null default 0,
  created_at             timestamptz not null default now()
);

create table if not exists public.categories (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name        text not null,
  icon        text,
  color       text,
  kind        text not null check (kind in ('expense', 'income')),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Plano de parcelamento. As parcelas em si são linhas de `transactions`
-- apontando para cá.
create table if not exists public.plans (
  id               text primary key,
  user_id          uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title            text not null,
  total_cents      bigint not null,
  count            integer not null check (count > 0),
  first_due_date   date not null,
  interval_months  integer not null default 1,
  created_at       timestamptz not null default now()
);

create table if not exists public.goals (
  id            text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title         text not null,
  target_cents  bigint not null check (target_cents > 0),
  target_date   date,
  priority      integer not null default 2 check (priority between 1 and 3),
  status        text not null default 'active' check (status in ('active', 'achieved', 'archived')),
  product_url   text,
  image_url     text,
  notes         text not null default '',
  created_at    timestamptz not null default now()
);

create table if not exists public.transactions (
  id                      text primary key,
  user_id                 uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title                   text not null default 'Lançamento',
  amount_cents            bigint not null check (amount_cents > 0),
  kind                    text not null check (kind in ('expense', 'income', 'transfer')),
  date                    date not null,
  account_id              text not null references public.accounts (id) on delete cascade,
  destination_account_id  text references public.accounts (id) on delete set null,
  category_id             text references public.categories (id) on delete set null,
  notes                   text not null default '',
  paid                    boolean not null default false,
  paid_at                 date,
  installment_index       integer not null default 0,
  installment_count       integer not null default 0,
  plan_id                 text references public.plans (id) on delete set null,
  goal_id                 text references public.goals (id) on delete set null,
  created_at              timestamptz not null default now(),

  -- As mesmas regras que o app aplica antes de gravar, repetidas aqui porque
  -- validação só no cliente é sugestão: quem chamar a API direto passa por
  -- cima dela.
  constraint transferencia_precisa_de_destino check (
    kind <> 'transfer' or (destination_account_id is not null and destination_account_id <> account_id)
  ),
  constraint transferencia_nao_tem_categoria check (
    kind <> 'transfer' or category_id is null
  )
);

create table if not exists public.contributions (
  id              text primary key,
  user_id         uuid not null references auth.users (id) on delete cascade default auth.uid(),
  goal_id         text not null references public.goals (id) on delete cascade,
  amount_cents    bigint not null check (amount_cents > 0),
  date            date not null,
  note            text not null default '',
  transaction_id  text references public.transactions (id) on delete set null,
  created_at      timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Diário e agenda
-- -----------------------------------------------------------------------------

create table if not exists public.notes (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title       text not null default '',
  body        text not null default '',
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.events (
  id                text primary key,
  user_id           uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title             text not null default 'Evento',
  date              date not null,
  time              time,
  notes             text not null default '',
  reminder_minutes  integer[] not null default '{-60}',
  created_at        timestamptz not null default now()
);

-- Agendas importadas (Google, arquivo .ics). São espelho de outra fonte: a
-- sincronização apaga e regrava tudo daquela origem, por isso nada aqui é
-- referenciado por outra tabela.
create table if not exists public.external_events (
  id         text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade default auth.uid(),
  source     text not null check (source in ('google', 'ics')),
  title      text not null default '',
  date       date not null,
  time       time,
  notes      text not null default '',
  synced_at  timestamptz not null default now()
);

-- Substitui o object store `meta`: preferências por usuário.
create table if not exists public.settings (
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  key         text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- -----------------------------------------------------------------------------
-- Índices
-- -----------------------------------------------------------------------------
-- Toda consulta do app filtra por usuário, e a RLS acrescenta esse filtro
-- mesmo quando o código não pede. Sem índice em `user_id`, cada tela varre a
-- tabela inteira.

create index if not exists accounts_user_idx         on public.accounts (user_id);
create index if not exists categories_user_idx       on public.categories (user_id);
create index if not exists plans_user_idx            on public.plans (user_id);
create index if not exists goals_user_idx            on public.goals (user_id);
create index if not exists contributions_user_idx    on public.contributions (user_id);
create index if not exists contributions_goal_idx    on public.contributions (user_id, goal_id);
create index if not exists notes_user_idx            on public.notes (user_id);
create index if not exists events_user_idx           on public.events (user_id, date);
create index if not exists external_events_user_idx  on public.external_events (user_id, date);

-- As telas de Financeiro e Calendário sempre pedem um intervalo de datas do
-- usuário atual — este índice composto atende as duas.
create index if not exists transactions_user_date_idx on public.transactions (user_id, date desc);
create index if not exists transactions_plan_idx      on public.transactions (user_id, plan_id) where plan_id is not null;
