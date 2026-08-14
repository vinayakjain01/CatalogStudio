-- ============================================================================
-- 005 — storage for expiring Shopify offline tokens
--
-- Shopify introduced expiring offline tokens in Dec 2025 and now rejects the
-- non-expiring kind on every Admin API call:
--     [API] Non-expiring access tokens are no longer accepted.
--
-- Expiring tokens live 1 HOUR and ship with a 90-day refresh token. The hour is
-- the important part: the cron sync and the BullMQ worker run with no browser
-- session, so without a stored refresh token they would authenticate for
-- exactly one hour after each manual reconnect and then fail silently until
-- someone opened the app again.
--
-- Shopify rotates BOTH tokens on refresh and invalidates the old refresh token
-- immediately, so the new value must be written back every time.
--
-- Run in: Supabase dashboard → SQL Editor.
-- ============================================================================

begin;

alter table public.stores add column if not exists refresh_token            text;
alter table public.stores add column if not exists refresh_token_expires_at timestamptz;

comment on column public.stores.refresh_token is
  'Shopify refresh token (90-day). Rotated on every refresh — always persist the new value.';
comment on column public.stores.token_expires_at is
  'Expiry of the 1-hour offline access token. Null means a legacy non-expiring token, which the Admin API rejects.';

-- Lets the worker find stores whose access token is due for refresh without a
-- full table scan.
create index if not exists idx_stores_token_expiry
  on public.stores (token_expires_at)
  where refresh_token is not null;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select shop_domain,
--          left(access_token, 6) as token_prefix,
--          token_expires_at,
--          refresh_token is not null as has_refresh
--   from public.stores;
--
-- After reconnecting, token_expires_at must be ~1 hour ahead and has_refresh
-- must be true. If token_expires_at is null, Shopify is still issuing a
-- non-expiring token and the expiring=1 parameter is not reaching it.
