-- ============================================================================
-- 008 — option names for variant scoping + per-image creative uniqueness
--
-- Supports the Generate Creatives "scope selector": filtering by a named
-- option (e.g. Size: M) across products, and generating one creative per
-- IMAGE per variant rather than collapsing to one per variant.
--
-- ── Option names ─────────────────────────────────────────────────────────────
-- product_variants already stores option1/2/3 VALUES (e.g. "M", "Red"), but
-- nothing stores the option NAMES ("Size", "Colour") — Shopify's REST-era
-- positional model never needed them since the UI always paired a value with
-- its known column. Filtering by name (not just raw value) requires knowing,
-- per product, which position is "Size".
--
-- Stored on `products` (one row per product, matching how Shopify itself
-- scopes option definitions) rather than a normalized options table — a
-- product has at most 3 options, so three nullable columns mirror the existing
-- option1/2/3 convention on product_variants instead of introducing a new
-- shape for three values.
begin;

alter table public.products add column if not exists option1_name text;
alter table public.products add column if not exists option2_name text;
alter table public.products add column if not exists option3_name text;

comment on column public.products.option1_name is
  'Shopify option name at position 1 (e.g. "Size"), matching product_variants.option1''s value. Null until the next sync after this migration.';

-- ── Per-image creative uniqueness ───────────────────────────────────────────
-- The existing partial index treated (variant_id, template_id) as the identity
-- of a creative, so generating from a second photo of the same variant would
-- delete-then-overwrite the first — exactly the "all poses" case this feature
-- adds. image_id joins the identity so multiple images of one variant coexist.
drop index if exists uq_generated_creatives_variant_template;

create unique index if not exists uq_generated_creatives_variant_image_template
  on public.generated_creatives (variant_id, image_id, template_id)
  where variant_id is not null;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--   where table_name = 'products' and column_name like 'option%_name';
--
--   select indexname from pg_indexes
--   where tablename = 'generated_creatives' and indexname like 'uq_generated_creatives%';
--   -- must show uq_generated_creatives_variant_image_template only
--
-- Option names populate on the NEXT Shopify sync after this runs — existing
-- rows stay null until then. The app falls back to matching a value across
-- all three option columns for any product with no name recorded yet, so
-- "Specific option" filtering keeps working (just less precisely) in the
-- meantime — see resolveOptionColumn() in generation-queue.ts.
