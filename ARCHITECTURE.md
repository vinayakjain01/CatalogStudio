# Craftify — Architecture & Developer Guide

> Last updated: 2026-08-19
> Stack: Next.js 16 · TypeScript · Supabase · BullMQ/Valkey · Cloudinary · Shopify Admin API

**Read this before touching anything.** It exists so a session with no prior
context — a new engineer, or this same project after an account change —
can understand the whole system without re-deriving it from the code. It's
kept in the repo (not in any one person's tooling) specifically so it
survives that kind of gap. Where this doc states a fact about production
(row counts, schedules, defaults), it was checked directly against the code
or a live call as of the date above — a snapshot, not a promise. If
something here conflicts with what you observe, trust what you observe and
update this file.

---

## 1. What Craftify does

Craftify connects to a Shopify store, fetches every product and its
**variants**, generates branded catalog images by compositing a user-built
overlay **template** onto the product photos via **rules** that map
products/variants to a template, and exposes a live feed URL that Meta
Commerce Manager reads to populate a product catalog with the generated
images.

**Only in-stock variants receive generated images and appear in the feed.**
Sold-out variants are skipped at generation time and excluded from the feed
entirely (see §9).

This is a v2 rewrite of an earlier, broader tool ("Catalog Studio") that also
did Google Drive import, local folder upload, AI "Template Adaptation", a
manual Meta integration section, and per-product (not per-variant)
generation. See §7 for what was cut and why.

---

## 2. Deployment topology — READ THIS FIRST

Three independently-deployed systems make up "the app." **Changing code and
pushing to `main` only updates #1.** A stale worker has, in the past,
silently reported jobs "completed" while generating zero creatives because
it was weeks behind the resolver logic on Vercel — this is a real, recurring
failure mode, not a hypothetical.

| # | System | What it runs | How it deploys |
|---|---|---|---|
| 1 | **Vercel** (`craft-ify.vercel.app`) | The Next.js app — dashboard, all API routes, Vercel cron | Auto-deploys on push to `main` |
| 2 | **DigitalOcean droplet** | `src/workers/catalog-worker.ts` — the BullMQ + DB-poll generation/sync worker | **Manual**: `git pull && npm install && pm2 restart all` (or the equivalent pm2 process name) on the box. A `git push` does not touch this. |
| 3 | **Supabase** | Postgres + Auth | SQL migrations in `supabase/*.sql` are **not applied automatically** — there is no migration runner. Each file is pasted into the Supabase SQL Editor and run by hand, **in numeric order**, before the code that depends on it deploys. |

**The single most common failure mode**: shipping code that reads or writes
a column/table a migration hasn't created yet. This has broken Shopify sync
more than once (a stale `sku` unique constraint; missing `option*_name`
columns). Always run pending migrations before merging code that depends on
them, and say so loudly in the commit message when you don't control the
timing.

**Domain/repo history**: the app was `catalogstudio.vercel.app`, then
briefly `craftify.vercel.app`, and is now **`craft-ify.vercel.app`**
(hyphenated — easy to mistype). Shopify's app config
(`application_url`/`redirect_urls`) and Supabase's allowed Redirect URLs
must all match this exactly or OAuth breaks. The GitHub repo was renamed
from `CatalogStudio` to `Craftify` — if `git push` ever reports the repo
moved, run `git remote set-url origin https://github.com/vinayakjain01/Craftify.git`.

---

## 3. Tech stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend + API | Next.js 16 App Router | Server components, streaming, Vercel deployment |
| Database | Supabase (PostgreSQL) | RLS, real-time, edge-friendly client |
| Job queue | BullMQ + Valkey (Redis-compatible) | Priority queues, fair scheduling |
| Image rendering | @napi-rs/canvas | Server-side canvas (native Skia bindings), no browser required |
| Image storage/CDN | Cloudinary | Delivery URL transforms, auto-format/quality; all image storage — originals, background-removal cache, every generated creative |
| Background worker | Node.js process on DigitalOcean | Long-running BullMQ worker + DB-poll fallback, 1–2 GB RAM |
| Shopify API client | axios | Admin GraphQL client (`shopify.ts`) — REST product endpoints are deprecated/403 for this app, so this is GraphQL-only, not native fetch |
| UI | shadcn/ui + Radix primitives, Tailwind v4 | Design tokens in `src/app/globals.css` — royal purple `#4B2E83` + gold `#C6922E` on lavender surfaces; don't reintroduce a generic indigo, that was deliberately replaced once already |

---

## 4. Where things live (credentials, accounts)

- **Env vars**: `.env.local` (gitignored, never commit it). Mirror any change
  into Vercel's project environment variables — `.env.local` only affects
  local dev and whatever you read directly.
- **Shopify Partner Dashboard**: app is named "Craftify". `shopify.app.toml`
  is the source of truth for `application_url`/`redirect_urls`/webhook
  paths; `shopify app deploy` pushes it, but the version must then be
  **released** — a draft has no effect.
- **Supabase project**: URL/keys in `.env.local`
  (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). No
  `exec_sql`/arbitrary-DDL RPC exists — migrations genuinely must be pasted
  into the SQL Editor by a human.
- **DigitalOcean**: hosts both the Valkey (Redis) instance and the worker
  droplet. Worker env vars (`WORKER_GENERATION_CONCURRENCY`, `REDIS_URL`,
  etc.) live on the droplet, not in Vercel.
- **Cloudinary / Shopify app secrets / AI provider keys**: all in
  `.env.local` — see §12 for the current key names. Some AI-provider keys
  belonging to the removed Template Adaptation feature may still exist in an
  old `.env.local` as dead entries; harmless, just unused.

---

## 5. Folder structure

```
craftify/
├── src/
│   ├── app/                         # Next.js App Router
│   │   ├── (auth)/                  # Auth routes (outside dashboard layout)
│   │   │   └── login/
│   │   │       ├── page.tsx         # Supabase email login
│   │   │       └── signup/page.tsx
│   │   ├── api/                     # All API routes — see §11
│   │   ├── dashboard/               # Authenticated app UI
│   │   │   ├── layout.tsx           # Sidebar + redirect-if-signed-out
│   │   │   ├── page.tsx             # Home stats + Feed Coverage card
│   │   │   ├── products/            # Product list (+ In Stock/All toggle) + [id] detail
│   │   │   ├── templates/           # Template list + [id]/edit canvas builder + new
│   │   │   ├── creatives/           # Generate + view creatives
│   │   │   ├── rules/               # Rule engine editor
│   │   │   └── settings/            # Store connection, feed URL, OAuth status
│   │   ├── layout.tsx               # Root layout: fonts, Shopify App Bridge script (see §8 — do not "simplify")
│   │   ├── globals.css              # Tailwind base + CSS variables
│   │   └── page.tsx                 # Public landing / Shopify install redirect
│   │
│   ├── components/
│   │   ├── ui/                      # shadcn/ui primitives + this project's own EmptyState/StatusBadge
│   │   ├── dashboard/sidebar.tsx    # Navigation sidebar
│   │   ├── creatives/               # CreativesClient (scope selector + grid + ZIP), download-zip-button
│   │   ├── products/                # ProductsTable, ProductsSearch, StockToggle, VariantDetail
│   │   ├── builder/                 # The live template editor (canvas-preview.tsx, product-positioning-guide,
│   │   │                            #   toolbar…) — still imports the product-layer-engine/background-removal
│   │   │                            #   stack for its AI-Product preview, see §7's caveat
│   │   ├── templates/               # Template list/editor chrome around builder/
│   │   ├── rules/                   # RulesClient — multi-condition editor
│   │   ├── settings/                # ConnectStoreForm, StoreCard, OAuthStatusBanner
│   │   └── brand/                   # CraftifyLogo/CraftifyMark — inline SVG, no asset file
│   │
│   ├── lib/                         # Server-side business logic
│   │   ├── supabase/
│   │   │   ├── server.ts            # SSR Supabase client (cookie-based, anon key — RLS applies)
│   │   │   ├── client.ts            # Browser Supabase client
│   │   │   └── get-user.ts          # React cache() deduplication for auth
│   │   ├── active-store.ts          # Resolves active store from cookie + user's store list
│   │   ├── shopify.ts               # Admin GraphQL client — full variant + option-name fetch
│   │   ├── shopify-host.ts          # Embedded app host cookie
│   │   ├── shopify-token.ts         # OAuth token exchange/refresh + shopifyFetch()
│   │   ├── shopify-sync.ts          # Full sync, incremental diffing, auto-enqueue restocked variants
│   │   ├── shopify-webhook.ts       # HMAC verification for Shopify webhooks
│   │   ├── template-resolver.ts     # Multi-condition rule matching: product(+variant) → template
│   │   ├── compositor.ts            # The actual @napi-rs/canvas renderer
│   │   ├── product-layer-engine.ts, background-removal/, background-reconstruction/, image-extend/
│   │   │                            # Still-wired-in AI stack for the AI-Product template mode and the
│   │   │                            #   live editor preview — not dead code, see §7's caveat
│   │   ├── product-positioning.ts / product-positioning-shared.ts, image-bounds.ts
│   │   │                            # "Head Space" smart-fit placement math
│   │   ├── cloudinary.ts            # Upload with smart compression
│   │   ├── generation-queue.ts      # enqueueGeneration, computeGenerationRows, processBatch,
│   │   │                            #   processGenerationJob, runJob — the whole pipeline, see §10
│   │   ├── creatives.ts             # recordCreative() — see §10
│   │   ├── queues.ts                # BullMQ Queue wrappers (2 live queues: generation, productSync)
│   │   ├── redis.ts                 # ioredis connection (nullable if no REDIS_URL)
│   │   ├── rate-limit.ts            # Redis sliding-window rate limiter
│   │   ├── perf.ts                  # logPerf()/measureAsync() — structured timing logs
│   │   ├── concurrency.ts           # mapWithConcurrency, chunkArray
│   │   └── editor-preview.ts        # Canvas builder's live-preview render path
│   │
│   ├── workers/
│   │   └── catalog-worker.ts        # DigitalOcean process — BullMQ workers + 3s DB-poll loop + stuck-job recovery
│   │
│   ├── stores/
│   │   └── builder-store.ts         # Zustand store for the canvas builder's client-side editor state
│   │
│   ├── types/
│   │   ├── template.ts              # CanvasData, Layer, AspectRatio types
│   │   └── product-layer.ts         # CompositorBundle / product-layer-engine types
│   │
│   └── middleware.ts                # Auth redirect + Shopify host cookie pass-through
│
├── supabase/                          # Hand-applied SQL migrations, run in numeric order — see §13
├── vercel.json                       # Two crons: daily sync (2 AM UTC) + daily generate drain (midnight UTC)
├── next.config.ts                    # serverExternalPackages, CSP headers
└── ARCHITECTURE.md                   # This file
```

---

## 6. Database schema (Supabase)

All tenant tables have RLS enabled — owner-via-`stores.user_id`, `to
authenticated` only (service_role, used by the worker/sync/cron/feed,
bypasses it). **This was not true by default**: two separate RLS leaks were
found and closed by testing with real rows present — an empty table
returning 0 rows to the anon key proves nothing about RLS; only a seeded row
and a re-check does. If you add a new tenant table, give it an RLS policy in
the same migration that creates it, not later. Migrations live in
`supabase/*.sql`, applied by hand via the Supabase SQL Editor in numeric
order — there is no migration-tracking table (see §13 for the full history).

### Core tables

**`stores`**
```
id                    uuid PK
user_id               uuid → auth.users
shop_domain           text  (e.g. vinayak-test-store.myshopify.com)
shop_name             text
access_token          text  (1-hour expiring offline token — Shopify rejects non-expiring tokens; stored plaintext, known debt)
refresh_token         text  (90-day; Shopify rotates BOTH on every refresh — always persist the new value)
token_expires_at      timestamptz
refresh_token_expires_at timestamptz
needs_reauth          bool  (set when token refresh fails — UI prompts reconnect)
feed_token            uuid  (public, authenticates /api/feed/ requests)
currency              text  (e.g. INR)
is_active             bool
last_synced_at        timestamptz
```

**`products`**
```
id              uuid PK
store_id        uuid → stores
shopify_id      text  (Shopify product GID)
title, handle, vendor, product_type, tags[], description, status
option1_name, option2_name, option3_name  text  (which option position is "Size"/"Colour" — migration 008)
price, compare_at_price, inventory_quantity, sku   -- DEPRECATED variant[0] mirrors, kept for legacy readers
```
No unique constraint on `sku` — migration 006 dropped a stale one that broke
sync on any real catalog with duplicate SKUs across products.

**`product_variants`**
```
id                  uuid PK
product_id          uuid → products
store_id            uuid → stores
shopify_variant_id  text
title, sku, barcode, price, compare_at_price
inventory_quantity  int
inventory_policy    text  ('deny' | 'continue' — 'continue' allows oversell)
is_sold_out         bool  GENERATED ALWAYS AS (inventory_quantity <= 0 AND inventory_policy = 'deny') STORED
option1, option2, option3  text  (e.g. 'Red', 'XL')
position            int
unique (store_id, shopify_variant_id)
```
`is_sold_out` is a real Postgres generated column, not application-maintained
— it can't drift out of sync with inventory the way a manually-set boolean
would, and it's what §9's In-Stock Only feed rule is built on.

**`product_images`**
```
id                uuid PK
product_id        uuid → products
shopify_image_id  text
src               text   (original Shopify CDN URL)
cloudinary_url    text   (after uploading to Cloudinary)
is_primary        bool
position          int
width, height     int
variant_ids       text[] (Shopify variant IDs this image belongs to; empty = shown for every variant — the common case, since most catalogs never assign images per variant)
```

**`templates`**
```
id              uuid PK
store_id        uuid → stores
user_id         uuid → auth.users
name            text
canvas_data     jsonb  (full canvas state — see types/template.ts's CanvasData)
thumbnail_url   text
canvas_width, canvas_height  int
```

**`template_rules`**
```
id              uuid PK
store_id        uuid → stores
template_id     uuid → templates
name            text
priority        int  (LOWER number = HIGHER priority; evaluated ascending — the opposite of the pre-v2 model)
conditions      jsonb  (array of RuleCondition)
condition_mode  text  ('all' | 'any')
active          bool
rule_type, rule_operator, rule_value  -- legacy single-condition columns (nullable since migration 007), still honoured if conditions is empty
```

**`generation_jobs`**
```
id              uuid PK
store_id        uuid → stores
product_id      uuid → products
variant_id      uuid → product_variants (NULL = legacy product-level job, pre-variant-migration data)
image_id        uuid → product_images   (NULL = legacy; worker falls back to the primary image)
template_id     uuid → templates
batch_id        uuid  (groups jobs from one Generate click / one sync's restock check)
status          text  ('pending' | 'processing' | 'completed' | 'failed' | 'skipped' | 'cancelled')
attempts, max_attempts  int
error           text
locked_at       timestamptz
```
`skipped` (not `completed`) means no rule matched — added after a stale
worker reported hundreds of no-op jobs as "completed" while a rule-matching
change meant zero creatives were actually produced. Nothing filters on
`completed` specifically, so this is safe and makes the outcome countable —
**a worker reporting a job "complete" proves nothing about correctness on
its own; check `generated_creatives` row counts and real Cloudinary URLs.**

**`generated_creatives`** (v2 — what the Products page, Creatives grid, ZIP
download, and feed all read)
```
id              uuid PK
store_id        uuid → stores
product_id      uuid → products
variant_id      uuid → product_variants
image_id        uuid → product_images
template_id     uuid → templates
job_id          uuid → generation_jobs
url             text   (Cloudinary delivery URL)
cloudinary_id   text
unique (variant_id, image_id, template_id)   -- one creative per (variant, pose, template); re-generating upserts, doesn't duplicate
```
`recordCreative()` in `creatives.ts` writes this (and the legacy table
below) via delete-then-insert, not a Postgres `ON CONFLICT` upsert — the
uniqueness is a partial index, which PostgREST can't target directly. If you
add a field that changes a creative's identity, update the match clause in
`recordCreative` too, or regenerating will silently overwrite a row it
shouldn't.

**`generated_images`** (legacy, superseded by `generated_creatives`)
Keyed `(product_id, template_id, creative_type)` — no variant/image
dimension, so it can only ever hold the *last* creative written for a
product+template; multiple variants or images collapse into one row here.
Still dual-written for backward compatibility.

**`bg_removal_cache`, `image_extend_cache`, `background_reconstruction_cache`**
Cloudinary AI-derivative caches, keyed by source-URL hash, so the same photo
is never re-processed by an AI provider twice. Exercised by the AI-Product
template mode and the live editor preview (see §7's caveat) —
`product-layer-engine.ts` reads/writes `bg_removal_cache` as one combined
bundle: transparent cutout + background plate + shot-type metadata.

**`catalog_imports`, `catalog_import_rows`**
Vestigial — belonged to the removed Drive/folder-upload flow (§7). Not
dropped, just unused by any current code path.

**`sync_logs`**
Audit trail per sync run: `id, store_id, sync_type, status, products_synced, error_message`.

---

## 7. What v2 removed, and why

| Removed | Why |
|---|---|
| Google Drive import | Replaced, then the replacement itself was also cut — see next row |
| Local folder upload | Spec-scoped out of v2 entirely |
| Template Adaptation (AI image editing) | Out of v2 scope; its whole provider layer, queue, and worker path were deleted |
| Meta section (manual Catalog ID entry) | Replaced by the always-visible feed URL in the sidebar footer |
| Product Positioning / Head Space panel | UI-only removed — the underlying libs are still wired into the live editor preview (`components/builder/canvas-preview.tsx` via `useProductLayerBundle`) |
| Product Zoom template mode | UI picker only shows Standard / AI Product / Background Removal now; the compositor still renders `product_zoom` if a legacy template has it, so nothing existing breaks |
| `feed-generation` / `meta-refresh` BullMQ queues | Discovered to be dead placeholder workers that only logged and returned `{ generated: false }` — never did anything, safe to delete |

**Deliberately NOT done**: a full renderer rewrite that strips the
background-removal / product-layer-engine internals out of `compositor.ts`
and `generation-queue.ts`. Those libraries are not dormant — they're wired
into the live editor preview and the AI-Product template mode. Removing them
would be a renderer rewrite, not a deletion.

---

## 8. Authentication flow

Craftify uses two auth mechanisms side by side:

### 1. Supabase session (email login)
Used for the web dashboard (non-embedded access). Standard Supabase
email/password auth with SSR cookie-based sessions, validated in
`middleware.ts`.

```
User visits /login → signs in → Supabase sets auth cookie → middleware validates
→ redirects to /dashboard
```

### 2. Shopify OAuth (embedded app)
Used when the app is accessed from Shopify admin.

```
Merchant installs app from Shopify Partners
  → GET /api/shopify/install?shop=...
     → builds Shopify OAuth URL
     → redirects merchant to Shopify consent screen
  → Shopify redirects back to GET /api/shopify/callback?code=...&shop=...
     → exchanges code for an EXPIRING offline access token (expiring=1 —
       Shopify rejects non-expiring tokens outright: "[API] Non-expiring
       access tokens are no longer accepted")
     → creates/updates stores row in DB
     → creates Supabase user account (or links existing)
     → triggers first product sync in background
     → redirects to /dashboard
  → For subsequent requests in the Shopify admin iframe:
     POST /api/shopify/auth { idToken }
     → exchanges the short-lived session token for a fresh offline token
     → returns { supabaseToken } for client-side auth
```

Key details, each the result of a real incident:

- **Expiring offline tokens last 1 hour** and ship with a 90-day refresh
  token. `shopify-sync.ts`'s `ensureFreshToken()` refreshes ~5 minutes ahead
  of expiry on every sync, so the cron and the worker — which run with no
  browser session to re-trigger token exchange — stay authenticated
  indefinitely. Shopify rotates both tokens on every refresh and immediately
  invalidates the old refresh token, so the new value is written back in the
  same call. If `stores.token_expires_at` is ever null after a fresh
  connect, the `expiring=1` param isn't reaching Shopify.
- **App Bridge is loaded via a hand-rolled inline `<script>`** in
  `src/app/layout.tsx` that explicitly sets `async=false` on the injected
  tag. Every React/Next-native way of loading a script (`<script src>` in
  `<head>`, `next/script beforeInteractive`, `ReactDOM.preinit`) either lands
  after several Next chunk scripts or forces `async=""`, and App Bridge
  **aborts entirely** if its own tag is async/deferred. Do not "clean up"
  this inline script — it's the only approach that actually defines
  `window.shopify`.
- **`shop`/`host` query params must survive every redirect** in the
  `/api/shopify/auth` → `/dashboard` flow, or App Bridge throws `missing
  required configuration fields: shop`. `middleware.ts` re-attaches a
  cookied `host` to any `/dashboard` load that arrives without one, as a
  safety net.
- **Client → API calls from inside the embedded app use `shopifyFetch`**
  (`src/lib/shopify-token.ts`), attaching
  `Authorization: Bearer <App Bridge idToken>`. This is required for
  Shopify's "embedded app checks" (App Store review) to pass — those are
  behavioral checks that only clear once Shopify observes real
  session-token traffic. Never manually set `Content-Type` when calling
  `shopifyFetch` with a `FormData` body — it already omits that header for
  FormData so the browser can add the multipart boundary.

---

## 9. Feed API and In-Stock Only

`GET /api/feed/[storeId]?token={feed_token}&format={csv|xml|json}`

This is the Meta Commerce Manager data source URL. Meta fetches it every few
hours.

**Authentication**: `feed_token` from `stores.feed_token`. It is a public,
read-only token safe to embed in the URL. It grants access to this feed only.

**The single rule**: a variant generates a creative and appears in the feed
only while it's in stock (`is_sold_out = false` on an active product).
Sold-out means completely absent from the feed — no row, not even one marked
"out of stock" — enforced at three layers: the fan-out that decides what to
generate (`computeGenerationRows` in `generation-queue.ts`), the feed's own
query (`.eq('is_sold_out', false)`), and a defensive re-check in the feed's
`buildRow()`. Restocking picks a variant back up automatically on the next
sync (see §10).

**Content**: one row per in-stock variant (of an active product) that has a
generated creative, or the original product photo as fallback if generation
hasn't caught up yet.

**Streaming**: the response is a `ReadableStream`, so a large catalog
doesn't buffer all rows in memory or trip the function timeout.

**Row format** (Meta Commerce Manager columns):
```
id                → {storeId}_{shopifyProductId}_{shopifyVariantId}
title             → "Product Title - Variant Title"
description       → stripped HTML of product description
availability      → always 'in stock' (sold-out variants never reach this code path)
price             → compare_at_price (reference/strike price if on sale)
sale_price        → current price (only when on sale)
link              → https://{domain}/products/{handle}?variant={shopify_id}
image_link        → generated creative URL (or original photo if no creative yet)
additional_image_link → other product photos
brand             → vendor
gtin              → barcode
mpn               → sku
custom_label_0    → 'in_stock'
custom_label_1    → product_type
custom_label_2    → first 3 tags joined with comma
```

---

## 10. The generation pipeline

**Everything is per-variant, and (via the Creatives page's scope selector)
optionally per-image too.** The original sync only fetched `variants(first:
1)`, so a product with three colours synced as one row and silently dropped
the other two — `product_variants` now holds the full set, and generation
fans out across it.

### High-level flow

```
User clicks "Generate creatives" (dashboard)
  ↓
POST /api/generate/enqueue
  → collectFilteredProductIds()   — apply product filter (all/tag/vendor/product_type), active products only
  → computeGenerationRows()       — fan-out: per variant (IN-STOCK ONLY) × per image (per imageScope)
  → enqueueGeneration()
     → INSERT generation_jobs (batch of rows, variant_id + image_id set)
     → push job IDs to BullMQ (creative-generation queue), if Redis is reachable
  ↓ returns { batchId, enqueued }

Client polls GET /api/generate/enqueue?batchId=...  (every 2s)
  ↓ returns { pending, processing, completed, failed, cancelled, total }
  ↓ shows progress bar

Worker (two independent code paths reach the same runJob()):
  ━━ BullMQ Worker (DigitalOcean, primary for pushed jobs) ━━
  BullMQ job arrives → catalog-worker.ts
    → processGenerationJob(jobId, supabase, sharedContext)

  ━━ DB-poll loop (runs continuously on the SAME worker process) ━━
  catalog-worker.ts also polls generation_jobs directly every 3s
  (DB_POLL_INTERVAL_MS) via processBatch() — this exists because Vercel
  (AWS) cannot always reach the DigitalOcean-hosted Valkey instance, so jobs
  written to Supabase by Vercel need a way to run even if Redis is
  unreachable from the writer.

  ━━ Vercel cron backstop, for when the worker droplet itself is down ━━
  GET /api/cron/generate — see the schedule note below
    → processBatch(10, 4)  [up to 10 jobs per tick, 4 concurrently, loops
      until the queue is empty or a ~50s time budget runs out]

For each job:
  processGenerationJob()
    → claim it (status pending → processing, atomically)
    → loadProduct()   with rules cached in JobContext
    → resolveTemplateFromRules()   — first matching rule wins, ascending priority; no match → status 'skipped'
    → getTemplateCanvas()          — load canvas JSON, cached in JobContext
    → if job.image_id: use that image; else: primary image
    → if job.variant_id: load that variant for dynamic fields/price/stock; else: legacy product-level fields
    → compositeImage()             — render all template layers onto product photo
    → re-check the job hasn't been cancelled since claiming (Stop button race)
    → uploadBuffer()               — compress + upload to Cloudinary
    → upsert generated_creatives   — store the result URL
    → update generation_jobs → 'completed' (guarded: only if still 'processing')
```

**Both worker paths run in the same process simultaneously**, racing to
claim the same rows via an atomic `status='pending'→'processing'` guard —
correct and intentional, not a bug, but it means "the worker" is really two
schedulers sharing one pipeline. When diagnosing "generation is slow" or "a
job never ran," check both paths, not just one. A performance or
correctness fix applied to only `processBatch` or only `processGenerationJob`
silently doesn't apply to jobs the other path claims first.

> **Schedule note**: `/api/cron/generate`'s own code comment says
> "Configured in vercel.json to run every minute," but `vercel.json`
> currently schedules it **once daily** (`0 0 * * *`), same cadence as
> `/api/cron/sync` (`0 2 * * *`). This is stale documentation in the code,
> not a bug in generation itself — the worker's own 3-second DB-poll loop is
> what actually drains `generation_jobs` promptly in normal operation, and
> only fires once a day as a true backstop when the worker droplet is down.
> Worth deciding deliberately (fix the comment, or increase the cron
> frequency) rather than leaving the mismatch.

### Fan-out shape and scope controls

`computeGenerationRows()` (shared by `enqueueGeneration` and
`/api/generate/estimate`, so the pre-submit preview can never drift from the
real submit) builds one `generation_jobs` row per `(variant, image)` pair —
or one product-level row for a product with no synced variants at all
(legacy fallback; a product WITH variants that are all sold out or filtered
out produces zero jobs, not a fallback row).

- **Variant scope**: all in-stock variants, or a specific named option value
  (e.g. `Size: M`) — matched against `products.option{1,2,3}_name` when a
  sync has populated them, falling back to checking all three positional
  value columns when it hasn't (pre-migration-008 data).
- **Image scope**: `'all'` (one job per image) or `'first'` (one job per
  variant, its primary/first image). `imageScope` defaults to `'first'`
  everywhere — inside `enqueueGeneration` itself (so the sync's
  auto-enqueue-on-change keeps producing the job count it always has) and in
  the Creatives page UI (generating every pose for every variant is the
  expensive, deliberate choice, not the default).
- **`MAX_JOBS_PER_ENQUEUE = 50,000`** (raised from an earlier 5,000 ceiling):
  fanning out per image multiplies job count by however many photos a
  variant has. Measured directly against this project's own store: "all
  variants + all poses + all products" computes to roughly 47,000 jobs from
  one click — comfortably under the current ceiling, which now exists only
  to catch genuinely pathological input. A `SOFT_WARN_JOBS = 10,000`
  threshold logs a warning without blocking.
- Every `.in()`/embed-join query in the fan-out goes through a
  chunk-and-paginate helper (`fetchAllChunked` in `generation-queue.ts`):
  chunking the input id list alone (to stay under PostgREST's URL-length
  limit) does **not** bound how many rows a chunk's query can return —
  Supabase caps rows per request (project default 1,000) independent of
  input chunk size, and a chunk of 200 products can easily have several
  thousand combined variant/image rows. An earlier version of this code
  chunked the input but never paginated the output, which silently
  truncated results with no error — "all variants + all poses" skipped most
  products and specific in-stock variants within products it did reach,
  depending on where they landed in the uncapped result set. If you add a
  new `.in()`-based query anywhere in this fan-out, it needs both the input
  chunking AND the output pagination, with a fully deterministic
  `.order(...)` (a unique column, or a non-unique one plus a unique
  tiebreaker) — `.range()` pagination re-runs the query per page, and
  without a stable sort Postgres can reorder ties between calls and
  silently duplicate or drop rows at page boundaries.

### JobContext and caching

`createJobContext()` returns a `JobContext` with two Maps: `rulesByStore`
(caches `getActiveTemplateRules()` per store) and `templatesById` (caches
template canvas JSON per template ID). `processBatch()` creates one context
per call and shares it across every job in the batch. The BullMQ path
shares a context too, refreshed whenever more than `DB_POLL_INTERVAL_MS`
(default 3000ms — **not** 5 minutes) has passed since it was created, so a
burst of jobs processed within the same few seconds shares one fetch while
jobs further apart pick up rule/template edits made in between.

### Image compositing

`compositor.ts` uses `@napi-rs/canvas` (native Skia bindings). It renders at
2× super-sample, then downsamples (a small-canvas 3× mode was tried and
reduced to 2× because it OOM-killed the 1GB worker). Output is JPEG at
quality 95 (raised from 92 for higher fidelity — Cloudinary still applies
`f_auto,q_auto` on delivery). The canvas is always filled with a solid
background before any layer is drawn, so the output never needs an alpha
channel — JPEG is correct even though intermediate layers can be
transparent PNGs/cutouts.

**Layer order is user-controlled via each layer's `zIndex`, not a hardcoded
type-based stack** — layers are sorted ascending by `zIndex` and drawn
bottom to top. In `ai_product` mode specifically, the product cutout isn't
one of `canvasData.layers`; it's drawn via `drawProductLayer()` and spliced
into the zIndex-sorted stack at the position its own configured `zIndex`
implies. `product_zoom` mode draws the original photo as a single unit — no
cutout, no separate background layer.

### Storage: two tables, one dual-written

See §6 for the full column lists. `generated_images` (legacy, one row per
product+template) and `generated_creatives` (v2, one row per
variant+image+template) are both written by `recordCreative()` in
`creatives.ts` — see §6's note on updating its match clause if you change
what identifies a creative.

---

## 11. Inventory sync and auto-generation

### Daily cron (`/api/cron/sync`, 2 AM UTC)

Runs `syncStoreProducts()` for every active store with `incremental: false`:
- Fetches ALL products from Shopify (not just recently changed)
- Upserts `products`, `product_variants`, `product_images`
- `is_sold_out` recalculates automatically (generated column)
- After sync: calls `autoGenerateRestockedVariants()` — finds in-stock
  variants with no creative AND no job already pending/processing, and
  queues generation for them (capped at 500 variants per cycle)

**Why full sync, not incremental**: `product.updated_at` in Shopify does not
always change when inventory decreases via a POS sale — an incremental sync
("only products modified since last sync") misses that. A full sync
guarantees inventory is always current, at roughly a few seconds per
hundred products.

### Auto-generate on restock

`findUncoveredInStockVariants()` (in `generation-queue.ts`, also what powers
the dashboard's Feed Coverage card, so both agree on what "covered" means)
finds in-stock variants with no `generated_creatives` row, excludes anything
already pending/processing (so a restock queued today isn't re-queued
tomorrow before it's even drained), and queues generation for the rest at
priority 200 (below user-triggered generates). This is a backstop alongside
the sync's own changed-product diff — it catches products that were sold
out before this feature existed and never "changed" since, which the diff
alone would miss.

---

## 12. Rule engine

Rules map products to templates. Evaluated at generation time, not stored
on jobs.

**Rule structure**:
```
priority       — evaluated LOWEST-first (1 before 100) — opposite of the pre-v2 single-condition model
conditions     — array of { field, operator, value }
condition_mode — 'all' (AND) | 'any' (OR)
template_id    — the template to use when the rule matches
```

**Available condition fields** (`RuleField` in `template-resolver.ts`):
`collection`, `product_type`, `vendor`, `tag`, `title_contains`,
`price_min`, `price_max`, `sku_prefix`, `all_products`

**Available operators** (`RuleOperator`):
`is`, `is_not`, `contains`, `starts_with`, `greater_than`, `less_than`

**Resolution**: `resolveTemplateFromRules(product, rules)` walks rules by
priority ascending. First matching rule wins. If no rule matches, the job's
status becomes `'skipped'`, not `'completed'` — see §6's note on why that
distinction exists. Legacy single-condition rules (`rule_type`/
`rule_operator`/`rule_value`, nullable since migration 007) are still
evaluated when `conditions` is empty — both models coexist.

---

## 13. Migration history

Run in this order on a fresh database; each file documents its own
verification query. No migration-tracking table exists — this list *is* the
schema history.

| # | File | What it did |
|---|---|---|
| 001 | `001-rls-hardening.sql` | First RLS pass — closed anon-read access to 6 tenant tables |
| 002 | `002-v2-variants-schema.sql` | The big one: `product_variants`, `generated_creatives`, `option1/2/3` on variants, `variant_id`/`image_id` on `generation_jobs`, multi-condition columns on `template_rules` |
| 003 | `003-fresh-start-wipe.sql` | One-time destructive wipe of all pre-v2 tenant data (kept auth/profiles) to re-sync clean against the new schema |
| 004 | `004-rls-fix-products.sql` | `products` was still anon-readable after 001 — a legacy permissive policy survived because 001 only dropped policies by name. Rewritten to enumerate and drop every policy on the tenant tables before recreating them. |
| 005 | `005-expiring-tokens.sql` | Added `stores.refresh_token` / `refresh_token_expires_at` |
| 006 | `006-drop-stale-product-sku-unique.sql` | Dropped a `UNIQUE(store_id, sku)` constraint left over from the removed folder-import flow — broke sync on any real catalog with duplicate SKUs across products |
| 007 | `007-relax-legacy-rule-columns.sql` | Dropped `NOT NULL` on the legacy `rule_type`/`rule_operator`/`rule_value` columns — a v2 (`conditions`-only) rule had nothing valid to put there |
| 008 | `008-option-names-and-image-scoped-creatives.sql` | Added `products.option{1,2,3}_name`; extended `generated_creatives`'s unique index to include `image_id` so "generate every pose" doesn't overwrite itself |

`supabase/performance-indexes.sql` is index-only, no schema changes, safe to
run any time.

---

## 14. Two-worker architecture

### BullMQ Worker (DigitalOcean droplet, always on)
- Connects to Valkey via `REDIS_URL`
- Claims jobs pushed to the queue
- Shared JobContext refreshed every `DB_POLL_INTERVAL_MS` (default 3s)
- `concurrency: WORKER_GENERATION_CONCURRENCY` (default 2 — each job holds
  several full-resolution image buffers in memory; higher reliably OOM-kills
  a 1GB host)
- Start: `npm run worker` (managed by pm2)

### DB Poll (runs on the SAME worker process, continuously)
- `catalog-worker.ts` polls `generation_jobs` every `DB_POLL_INTERVAL_MS`
  and claims pending rows directly via `processBatch()` — this is the path
  that actually matters day to day, independent of whether BullMQ/Redis
  push works
- `/api/cron/generate` on Vercel calls the same `processBatch()` as a
  secondary backstop for when the worker droplet itself is down (see §10's
  schedule note)

Both paths call the same `processGenerationJob()` function. The DB is the
source of truth; BullMQ is a delivery mechanism, not a store.

---

## 15. Environment variables

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=         # worker + admin routes only — bypasses RLS

# Shopify
SHOPIFY_CLIENT_ID=                 # also known as API key
SHOPIFY_CLIENT_SECRET=
SHOPIFY_SCOPES=                    # e.g. read_products,write_products
NEXT_PUBLIC_SHOPIFY_CLIENT_ID=     # exposed to client for App Bridge init

# Cloudinary
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# AI background removal (background-removal/ — all optional, provider-specific)
BG_REMOVAL_PROVIDER=               # 'cloudinary' (default) | 'clipdrop' | 'fal' | 'removebg'
BG_REMOVAL_FALLBACK_PROVIDERS=     # comma-separated fallback chain, tried in order on failure
CLIPDROP_API_KEY=
FAL_API_KEY=
REMOVEBG_API_KEY=

# Redis/Valkey (BullMQ)
REDIS_URL=                         # redis://... or rediss://... — app runs fine without it (DB-poll fallback)

# Worker tuning
WORKER_GENERATION_CONCURRENCY=     # default 2
WORKER_SYNC_CONCURRENCY=           # default 2
DB_POLL_INTERVAL_MS=               # default 3000 — how often the worker polls generation_jobs directly

# App URL
NEXT_PUBLIC_APP_URL=               # e.g. https://craft-ify.vercel.app

# Cron auth
CRON_SECRET=                       # random secret; Vercel sends it in the Authorization header

# Misc
BACKFILL_LIMIT=                    # caps a one-off backfill script's batch size
```

---

## 16. Deployment

### Vercel (frontend + API)
- Auto-deploys on push to `main`
- Cron jobs configured in `vercel.json` (§10's schedule note)
- Serverless functions time out per-route via `export const maxDuration = ...`
  (60–300s depending on the route's expected work)
- `@napi-rs/canvas` is in `serverExternalPackages` in `next.config.ts` — a
  native binary, not bundled by webpack/turbopack

### DigitalOcean (worker)
- Any Droplet with Node.js 20+, 1–2 GB RAM
- `REDIS_URL` must point to the same Valkey instance Vercel uses (when Redis is used at all)
- Start: `pm2 start npm --name catalog-worker -- run worker`
- Redeploy after a `git push` to `main`: `git pull && npm install && pm2 restart catalog-worker`
  — **this does not happen automatically**; Vercel's auto-deploy only covers the Next.js app

### Supabase
- Manual only: apply new files under `supabase/*.sql` by hand, in numeric
  order, via the SQL Editor. A new environment must have every file
  replayed in order from `001` onward.

---

## 17. How to add a new template layer type

1. Add the type to the `Layer` union in `src/types/template.ts`
2. Add a render branch for it in `drawLayer()` in `src/lib/compositor.ts`
3. Add UI controls in `src/components/builder/` (the canvas editor)
4. Done — the compositor reads `canvasData.layers` directly from the
   template's stored JSON, sorted by each layer's own `zIndex`

## How to add a new rule condition field

1. Add the field to the `RuleField` union in `src/lib/template-resolver.ts`
2. Add evaluation logic for it in that file's condition-evaluation function
3. Add a UI field picker in `src/components/rules/rules-client.tsx`
4. Done — rule evaluation is pure TypeScript with no DB schema change needed
   (`conditions` is a jsonb array, not fixed columns)

---

## 18. Hard-won lessons (read before repeating them)

- **A worker "completing" a job proves nothing about correctness.** Verify
  output — row counts in `generated_creatives`, real Cloudinary URLs — not
  just `generation_jobs.status`.
- **An empty table returning 0 rows to the anon key proves nothing about
  RLS.** Two separate RLS leaks were only caught by seeding a real row and
  re-checking. Always test policies with data present.
- **Chunking an `.in()` query's input does not bound its output.** Supabase
  caps rows per request regardless of how the id list was chunked — a query
  returning many rows per input id (a join, an embed) needs output
  pagination too, or it silently truncates with no error. See §10.
- **Session/embedded-app behavior can't be verified by reading code alone.**
  The App Bridge loading order and the `shop`/`host` param-dropping bug were
  only found by reading the actual browser console inside the Shopify admin
  iframe. If a fix "should" work per the code but the merchant reports it
  doesn't, get the console output before iterating further.
- **Pasted specs (from any source) may assume schema or code that doesn't
  exist, or is already out of date.** Several specs this project has
  received assumed columns/functions/defaults that turned out to be wrong,
  or referenced a stale cron schedule / limit that had already changed.
  Always verify against the live schema and code before implementing a
  pasted plan literally.
- **Two schedulers, one pipeline** (§10) — a fix applied to only
  `processBatch` or only `processGenerationJob` silently doesn't apply to
  jobs the other path claims first.

---

## 19. Common debugging

**Jobs stuck in 'pending'**
→ Check if the DigitalOcean worker is running: `pm2 status`
→ Check `REDIS_URL` is correct and points to the same instance on both Vercel and the worker (if Redis is used at all)
→ Even without Redis, the worker's own 3-second DB-poll loop should drain them within seconds — if it isn't, the worker process itself is likely down or crash-looping; check `pm2 logs`

**Generated creative not appearing in feed**
→ Check `product_variants.is_sold_out` for the variant (query it directly in Supabase)
→ Check `generated_creatives` has a row for this `variant_id`
→ Feed only includes in-stock variants of active products (`is_sold_out = false`, `products.status = 'active'`)

**Token expired / needs_reauth**
→ Check `stores.needs_reauth = true` in Supabase
→ The refresh token may itself have expired (90 days) or been invalidated — the merchant must re-install the app from Shopify Partners/Admin

**Sync not picking up inventory changes**
→ Cron runs at 2 AM UTC — check Vercel's cron logs in its dashboard
→ Manually trigger: `POST /api/shopify/sync { storeId }`
→ `CRON_SECRET` must be set correctly in Vercel's environment variables and match what the route checks
