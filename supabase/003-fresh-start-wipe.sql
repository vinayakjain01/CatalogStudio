-- ============================================================================
-- 003 — FRESH START: delete all application data
--
-- ⚠️  DESTRUCTIVE AND IRREVERSIBLE. Read this header before running.
--
-- Wipes every tenant row so v2 can re-sync from Shopify against the new variant
-- schema. Your login survives: auth.users and profiles are NOT touched.
--
-- What goes (current row counts):
--     products                1894      re-syncs from Shopify
--     product_images          8544      re-syncs from Shopify
--     generated_images        1070      regenerate after templates + rules
--     generation_jobs          952      queue history
--     image_extend_cache       961      derived cache, recomputes on demand
--     catalog_import_rows      106      folder-import history (feature removed)
--     catalog_imports            5      "
--     stores                     8      YOU MUST RECONNECT SHOPIFY AFTER THIS
--     sync_logs / caches / adaptation rows
--
-- ⚠️  TEMPLATES ARE HAND-AUTHORED AND CANNOT BE RE-SYNCED.
--     Your 13 templates are deleted by SECTION B below. They are the only thing
--     here that Shopify cannot give back. If you want to keep them, comment out
--     SECTION B before running — they will survive, though v2's new layer types
--     (badge layers, dynamic {field} tokens) mean you will likely rebuild them
--     anyway. Deleting stores in SECTION C nulls their store_id either way.
--
-- Run AFTER 001 and 002, in: Supabase dashboard → SQL Editor.
-- Re-connect Shopify from Settings immediately afterwards.
-- ============================================================================

begin;

-- ── Before ──────────────────────────────────────────────────────────────────
select 'BEFORE' as phase, 'products' as table_name, count(*) from public.products
union all select 'BEFORE', 'product_images',   count(*) from public.product_images
union all select 'BEFORE', 'generated_images', count(*) from public.generated_images
union all select 'BEFORE', 'generation_jobs',  count(*) from public.generation_jobs
union all select 'BEFORE', 'templates',        count(*) from public.templates
union all select 'BEFORE', 'stores',           count(*) from public.stores;

-- ── SECTION A: catalog, creatives, queue, caches ────────────────────────────
-- Child rows first. Most have ON DELETE CASCADE, but deleting explicitly keeps
-- this readable and avoids depending on constraint definitions being what we
-- think they are.

delete from public.generated_creatives;
delete from public.generated_images;
delete from public.generation_jobs;

delete from public.catalog_import_rows;
delete from public.catalog_imports;

delete from public.adaptation_images;
delete from public.adaptation_jobs;

delete from public.product_images;
delete from public.product_variants;
delete from public.products;

delete from public.bg_removal_cache;
delete from public.image_extend_cache;
delete from public.background_reconstruction_cache;

delete from public.sync_logs;
delete from public.activities;
delete from public.insights;
delete from public.feeds;
delete from public.meta_catalogs;

-- ── SECTION B: templates and rules ──────────────────────────────────────────
-- ⚠️  Comment out this whole section to KEEP your 13 hand-built templates.
delete from public.template_rules;
delete from public.templates;
delete from public.template_categories;
-- ── end SECTION B ───────────────────────────────────────────────────────────

-- ── SECTION C: stores ───────────────────────────────────────────────────────
-- Drops the Shopify access tokens too, so reconnecting is a full OAuth install.
-- If SECTION B was skipped, surviving templates keep their rows but their
-- store_id no longer resolves — reassign them after reconnecting.
delete from public.stores;

-- ── After ───────────────────────────────────────────────────────────────────
select 'AFTER' as phase, 'products' as table_name, count(*) from public.products
union all select 'AFTER', 'product_images',   count(*) from public.product_images
union all select 'AFTER', 'generated_images', count(*) from public.generated_images
union all select 'AFTER', 'generation_jobs',  count(*) from public.generation_jobs
union all select 'AFTER', 'templates',        count(*) from public.templates
union all select 'AFTER', 'stores',           count(*) from public.stores;

-- Preserved on purpose:
select 'PRESERVED' as phase, 'profiles' as table_name, count(*) from public.profiles;

commit;

-- If anything above looks wrong, run ROLLBACK instead of COMMIT — this whole
-- file is one transaction, so nothing is lost until it commits.
