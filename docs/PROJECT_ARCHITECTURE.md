# Craftify — Project Architecture & Handoff Doc

**Read this file before touching anything.** It exists so a session with no prior
context — a new Claude account, a new engineer, or this same session after a
long gap — can understand the whole system without re-deriving it from the
code. It is kept in the repo (not in any one person's tooling) specifically so
it survives an account change.

Last verified against the live system: **2026-08-18**. Where this doc states a
fact about production (row counts, migration status, token expiry), it was
checked directly against the database or a live HTTP call at that time — it is
a snapshot, not a promise. If something here conflicts with what you observe,
trust what you observe and update this file.

---

## 1. What Craftify is

Craftify is a Shopify app: connect a store, its catalog syncs in (products,
**variants**, images), you build layered canvas **templates**, write **rules**
that map products/variants to a template, and the platform bulk-generates a
finished creative (JPEG) per variant by compositing the product photo into the
template with dynamic text fields and conditional badges. Finished creatives
go to Cloudinary and are exposed via the dashboard, a ZIP export, and a
variant-level Meta Shopping feed (CSV/XML/JSON).

This is a **v2 rewrite** of an earlier, broader tool ("Catalog Studio") that
also did Google Drive import, local folder upload, AI "Template Adaptation",
a manual Meta integration section, and per-product (not per-variant)
generation. All of that was deliberately stripped — see §6.

---

## 2. Deployment topology — READ THIS FIRST

Three independently-deployed systems make up "the app". **Changing code and
pushing to `main` only updates #1.** This has caused real incidents this
session (a stale worker silently reported jobs "completed" while generating
zero creatives, because it was weeks behind the resolver logic).

| # | System | What it runs | How it deploys |
|---|---|---|---|
| 1 | **Vercel** (`craft-ify.vercel.app`) | The Next.js app — dashboard, all API routes, Vercel cron | Auto-deploys on push to `main` |
| 2 | **DigitalOcean droplet** | `src/workers/catalog-worker.ts` — the BullMQ + DB-poll generation/sync worker | **Manual**: `git pull && npm install && pm2 restart all` (or equivalent) on the box. Nothing about a `git push` touches this. |
| 3 | **Supabase** | Postgres + Auth | SQL migrations in `supabase/*.sql` are **not applied automatically** — there is no migration runner. Each must be pasted into the Supabase SQL Editor and run by hand, **in numeric order**, before the code that depends on it deploys. |

**The single most common failure mode this session**: shipping code that reads
or writes a column/table a migration hasn't created yet. This broke Shopify
sync twice (once for a stale `sku` unique constraint, once for missing
`option*_name` columns). Always run pending migrations before merging code
that depends on them, and say so loudly in the commit message when you don't
control the timing.

Domain history: the app was `catalogstudio.vercel.app`, then briefly
`craftify.vercel.app`, and is now **`craft-ify.vercel.app`** (hyphenated —
easy to mistype). `shopify.app.toml`'s `application_url`/`redirect_urls` and
Supabase's allowed Redirect URLs must all match this exactly or OAuth breaks.
The GitHub repo was renamed from `CatalogStudio` to `Craftify`
(`github.com/vinayakjain01/Craftify`) — if `git push` ever reports the repo
moved, run `git remote set-url origin https://github.com/vinayakjain01/Craftify.git`.

---

## 3. Tech stack

- **Next.js 16.2.9**, App Router, TypeScript, Tailwind v4. `AGENTS.md` warns
  this Next version has framework docs bundled at
  `node_modules/next/dist/docs/` — read them before assuming pre-16 API shape
  (async `params`/`searchParams`, `force-dynamic`, etc. are all already used
  consistently in this codebase).
- **Supabase**: Postgres + Auth. No migration-tracking table — `supabase/*.sql`
  files are the only record of schema history, applied by hand, in order.
- **Cloudinary**: all image storage — originals, background-removal cache,
  and every generated creative.
- **BullMQ + ioredis** against a DigitalOcean-managed Redis/Valkey instance,
  **plus** a DB-poll fallback loop in the same worker process (see §7).
- **Shopify Admin GraphQL API** (REST product endpoints are deprecated and
  403 for this app). OAuth is the **embedded, session-token** flow — see §5.
- `@napi-rs/canvas` for server-side compositing (`src/lib/compositor.ts`).
- **shadcn/ui** + Radix primitives, Tailwind design tokens in
  `src/app/globals.css`. Brand: deep royal purple `#4B2E83` + gold `#C6922E`
  on lavender surfaces (see the tokens for exact values; do not reintroduce a
  generic indigo — that was explicitly replaced once already).

---

## 4. Where things live (credentials, accounts)

- **Env vars**: `.env.local` (gitignored, never commit it). Mirror any change
  into Vercel's project env vars — `.env.local` only affects local dev and
  the values you read directly.
- **Shopify Partner Dashboard**: app is named "Craftify". `shopify.app.toml`
  is the source of truth for `application_url`/`redirect_urls`/webhook paths;
  `shopify app deploy` pushes it, then the version must be **released**
  (a draft has no effect).
- **Supabase project**: URL/keys in `.env.local`
  (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). No
  `exec_sql`/arbitrary-DDL RPC exists — migrations genuinely must be pasted
  into the SQL Editor by a human; Claude cannot run them.
- **DigitalOcean**: hosts both the Valkey (Redis) instance and the worker
  droplet. Worker env vars (`WORKER_GENERATION_CONCURRENCY`, `REDIS_URL`,
  etc.) live on the droplet, not in Vercel.
- **Cloudinary / Shopify app secrets / AI provider keys**: all in
  `.env.local` — see that file for the current key names; several
  (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `WORKER_ADAPTATION_CONCURRENCY`, etc.)
  are now **dead** — they belonged to Template Adaptation, which was removed
  in v2, and were deliberately left rather than edited since they're the
  user's own file.

---

## 5. Authentication — the two flows, and why both exist

1. **Merchant login**: Supabase Auth (email/password), gated by
   `src/middleware.ts` on `/dashboard/*`.
2. **Embedded Shopify session**: the app also runs inside an iframe in
   Shopify admin. `src/app/layout.tsx` loads **App Bridge** via a hand-rolled
   inline `<script>` that sets `async=false` on the injected tag — verified
   this session, against the actual built HTML, that every React/Next-native
   way of loading a script (`<script src>` in `<head>`, `next/script`
   `beforeInteractive`, `ReactDOM.preinit`) either lands after ~10 Next chunk
   scripts or forces `async=""`, and App Bridge **aborts entirely** if its
   own tag is async/deferred. **Do not "clean up" this inline script** — it
   is the only approach that actually defines `window.shopify`.
3. **`shop`/`host` query params must survive every redirect** in the
   `/api/shopify/auth` → `/dashboard` flow, or App Bridge throws `missing
   required configuration fields: shop` and session tokens silently stop
   working. `middleware.ts` re-attaches a cookied `host` to any `/dashboard`
   load that arrives without one, as a safety net.
4. **Client → API calls from inside the embedded app use `shopifyFetch`**
   (`src/lib/shopify-token.ts`), which attaches
   `Authorization: Bearer <App Bridge idToken>`. This is required for
   Shopify's own "embedded app checks" (App Store review) to pass — they are
   *behavioural* checks that only clear once Shopify observes real session-token
   traffic, not something a code review can satisfy. **Never manually set
   `Content-Type` when calling `shopifyFetch` with a `FormData` body** — it
   already skips that header for FormData so the browser can add the
   multipart boundary; forcing JSON there silently breaks uploads.
5. **Offline access tokens must be `expiring=1`.** Shopify now rejects
   non-expiring tokens outright (`"[API] Non-expiring access tokens are no
   longer accepted"`). Both the OAuth code-grant (`/api/shopify/callback`)
   and token exchange (`/api/shopify/auth`) pass `expiring=1` and store the
   returned `refresh_token`. Expiring tokens last **1 hour**; the sync path
   (`lib/shopify-sync.ts`'s `ensureFreshToken`) refreshes ahead of expiry
   with a 5-minute margin so background jobs don't silently start failing.
   If you ever see `stores.token_expires_at` null after a fresh connect, the
   `expiring=1` param is not reaching Shopify — that is the whole bug class
   that caused the multi-round "reconnect doesn't work" saga earlier in this
   project's history.

---

## 6. What v2 removed, and why

| Removed | Why |
|---|---|
| Google Drive import | Replaced, then the replacement itself was also cut — see next row |
| Local folder upload | Spec-scoped out of v2 entirely |
| Template Adaptation (AI image editing) | Out of v2 scope; its whole provider layer (`lib/image-editing/`), queue, and worker path were deleted |
| Meta section (manual Catalog ID entry) | Replaced by the always-visible feed URL in the sidebar footer — the section existed mainly to show that one string |
| Product Positioning / Head Space panel | Out of v2 scope (UI only removed — the underlying libs are still wired into the live editor preview; see §11's caveat) |
| Product Zoom template mode | UI picker only shows Standard / AI Product now; the compositor still renders `product_zoom` if a legacy template has it, so nothing existing breaks |
| `feed-generation` / `meta-refresh` BullMQ queues | Discovered to be dead placeholder workers that only logged and returned `{ generated: false }` — never did anything, safe to delete |

**Deliberately NOT done**: a full renderer rewrite that strips the
background-removal / product-layer-engine internals out of `compositor.ts`
and `generation-queue.ts`. Those libraries are not dormant — they're wired
into the **live editor preview** (`components/builder/canvas-preview.tsx` via
`useProductLayerBundle`). Removing them is a renderer rewrite, not a
deletion, and was intentionally parked until generation could be verified
working end-to-end (it now has been — see §7).

---

## 7. The generation pipeline — variant-first, two execution paths

**Everything is per-variant, and (as of the scope-selector feature) optionally
per-image too.** This is the core v2 change: the original Shopify sync only
fetched `variants(first: 1)`, so a product with three colours synced as one
row and silently dropped the other two. `product_variants` now holds the full
set, and generation fans out across it.

### Two independent code paths reach the same `runJob()`

- **`processBatch()`** — a DB-poll loop (`dbPollTick` in
  `catalog-worker.ts`, every `DB_POLL_INTERVAL_MS`) that claims a batch of
  `pending` rows and runs them with `mapWithConcurrency`, sharing **one**
  `JobContext` (cached rules + template canvases) across the whole batch.
  This exists because Vercel (AWS) cannot reach the DigitalOcean Valkey
  instance over VPC in some topologies — jobs written to Supabase by Vercel
  need a way to run even if Redis is unreachable from the writer.
- **BullMQ `Worker(QUEUE_NAMES.generation, ...)`** — pulls jobs pushed to
  Redis by `enqueueGeneration`, one job per processor invocation, calling
  `processGenerationJob(jobId, ...)`.

**Both paths run in the same worker process simultaneously**, racing to claim
the same rows via an atomic `status='pending' → 'processing'` guard — this is
correct and intentional, not a bug, but it means "the worker" is really two
schedulers sharing one pipeline. When diagnosing "generation is slow" or "a
job never ran", check both paths, not just one.

### Fan-out shape

`enqueueGeneration()` (`src/lib/generation-queue.ts`) builds one
`generation_jobs` row per `(variant, image)` pair (or one product-level row
for the rare product with no synced variants — a legacy fallback). Scope
controls, added via the Creatives page's scope selector:

- **Variant scope**: all variants, or a specific named option value (e.g.
  `Size: M`) — matched against `products.option{1,2,3}_name` when a sync has
  populated them, falling back to checking all three positional value
  columns when it hasn't (pre-migration-008 data).
- **Image scope**: `'all'` (one job per image) or `'first'` (one job per
  variant, its primary/first image). **`imageScope` defaults to `'first'`
  inside `enqueueGeneration` itself** — not `'all'` — specifically so callers
  that don't pass it (the sync's auto-enqueue-on-change) keep producing
  exactly the job count they always have. Only the Creatives page's own API
  call defaults to `'all'`.
- **`MAX_JOBS_PER_ENQUEUE = 5000`**: fanning out per image multiplies job
  count by however many photos a variant has. Measured against this
  project's own test store (~9.5k variants, ~5 images/product, no
  per-variant image assignment so every variant falls back to the full
  image set): "all variants + all poses + all products" would be **~47,000
  jobs** from one click. The cap rejects that with an actionable message
  instead of silently accepting it.

### Storage: two tables, one dual-written

- **`generated_images`** (legacy) — keyed `(product_id, template_id,
  creative_type)`. No variant/image dimension, so it can only ever hold the
  *last* creative written for a product+template — multiple variants or
  images collapse into one row here.
- **`generated_creatives`** (v2) — carries `store_id`, `variant_id`,
  `image_id` directly; unique on `(variant_id, image_id, template_id)`. This
  is what the Products page, the Creatives grid, the ZIP download, and the
  feed all read.
- `lib/creatives.ts`'s `recordCreative()` writes both, delete-then-insert
  (not upsert — the uniqueness is a *partial* index, which PostgREST can't
  target via `ON CONFLICT`). **If you add a new field that changes a
  creative's identity, update the match clause in `recordCreative` too**, or
  regenerating will silently overwrite a row it shouldn't.

### Rules

Multi-condition (`template_rules.conditions` jsonb array, AND/OR via
`condition_mode`), resolved in `src/lib/template-resolver.ts`. **Priority is
ascending** — 0 evaluates first, first match wins. This is the opposite of
the pre-v2 single-condition model's ordering; if you ever see rules
evaluating "backwards", check which convention a given row predates.
Legacy single-condition rows (`rule_type`/`rule_operator`/`rule_value`) are
still evaluated as a fallback when `conditions` is empty — both models coexist.

---

## 8. Database schema (as of migration 008)

No migration-tracking table exists — this list *is* the schema history.
Column lists are from the migration files plus reverse-engineering active
code; treat them as "columns observed in use," not a formal DDL dump.

| Table | Key columns | Notes |
|---|---|---|
| `stores` | `id, user_id, shop_domain, access_token, refresh_token, token_expires_at, refresh_token_expires_at, needs_reauth, feed_token, currency, sync_status, last_synced_at` | `access_token` is plaintext (known debt, not fixed) |
| `products` | `id, store_id, shopify_id, title, handle, vendor, product_type, tags[], status, description, option1_name, option2_name, option3_name, price, compare_at_price, inventory_quantity, sku` | The last four are **deprecated variant[0] mirrors** — authoritative values live on `product_variants`. `option*_name` added in migration 008. No unique constraint on `sku` (migration 006 dropped a stale one that broke real-catalog sync). |
| `product_variants` | `id, product_id, store_id, shopify_variant_id, title, sku, barcode, price, compare_at_price, inventory_quantity, inventory_policy, is_sold_out (generated), option1, option2, option3, position, weight, weight_unit` | `is_sold_out` is a Postgres generated column: `inventory_quantity <= 0 AND inventory_policy = 'deny'` |
| `product_images` | `id, product_id, shopify_image_id, src, cloudinary_url, alt, width, height, position, is_primary, variant_ids text[]` | `variant_ids` holds Shopify variant ids (strings) an image is assigned to — on the one real store checked, this is `[]` for every image (Shopify itself has no per-variant image assignment there), so the fallback "use all product images" path is the common case, not the exception |
| `templates` | `id, store_id, user_id, category_id, name, canvas_data jsonb, canvas_width, canvas_height, version, thumbnail_url, is_active` | `canvas_data` holds the full layer tree — see `src/types/template.ts` |
| `template_rules` | `id, store_id, template_id, name, priority, conditions jsonb, condition_mode, is_active`, plus legacy `rule_type/rule_operator/rule_value` (nullable since migration 007) | Priority ascending, see §7 |
| `generation_jobs` | `id, store_id, product_id, variant_id, image_id, template_id, creative_type, status, batch_id, attempts, max_attempts, error, locked_at` | `status`: `pending → processing → completed \| failed \| skipped \| cancelled`. `skipped` (not `completed`) means no rule matched — added after a stale worker reported 303 no-op jobs as "completed" |
| `generated_images` | `id, product_id, template_id, creative_type, cloudinary_public_id, generated_url, status` | Legacy — see §7 |
| `generated_creatives` | `id, store_id, product_id, variant_id, image_id, template_id, job_id, cloudinary_id, url, width, height` | v2 — see §7. Unique `(variant_id, image_id, template_id)` where `variant_id is not null` |
| `catalog_imports`, `catalog_import_rows` | — | Vestigial — belonged to the removed Drive/folder-upload flow. Not dropped, just unused by any current code path. |
| `bg_removal_cache`, `image_extend_cache`, `background_reconstruction_cache` | — | Cloudinary AI derivative caches, keyed by source-URL hash. Only exercised via the still-present (but UI-unreachable) product-layer-engine/AI-Product template mode. |
| `sync_logs` | `id, store_id, sync_type, status, products_synced, error_message` | Audit trail per sync run |

**RLS**: every tenant table enforces owner-via-`stores.user_id`, `to
authenticated` only (service_role bypasses, used by the worker/sync/feed).
This was **not true by default** — migrations 001 and 004 closed a real
anon-key data leak found by testing with actual rows present (an empty
table returning 0 to anon proves nothing; it was only caught once real data
existed). If you add a new tenant table, give it an RLS policy in the same
migration that creates it, not later.

---

## 9. Migration history

Run in this order if starting a database from scratch; each file documents
its own verification query.

| # | File | What it did |
|---|---|---|
| 001 | `001-rls-hardening.sql` | First RLS pass — closed anon-read access to 6 tenant tables |
| 002 | `002-v2-variants-schema.sql` | The big one: `product_variants`, `generated_creatives`, `option1/2/3` on variants, `variant_id`/`image_id` on `generation_jobs`, multi-condition columns on `template_rules` |
| 003 | `003-fresh-start-wipe.sql` | One-time destructive wipe of all pre-v2 tenant data (kept `profiles`/auth) to re-sync clean against the new schema |
| 004 | `004-rls-fix-products.sql` | `products` was still readable by anon *after* 001 — a legacy permissive policy survived because 001 only dropped policies by name. Rewritten to enumerate and drop every policy on the tenant tables before recreating them. |
| 005 | `005-expiring-tokens.sql` | Added `stores.refresh_token` / `refresh_token_expires_at` |
| 006 | `006-drop-stale-product-sku-unique.sql` | Dropped a `UNIQUE(store_id, sku)` constraint left over from the removed folder-import flow — broke sync on any real catalog with duplicate SKUs across products |
| 007 | `007-relax-legacy-rule-columns.sql` | Dropped `NOT NULL` on the legacy `rule_type/rule_operator/rule_value` columns — a v2 (`conditions`-only) rule had nothing valid to put there |
| 008 | `008-option-names-and-image-scoped-creatives.sql` | Added `products.option{1,2,3}_name`; extended `generated_creatives`' unique index to include `image_id` so "generate every pose" doesn't overwrite itself |

`supabase/performance-indexes.sql` is index-only, no schema changes, safe to
run any time.

---

## 10. API route inventory (current)

```
Auth / Shopify
  /api/shopify/install              POST  legacy OAuth code-grant install
  /api/shopify/callback             GET   OAuth callback → token exchange → session
  /api/shopify/auth                 GET   embedded launch handler → token exchange
  /api/shopify/auth/finalize        GET   completes server-side Supabase sign-in
  /api/shopify/sync                 POST  manual re-sync (storeId in body)
  /api/shopify/sync/status          GET   sync progress + counts
  /api/stores/[storeId]/sync        POST  the actual per-store sync implementation
  /api/webhooks/customers/*, /shop/redact   GDPR mandatory webhooks, HMAC-verified

Products
  /api/products                     GET   paginated/filtered list
  /api/products/[productId]         GET   detail incl. variants + images + creatives
  /api/products/[productId]/variants GET  variant list only
  /api/products/[productId]/generate POST single-image generation for one product/variant
  /api/products/option-names        GET   distinct option names for the scope selector

Templates
  /api/templates                    GET/POST
  /api/templates/[templateId]       GET/PUT/DELETE
  /api/templates/[templateId]/thumbnail POST

Rules
  /api/rules                        GET/POST   (conditions[] or legacy triple)
  /api/rules/[ruleId]                PUT/DELETE
  /api/rules/reorder                 PUT   whole-array priority reorder

Generation
  /api/generate/enqueue             POST/GET   bulk enqueue + batch progress poll
  /api/generate/single               POST  one product/variant/image
  /api/generate/cancel               POST  stop a batch
  /api/generate/stats                GET
  /api/generate/bulk, /status/[batchId], /cancel/[batchId]   path-param aliases, forward to the above

Creatives
  /api/creatives                    GET   paginated/filtered (reads generated_creatives)
  /api/creatives/[creativeId]        DELETE

Feed
  /api/feed/[storeId]                GET   public, token-authed, CSV/XML/JSON, one row per variant

Uploads (generic asset upload — logos/overlays in the template builder; NOT
a product-import path, that was removed)
  /api/upload                        POST

Cron (Vercel, CRON_SECRET-gated)
  /api/cron/generate, /api/cron/sync
```

---

## 11. Folder guide

```
src/
  app/
    dashboard/           Products, Templates, Rules Engine, Creatives, Settings
      products/[productId]/   variant selector + image gallery + generate
    api/                 see §10
    layout.tsx           App Bridge inline-loader — see §5, do not "simplify"
  components/
    builder/             The live template editor (canvas-preview.tsx,
                          template-builder-client.tsx). Still imports the
                          product-layer-engine/background-removal stack for
                          its AI-Product preview — see §6's caveat.
    products/             ProductsTable, VariantDetail (dropdown + gallery),
                          ProductGenerateButton
    rules/                RulesClient — multi-condition editor
    creatives/             CreativesClient — scope selector + grid + ZIP
    ui/                    shadcn primitives + EmptyState/StatusBadge (this
                          project's own small design-system additions)
    brand/                CraftifyLogo / CraftifyMark (inline SVG, no asset file)
  lib/
    shopify.ts             GraphQL client — full variant + option-name fetch
    shopify-sync.ts        Sync orchestration, incremental diffing, auto-enqueue
    shopify-token.ts       Token exchange, refresh, shopifyFetch()
    template-resolver.ts   Multi-condition rule matching
    compositor.ts          The actual @napi-rs/canvas renderer
    generation-queue.ts    enqueueGeneration, processBatch, processGenerationJob,
                          runJob — the whole pipeline, see §7
    creatives.ts            recordCreative() — dual-write, see §7
    queues.ts               BullMQ Queue wrappers (2 live queues: generation, productSync)
    product-layer-engine.ts, background-removal/, image-extend/
                          Still-wired-in AI stack for the AI-Product template
                          mode and the live editor preview — not dead code,
                          just not part of the v2 feature surface
  workers/
    catalog-worker.ts     The DigitalOcean process — BullMQ workers + DB-poll
                          loop + stuck-job recovery. Deploys manually, see §2.
supabase/
  *.sql                   Migrations, run by hand, in order — see §9
docs/
  PROJECT_ARCHITECTURE.md This file
```

---

## 12. Hard-won lessons (read before repeating them)

- **A worker that "completes" a job proves nothing about correctness.**
  `generation_jobs.status = 'skipped'` exists specifically because a stale
  worker deployment reported 303 jobs "completed" while a rule-matching
  change meant zero creatives were actually produced. Verify output (row
  counts in `generated_creatives`, actual Cloudinary URLs), not just status.
- **An empty table returning 0 rows to the anon key proves nothing about
  RLS.** Two separate RLS leaks (migrations 001, 004) were only caught by
  seeding a real row and re-checking — always test policies with data present.
- **Session/embedded-app behaviour can't be verified by reading code alone.**
  The App Bridge loading order and the `shop`/`host` param-dropping bug were
  only found by reading the actual browser console inside the Shopify admin
  iframe. If a fix "should" work per the code but the merchant reports it
  doesn't, ask for the console output before iterating further.
- **Pasted specs (from any source, including product docs) may assume schema
  that doesn't exist.** Several rounds this session included a detailed
  pseudocode spec assuming columns/tables (`products.options` jsonb,
  `generation_jobs.image_id` as a new addition when it already existed) that
  turned out to be wrong on inspection. Always verify against the live
  schema before implementing a pasted plan literally.
- **Two schedulers, one pipeline** (§7) — a performance or correctness fix
  applied to only one of `processBatch`/`processGenerationJob` silently
  doesn't apply to jobs the other path claims first.
