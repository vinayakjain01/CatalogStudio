-- ============================================================================
-- 001 — RLS hardening for tenant-scoped tables
--
-- WHY: six tables are currently readable with the ANON key. That key is
-- NEXT_PUBLIC_SUPABASE_ANON_KEY — it is compiled into the browser bundle and is
-- public by design, so anyone who loads the site can read every tenant's rows:
--
--     products             1894 rows   every store's catalog
--     generated_images     1070 rows   every store's creatives
--     image_extend_cache    961 rows
--     catalog_import_rows   106 rows
--     catalog_imports         5 rows
--     bg_removal_cache        3 rows
--
-- stores, templates, template_rules, generation_jobs, profiles and the rest
-- already enforce RLS correctly — this file brings the stragglers in line.
--
-- SAFE TO RUN: service_role bypasses RLS entirely, so the worker, the sync
-- pipeline, the folder-upload routes and the public feed endpoint
-- (/api/feed/[storeId] builds its own service_role client) are unaffected.
-- The policies below cover exactly the session-client access paths that exist
-- in the app today; each one is annotated with its caller.
--
-- Run in: Supabase dashboard → SQL Editor. There is no exec_sql RPC on this
-- project, so DDL cannot be applied through PostgREST.
-- ============================================================================

begin;

-- ── products ────────────────────────────────────────────────────────────────
-- Readers: dashboard pages, /api/products, /api/catalog/export (session client).
-- Writer:  /api/products/[productId]/shot-type (session client, UPDATE).
-- Sync, folder upload and generation all write via service_role.
alter table public.products enable row level security;

drop policy if exists products_owner_select on public.products;
create policy products_owner_select on public.products
  for select to authenticated
  using (
    exists (
      select 1 from public.stores s
      where s.id = products.store_id and s.user_id = auth.uid()
    )
  );

drop policy if exists products_owner_update on public.products;
create policy products_owner_update on public.products
  for update to authenticated
  using (
    exists (
      select 1 from public.stores s
      where s.id = products.store_id and s.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.stores s
      where s.id = products.store_id and s.user_id = auth.uid()
    )
  );

-- ── product_images ──────────────────────────────────────────────────────────
-- Already returns 0 to anon, but RLS is what guarantees that rather than an
-- accident of grants. Read via the products join on dashboard pages.
alter table public.product_images enable row level security;

drop policy if exists product_images_owner_select on public.product_images;
create policy product_images_owner_select on public.product_images
  for select to authenticated
  using (
    exists (
      select 1
      from public.products p
      join public.stores s on s.id = p.store_id
      where p.id = product_images.product_id and s.user_id = auth.uid()
    )
  );

-- ── generated_images ────────────────────────────────────────────────────────
-- Readers: dashboard, /api/generate/stats. Deleter: /api/creatives/[creativeId]
-- (session client). Has no store_id column, so ownership routes via products.
alter table public.generated_images enable row level security;

drop policy if exists generated_images_owner_select on public.generated_images;
create policy generated_images_owner_select on public.generated_images
  for select to authenticated
  using (
    exists (
      select 1
      from public.products p
      join public.stores s on s.id = p.store_id
      where p.id = generated_images.product_id and s.user_id = auth.uid()
    )
  );

drop policy if exists generated_images_owner_delete on public.generated_images;
create policy generated_images_owner_delete on public.generated_images
  for delete to authenticated
  using (
    exists (
      select 1
      from public.products p
      join public.stores s on s.id = p.store_id
      where p.id = generated_images.product_id and s.user_id = auth.uid()
    )
  );

-- ── catalog_imports ─────────────────────────────────────────────────────────
-- Reader: /api/catalog/export ownership check (session client). Carries its own
-- user_id, so no join is needed.
alter table public.catalog_imports enable row level security;

drop policy if exists catalog_imports_owner_select on public.catalog_imports;
create policy catalog_imports_owner_select on public.catalog_imports
  for select to authenticated
  using (user_id = auth.uid());

-- ── catalog_import_rows ─────────────────────────────────────────────────────
-- No session-client reader today; scoped through its parent import so the
-- upload audit trail stays visible to its owner if one is added later.
alter table public.catalog_import_rows enable row level security;

drop policy if exists catalog_import_rows_owner_select on public.catalog_import_rows;
create policy catalog_import_rows_owner_select on public.catalog_import_rows
  for select to authenticated
  using (
    exists (
      select 1 from public.catalog_imports ci
      where ci.id = catalog_import_rows.import_id and ci.user_id = auth.uid()
    )
  );

-- ── Derived-image caches ────────────────────────────────────────────────────
-- These hold only derived Cloudinary URLs, but they still leak which images a
-- competitor is processing. Scoped by store_id.
--
-- CAVEAT: rows with store_id IS NULL become service_role-only. For a cache that
-- means a recomputation, never data loss — the worker uses service_role and is
-- unaffected. Only /api/background/cache (session client) can notice.
alter table public.bg_removal_cache enable row level security;

drop policy if exists bg_removal_cache_owner_select on public.bg_removal_cache;
create policy bg_removal_cache_owner_select on public.bg_removal_cache
  for select to authenticated
  using (
    store_id is not null and exists (
      select 1 from public.stores s
      where s.id = bg_removal_cache.store_id and s.user_id = auth.uid()
    )
  );

drop policy if exists bg_removal_cache_owner_delete on public.bg_removal_cache;
create policy bg_removal_cache_owner_delete on public.bg_removal_cache
  for delete to authenticated
  using (
    store_id is not null and exists (
      select 1 from public.stores s
      where s.id = bg_removal_cache.store_id and s.user_id = auth.uid()
    )
  );

alter table public.image_extend_cache enable row level security;

drop policy if exists image_extend_cache_owner_select on public.image_extend_cache;
create policy image_extend_cache_owner_select on public.image_extend_cache
  for select to authenticated
  using (
    store_id is not null and exists (
      select 1 from public.stores s
      where s.id = image_extend_cache.store_id and s.user_id = auth.uid()
    )
  );

alter table public.background_reconstruction_cache enable row level security;

drop policy if exists background_reconstruction_cache_owner_select
  on public.background_reconstruction_cache;
create policy background_reconstruction_cache_owner_select
  on public.background_reconstruction_cache
  for select to authenticated
  using (
    store_id is not null and exists (
      select 1 from public.stores s
      where s.id = background_reconstruction_cache.store_id and s.user_id = auth.uid()
    )
  );

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Every row below should read rls_enabled = true.
--
--   select relname as table, relrowsecurity as rls_enabled
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('products','product_images','generated_images',
--                     'catalog_imports','catalog_import_rows','bg_removal_cache',
--                     'image_extend_cache','background_reconstruction_cache')
--   order by relname;
--
-- Then re-run the anon probe: every one of these tables must return count 0.

-- ── Rollback ────────────────────────────────────────────────────────────────
-- If a page breaks, disable the single offending table rather than all of them:
--   alter table public.<table> disable row level security;
