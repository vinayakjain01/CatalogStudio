-- ============================================================================
-- 009 — Placement-specific asset types (catalog / feed / story / reel)
--
-- WHY: today every generated creative is implicitly "catalog" (1:1, feeds the
-- Meta Commerce Manager image_link). This adds a first-class asset_type so a
-- template — and every job/creative it produces — can instead target a 4:5
-- feed ad, a 9:16 story ad, or a 9:16 reel ad. Catalog stays completely
-- separate from the other three: only asset_type='catalog' creatives are ever
-- read by the public feed (/api/feed/[storeId]) or the dashboard's Feed
-- Coverage / restock-detection logic.
--
-- ADDITIVE BY DESIGN: every new column is NOT NULL DEFAULT 'catalog', so every
-- existing template/job/creative is retroactively "catalog" with no data
-- migration needed, and the feed's behaviour for existing data is unchanged.
--
-- Run AFTER 008-option-names-and-image-scoped-creatives.sql, in: Supabase
-- dashboard → SQL Editor. Deploy the corresponding code changes only AFTER
-- this has run — generation-queue.ts, creatives.ts and the feed route all
-- read/write asset_type unconditionally, so shipping that code first would
-- break enqueueing, creative recording, and the live Meta feed with
-- "column asset_type does not exist" until this migration lands.
-- ============================================================================

begin;

-- ── templates ────────────────────────────────────────────────────────────────
alter table public.templates
  add column if not exists asset_type text not null default 'catalog'
  check (asset_type in ('catalog', 'feed', 'story', 'reel'));

comment on column public.templates.asset_type is
  'Which placement this template targets. catalog=1:1 Meta Commerce Manager feed; feed=4:5 ad; story=9:16 story ad; reel=9:16 reel ad. Drives the canvas dimensions used at render time (see ASSET_TYPE_CONFIG in src/types/template.ts) — the template''s own stored canvas_data.width/height are a preview only.';

-- ── generation_jobs ─────────────────────────────────────────────────────────
alter table public.generation_jobs
  add column if not exists asset_type text not null default 'catalog'
  check (asset_type in ('catalog', 'feed', 'story', 'reel'));

create index if not exists idx_generation_jobs_asset_type
  on public.generation_jobs (store_id, asset_type, status);

-- ── generated_creatives ─────────────────────────────────────────────────────
alter table public.generated_creatives
  add column if not exists asset_type text not null default 'catalog'
  check (asset_type in ('catalog', 'feed', 'story', 'reel'));

-- Migration 008 created THIS exact partial unique index (verified against the
-- live schema — a prior draft of this migration assumed a different, WRONG
-- name here, which would have silently no-op'd via IF EXISTS and left the old,
-- narrower constraint enforced alongside the new one, defeating the entire
-- point of this migration: catalog + feed + story + reel could never coexist
-- for the same variant/image/template).
drop index if exists uq_generated_creatives_variant_image_template;

create unique index if not exists uq_generated_creatives_variant_image_template_asset
  on public.generated_creatives (store_id, variant_id, image_id, template_id, asset_type)
  where variant_id is not null;

-- Existing rows all default to asset_type='catalog' uniformly, so no two of
-- them can newly collide under this wider key — safe to create without a
-- prior dedupe pass.

create index if not exists idx_generated_creatives_asset_type
  on public.generated_creatives (store_id, asset_type, created_at desc);

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_name in ('templates', 'generation_jobs', 'generated_creatives')
--     and column_name = 'asset_type';
--   -- all three: not null, default 'catalog'::text
--
--   select indexname from pg_indexes
--   where tablename = 'generated_creatives' and indexname like '%variant_image_template%';
--   -- must show uq_generated_creatives_variant_image_template_asset ONLY —
--   -- the old uq_generated_creatives_variant_image_template must be gone.
