-- Generation jobs: one row per queued/processed creative render.
-- Written by the enqueue API (service role) and the worker; read by the UI.

create table if not exists public.generation_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  product_id   uuid not null references public.products (id) on delete cascade,
  template_id  uuid references public.templates (id) on delete set null,
  status       text not null default 'queued'
                 check (status in ('queued', 'processing', 'completed', 'failed')),
  progress     int  not null default 0,
  error        text,
  generated_url text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);

create index if not exists generation_jobs_store_idx   on public.generation_jobs (store_id, created_at desc);
create index if not exists generation_jobs_status_idx  on public.generation_jobs (status);
create index if not exists generation_jobs_product_idx on public.generation_jobs (product_id);

alter table public.generation_jobs enable row level security;

-- Owners can read their own jobs. Inserts/updates happen via the service-role
-- key (enqueue endpoint + worker), which bypasses RLS.
drop policy if exists "generation_jobs_select_own" on public.generation_jobs;
create policy "generation_jobs_select_own"
  on public.generation_jobs for select
  using (auth.uid() = user_id);
