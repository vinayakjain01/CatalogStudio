-- ============================================================================
-- 002 — v2 schema: the variant layer
--
-- Everything in v2 (per-variant generation, the products page, the Meta feed's
-- {store}_{product}_{variant} ids) sits on a variants table that does not exist
-- yet. Today only variant[0] is flattened onto `products` as price / sku /
-- inventory_quantity, so a two-colour product syncs as one row and the other
-- colour is silently lost.
--
-- ADDITIVE BY DESIGN. Nothing is dropped and no column is renamed, so the app
-- keeps building and deploying while the code is migrated table by table. The
-- columns this supersedes are marked DEPRECATED in comments and removed in a
-- later migration, once no code reads them.
--
-- Run AFTER 001-rls-hardening.sql, in: Supabase dashboard → SQL Editor.
-- ============================================================================

begin;

-- ── product_variants ────────────────────────────────────────────────────────
-- The core new entity. One row per Shopify variant.
create table if not exists public.product_variants (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.products(id) on delete cascade,
  store_id            uuid not null references public.stores(id) on delete cascade,
  shopify_variant_id  text not null,

  title               text,               -- "Red / L"
  sku                 text,
  barcode             text,               -- feed: gtin

  price               numeric,
  compare_at_price    numeric,

  inventory_quantity  integer default 0,
  inventory_policy    text    default 'deny',

  -- Generated, not written: keeps "sold out" from drifting out of sync with
  -- inventory the way a manually-maintained boolean always eventually does.
  -- Shopify only blocks purchase when the policy is 'deny'; 'continue' means
  -- oversell is allowed, so such a variant is never sold out.
  is_sold_out boolean generated always as (
    inventory_quantity <= 0 and inventory_policy = 'deny'
  ) stored,

  option1             text,
  option2             text,
  option3             text,

  position            integer,
  weight              numeric,
  weight_unit         text,

  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),

  -- Sync upserts on this pair.
  unique (store_id, shopify_variant_id)
);

create index if not exists idx_product_variants_product   on public.product_variants (product_id);
create index if not exists idx_product_variants_store     on public.product_variants (store_id);
-- Drives the "skip sold-out products" toggle on bulk generation.
create index if not exists idx_product_variants_sold_out  on public.product_variants (store_id, is_sold_out);
create index if not exists idx_product_variants_sku       on public.product_variants (store_id, sku);

comment on table public.product_variants is
  'One row per Shopify variant. Supersedes the flattened price/sku/inventory_quantity columns on products.';

-- ── products: feed needs a description ──────────────────────────────────────
alter table public.products add column if not exists description text;

comment on column public.products.price is
  'DEPRECATED — moved to product_variants.price. Kept until the code sweep lands.';
comment on column public.products.sku is
  'DEPRECATED — moved to product_variants.sku.';
comment on column public.products.inventory_quantity is
  'DEPRECATED — moved to product_variants.inventory_quantity.';
comment on column public.products.compare_at_price is
  'DEPRECATED — moved to product_variants.compare_at_price.';

-- ── product_images: real dimensions + variant association ───────────────────
-- width/height let the compositor pick a fit mode without downloading first.
-- variant_ids is what makes "show this variant's images" possible.
alter table public.product_images add column if not exists width          integer;
alter table public.product_images add column if not exists height         integer;
alter table public.product_images add column if not exists variant_ids    text[] default '{}';
alter table public.product_images add column if not exists cloudinary_id  text;
alter table public.product_images add column if not exists cloudinary_url text;

-- GIN because the lookup is "images whose variant_ids contain this variant".
create index if not exists idx_product_images_variant_ids
  on public.product_images using gin (variant_ids);

-- ── templates: canvas size is a first-class field ───────────────────────────
-- Currently only inside canvas_data jsonb, so it can't be filtered or listed
-- without parsing every row.
alter table public.templates add column if not exists canvas_width  integer default 1200;
alter table public.templates add column if not exists canvas_height integer default 1200;
alter table public.templates add column if not exists version       integer default 1;

-- ── template_rules: multi-condition rules ───────────────────────────────────
-- Today a rule is a single (rule_type, rule_operator, rule_value) triple, so
-- "vendor = X AND product_type = Y" is unexpressible. conditions holds an array
-- of {field, operator, value}; condition_mode is the AND/OR across them.
alter table public.template_rules add column if not exists name           text;
alter table public.template_rules add column if not exists conditions     jsonb not null default '[]'::jsonb;
alter table public.template_rules add column if not exists condition_mode text  not null default 'all';

