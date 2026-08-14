-- ============================================================================
-- 004 — close the remaining anon leak on public.products
--
-- WHY THIS EXISTS: 001 enabled RLS and added an owner-scoped policy, and that
-- worked for every table except `products`. Verified with a real row present:
--
--     products             anon = 1   <-- full row readable, incl. store_id
--     product_variants     anon = 0
--     product_images       anon = 0
--     generated_creatives  anon = 0
--
-- product_images was hardened by the same migration and does block anon, so RLS
-- itself applied fine. The difference is that `products` still carries an older
-- permissive policy from before 001. Postgres ORs permissive policies together,
-- so one legacy "allow everyone" policy re-opens the table no matter how tight
-- the policy added next to it is.
--
-- 001 only dropped policies by the exact names it creates, so a legacy policy
-- under any other name survived. This drops EVERY policy on the affected tables
-- by enumerating pg_policies, then recreates only the owner-scoped ones.
--
-- Run in: Supabase dashboard → SQL Editor.
-- ============================================================================

begin;

-- ── Drop every existing policy on the tenant tables ─────────────────────────
-- Names are unknown ahead of time, hence the catalogue sweep rather than a list
-- of DROP POLICY statements.
do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'products', 'product_images', 'product_variants',
        'generated_images', 'generated_creatives'
      )
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
    raise notice 'dropped policy % on %', pol.policyname, pol.tablename;
  end loop;
end $$;

-- ── Re-enable RLS (idempotent) ──────────────────────────────────────────────
alter table public.products            enable row level security;
alter table public.product_images      enable row level security;
alter table public.product_variants    enable row level security;
alter table public.generated_images    enable row level security;
alter table public.generated_creatives enable row level security;

-- ── Recreate owner-scoped policies only ─────────────────────────────────────
-- `to authenticated` deliberately excludes the anon role. service_role bypasses
-- RLS entirely, so the worker, the sync pipeline and the public feed endpoint
-- (which builds its own service_role client) are unaffected.

create policy products_owner_select on public.products
  for select to authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = products.store_id and s.user_id = auth.uid()));

-- UPDATE is needed by session-client writers on the products table.
create policy products_owner_update on public.products
  for update to authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = products.store_id and s.user_id = auth.uid()))
  with check (exists (
    select 1 from public.stores s
    where s.id = products.store_id and s.user_id = auth.uid()));

create policy product_images_owner_select on public.product_images
  for select to authenticated
  using (exists (
    select 1 from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = product_images.product_id and s.user_id = auth.uid()));

create policy product_variants_owner_select on public.product_variants
  for select to authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = product_variants.store_id and s.user_id = auth.uid()));

create policy generated_images_owner_select on public.generated_images
  for select to authenticated
  using (exists (
    select 1 from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = generated_images.product_id and s.user_id = auth.uid()));

create policy generated_images_owner_delete on public.generated_images
  for delete to authenticated
  using (exists (
    select 1 from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = generated_images.product_id and s.user_id = auth.uid()));

create policy generated_creatives_owner_select on public.generated_creatives
  for select to authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = generated_creatives.store_id and s.user_id = auth.uid()));

create policy generated_creatives_owner_delete on public.generated_creatives
  for delete to authenticated
  using (exists (
    select 1 from public.stores s
    where s.id = generated_creatives.store_id and s.user_id = auth.uid()));

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Every row must show rls_enabled = true and exactly the policies above:
--
--   select tablename, policyname, roles, cmd
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('products','product_images','product_variants',
--                       'generated_images','generated_creatives')
--   order by tablename, policyname;
--
-- Then re-run the anon probe with rows present — every table must return 0.
