-- ============================================================================
-- 006 — drop the stale UNIQUE(store_id, sku) constraint on products
--
-- WHY: syncing a real Shopify catalog (741 products) failed with
--     duplicate key value violates unique constraint "products_store_id_sku_key"
--
-- That constraint came from the folder-import flow, where a filename doubled as
-- both the product title and its dedup key, so one SKU per store was true by
-- construction. It is simply false for a real catalog: merchants reuse a SKU
-- across products, and Shopify does not enforce SKU uniqueness at all.
--
-- In v2 the SKU belongs to the VARIANT. product_variants is uniquely keyed on
-- (store_id, shopify_variant_id), which is the identity the sync upserts on;
-- products is keyed on (store_id, shopify_id). Neither needs SKU uniqueness.
--
-- The folder-import flow was removed in v2, so nothing depends on this any more.
--
-- Run in: Supabase dashboard → SQL Editor.
-- ============================================================================

begin;

alter table public.products
  drop constraint if exists products_store_id_sku_key;

-- The constraint may have been created as a bare unique index rather than a
-- table constraint, in which case the statement above is a no-op.
drop index if exists public.products_store_id_sku_key;

-- Keep SKU searchable — it just must not be unique.
create index if not exists idx_products_store_sku
  on public.products (store_id, sku);

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Should return no rows:
--   select conname
--   from pg_constraint
--   where conrelid = 'public.products'::regclass
--     and conname = 'products_store_id_sku_key';