alter table public.template_rules
  drop constraint if exists template_rules_condition_mode_check;
alter table public.template_rules
  add constraint template_rules_condition_mode_check check (condition_mode in ('all', 'any'));

comment on column public.template_rules.rule_type is
  'DEPRECATED — single-condition model, superseded by conditions jsonb.';

-- NOTE: the spec calls this column `active`; the live column is `is_active` and
-- is read across the resolver and the rules API. Kept as-is — renaming buys a
-- code sweep and no behaviour.

-- ── generation_jobs: address a variant + a specific image ───────────────────
alter table public.generation_jobs add column if not exists variant_id uuid references public.product_variants(id) on delete cascade;
alter table public.generation_jobs add column if not exists image_id   uuid references public.product_images(id)   on delete set null;

create index if not exists idx_generation_jobs_variant on public.generation_jobs (variant_id);

-- ── generated_creatives ─────────────────────────────────────────────────────
-- Replaces generated_images, which has no store_id (forcing a join through
-- products for every tenant filter) and no variant_id (so it cannot represent
-- one creative per variant). generated_images is left in place until the code
-- that reads it is migrated; migration 004 drops it.
create table if not exists public.generated_creatives (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores(id)           on delete cascade,
  product_id     uuid not null references public.products(id)         on delete cascade,
  variant_id     uuid          references public.product_variants(id) on delete cascade,
  image_id       uuid          references public.product_images(id)   on delete set null,
  template_id    uuid          references public.templates(id)        on delete set null,
  job_id         uuid          references public.generation_jobs(id)  on delete set null,

  cloudinary_id  text,
  url            text not null,
  width          integer,
  height         integer,

  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create index if not exists idx_generated_creatives_store    on public.generated_creatives (store_id);
create index if not exists idx_generated_creatives_product  on public.generated_creatives (product_id);
create index if not exists idx_generated_creatives_variant  on public.generated_creatives (variant_id);
create index if not exists idx_generated_creatives_template on public.generated_creatives (template_id);

-- Regeneration overwrites rather than accumulating: one creative per
-- variant × template. Partial index because variant_id is nullable for
-- product-level creatives.
create unique index if not exists uq_generated_creatives_variant_template
  on public.generated_creatives (variant_id, template_id)
  where variant_id is not null;

-- The feed reads image_link per variant and must never scan.
create index if not exists idx_generated_creatives_feed
  on public.generated_creatives (store_id, variant_id, created_at desc);

-- ── stores: sync progress ───────────────────────────────────────────────────
alter table public.stores add column if not exists sync_status text default 'idle';

alter table public.stores drop constraint if exists stores_sync_status_check;
alter table public.stores
  add constraint stores_sync_status_check
  check (sync_status in ('idle', 'syncing', 'failed'));

-- NOTE: the spec calls this `last_sync_at`; the live column is `last_synced_at`
-- and is read by the dashboard. Kept as-is for the same reason as is_active.

-- ── RLS on the new tables ───────────────────────────────────────────────────
-- Same owner-via-store shape as 001. service_role (worker, sync, feed) bypasses.
alter table public.product_variants enable row level security;

drop policy if exists product_variants_owner_select on public.product_variants;
create policy product_variants_owner_select on public.product_variants
  for select to authenticated
  using (
    exists (
      select 1 from public.stores s
      where s.id = product_variants.store_id and s.user_id = auth.uid()
    )
  );

alter table public.generated_creatives enable row level security;

drop policy if exists generated_creatives_owner_select on public.generated_creatives;
create policy generated_creatives_owner_select on public.generated_creatives
  for select to authenticated
  using (
    exists (
      select 1 from public.stores s
      where s.id = generated_creatives.store_id and s.user_id = auth.uid()
    )
  );

drop policy if exists generated_creatives_owner_delete on public.generated_creatives;
create policy generated_creatives_owner_delete on public.generated_creatives
  for delete to authenticated
  using (
    exists (
      select 1 from public.stores s
      where s.id = generated_creatives.store_id and s.user_id = auth.uid()
    )
  );

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select column_name, data_type, is_generated
--   from information_schema.columns
--   where table_name = 'product_variants' order by ordinal_position;
--
--   -- is_sold_out must report is_generated = ALWAYS
