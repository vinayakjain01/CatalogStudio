-- Template Adaptation feature schema.
-- No supabase/migrations folder exists in this repo — paste this file into the
-- Supabase SQL editor by hand, same as supabase/performance-indexes.sql.
--
-- adaptation_jobs    = one "1 reference ad + N merchant product photos" submission.
-- adaptation_images  = one row per merchant product photo — the actual unit of
--                      status/retry/progress (mirrors generation_jobs being the
--                      retry unit for the existing creative-generation pipeline).

create table if not exists public.adaptation_jobs (
  id                       uuid primary key default gen_random_uuid(),
  store_id                 uuid not null references public.stores(id) on delete cascade,
  user_id                  uuid not null,
  reference_image_url      text not null,
  reference_cloudinary_id  text,
  platform_context         text not null default 'generic'
                           check (platform_context in ('shopify_pdp','meta_feed_ad','instagram_post','generic')),
  merchant_notes           text,
  status                   text not null default 'pending'
                           check (status in ('pending','processing','completed','partial','failed','cancelled')),
  total_images             int not null default 0,
  completed_count          int not null default 0,
  failed_count             int not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table if not exists public.adaptation_images (
  id                           uuid primary key default gen_random_uuid(),
  job_id                       uuid not null references public.adaptation_jobs(id) on delete cascade,
  store_id                     uuid not null references public.stores(id) on delete cascade,
  position                     int not null default 0,
  product_image_url           text not null,
  product_image_cloudinary_id text,
  status                       text not null default 'pending'
                               check (status in ('pending','generating','completed','failed','cancelled')),
  output_url                  text,
  output_cloudinary_id        text,
  provider                    text,
  prompt_version              text,
  generation_ms                int,
  attempts                     int not null default 0,
  max_attempts                 int not null default 3,
  error                        text,
  locked_at                    timestamptz,
  approved                     boolean not null default false,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index if not exists idx_adaptation_jobs_store_created
  on public.adaptation_jobs (store_id, created_at desc);

create index if not exists idx_adaptation_images_status_locked_created
  on public.adaptation_images (status, locked_at, created_at);

create index if not exists idx_adaptation_images_job_position
  on public.adaptation_images (job_id, position);

create index if not exists idx_adaptation_images_store_status
  on public.adaptation_images (store_id, status);

-- Atomic attempts-increment for the retry-accounting bug already known to
-- affect generation_jobs (attempts incremented at claim time, not at fail
-- time, so an OOM/crash between claim and fail still counts as an attempt).
-- Mirrors the increment_job_attempts RPC generation-queue.ts already calls.
create or replace function public.increment_adaptation_image_attempts(image_ids uuid[])
returns void as $$
  update public.adaptation_images
    set attempts = attempts + 1, updated_at = now()
    where id = any(image_ids);
$$ language sql;
