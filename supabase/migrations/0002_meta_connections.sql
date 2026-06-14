-- Meta (Facebook) Commerce connections. One row per authorized Meta account.
-- Business / catalog selection is populated after OAuth (follow-up work).

create table if not exists public.meta_connections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  store_id      uuid references public.stores (id) on delete set null,
  meta_user_id  text,
  business_id   text,
  catalog_id    text,
  access_token  text not null,
  token_expires_at timestamptz,
  status        text not null default 'connected'
                  check (status in ('connected', 'expired', 'error')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists meta_connections_user_idx on public.meta_connections (user_id);

alter table public.meta_connections enable row level security;

drop policy if exists "meta_connections_select_own" on public.meta_connections;
create policy "meta_connections_select_own"
  on public.meta_connections for select
  using (auth.uid() = user_id);
