# Craftify — Architecture & Developer Guide

> Last updated: 2026-08-19
> Stack: Next.js 16 · TypeScript · Supabase · BullMQ/Valkey · Cloudinary · Shopify Admin API

---

## What Craftify does

Craftify connects to a Shopify store, fetches every product and its variants,
generates branded catalog images by compositing a user-built overlay template
onto the product photos, and exposes a live feed URL that Meta Commerce Manager
reads to populate a product catalog with generated images.

**Only in-stock variants receive generated images and appear in the feed.**
Sold-out variants are skipped at generation time and excluded from the feed entirely.

---

## Tech stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend + API | Next.js 16 App Router | Server components, streaming, Vercel deployment |
| Database | Supabase (PostgreSQL) | RLS, real-time, edge-friendly client |
| Job queue | BullMQ + Valkey (Redis-compatible) | Priority queues, fair scheduling |
| Image rendering | @napi-rs/canvas | Server-side canvas (native Skia bindings), no browser required |
| Image storage/CDN | Cloudinary | Delivery URL transforms, auto-format/quality |
| Background worker | Node.js process on DigitalOcean | Long-running BullMQ worker + DB-poll fallback, 1–2 GB RAM |
| Shopify API client | axios | Admin GraphQL client (`shopify.ts`) — not native fetch |

---

## Folder structure

```
craftify/
├── src/
│   ├── app/                         # Next.js App Router
│   │   ├── (auth)/                  # Auth routes (outside dashboard layout)
│   │   │   └── login/
│   │   │       ├── page.tsx         # Supabase email login
│   │   │       └── signup/page.tsx
│   │   ├── api/                     # All API routes
│   │   │   ├── shopify/             # OAuth install/callback/auth/sync
│   │   │   ├── generate/            # enqueue, cancel, single, estimate, bulk, stats, status
│   │   │   ├── cron/                # sync (daily), generate (daily DB-drain backstop)
│   │   │   ├── feed/[storeId]/      # Live Meta Commerce feed
│   │   │   ├── products/            # Product list + detail + variants + generate
│   │   │   ├── templates/           # Template CRUD + thumbnail
│   │   │   ├── rules/               # Rule engine CRUD + reorder
│   │   │   ├── creatives/           # Generated creatives list + delete
│   │   │   ├── upload/              # Cloudinary asset upload
│   │   │   ├── background/          # AI background-removal + its cache
│   │   │   ├── background-reconstruction/  # Background-plate reconstruction
│   │   │   ├── product-layer/       # Combined cutout+background "layer bundle"
│   │   │   ├── product-positioning/ # Head Space / smart-fit placement math endpoint
│   │   │   ├── image-extend/        # Cloudinary AI Extend (canvas fill)
│   │   │   ├── webhooks/            # Shopify mandatory GDPR compliance webhooks
│   │   │   └── stores/[storeId]/    # Per-store sync
│   │   ├── dashboard/               # Authenticated app UI
│   │   │   ├── layout.tsx           # Dashboard shell: sidebar + redirect-if-signed-out
│   │   │   ├── page.tsx             # Home stats + Feed Coverage card
│   │   │   ├── products/            # Product list (+ In Stock/All toggle) + [id] detail
│   │   │   ├── templates/           # Template list + [id]/edit canvas builder + new
│   │   │   ├── creatives/           # Generate + view creatives
│   │   │   ├── rules/               # Rule engine editor
│   │   │   └── settings/            # Store connection, feed URL, OAuth status
│   │   ├── layout.tsx               # Root layout: fonts, Shopify App Bridge script
│   │   ├── globals.css              # Tailwind base + CSS variables
│   │   └── page.tsx                 # Public landing / Shopify install redirect
│   │
│   ├── components/
│   │   ├── ui/                      # shadcn/ui primitives (Button, Card, Input…)
│   │   ├── dashboard/sidebar.tsx    # Navigation sidebar
│   │   ├── creatives/               # CreativesClient (Generate page logic), download-zip-button
│   │   ├── products/                # ProductsTable, ProductsSearch, StockToggle
│   │   ├── builder/                 # Canvas editor internals (canvas-preview, product-positioning-guide, toolbar…)
│   │   ├── templates/               # Template list/editor chrome around builder/
│   │   ├── rules/                   # RulesClient
│   │   └── settings/                # ConnectStoreForm, StoreCard, OAuthStatusBanner
│   │
│   ├── lib/                         # Server-side business logic
│   │   ├── supabase/
│   │   │   ├── server.ts            # SSR Supabase client (cookie-based, anon key — RLS applies)
│   │   │   ├── client.ts            # Browser Supabase client
│   │   │   └── get-user.ts          # React cache() deduplication for auth
│   │   ├── active-store.ts          # Resolves active store from cookie + user's store list
│   │   ├── shopify.ts               # Admin GraphQL API client (axios-based)
│   │   ├── shopify-host.ts          # Embedded app host cookie
│   │   ├── shopify-token.ts         # OAuth token exchange/refresh + shopifyFetch()
│   │   ├── shopify-sync.ts          # Full product/variant/image sync; auto-enqueues restocked variants
│   │   ├── shopify-webhook.ts       # HMAC verification for Shopify webhooks
│   │   ├── template-resolver.ts     # Rule matching: product(+variant) → template
│   │   ├── compositor.ts            # @napi-rs/canvas image renderer
│   │   ├── product-layer-engine.ts  # Orchestrates cutout + background-plate + metadata as one cached bundle
│   │   ├── product-positioning.ts / product-positioning-shared.ts  # "Head Space" smart-fit placement math
│   │   ├── image-bounds.ts          # Product-in-photo bounding-box detection
│   │   ├── background-removal/      # Pluggable AI cutout providers (Cloudinary/Clipdrop/fal.ai/remove.bg) + fallback chain
│   │   ├── background-reconstruction/  # Background-plate reconstruction from a cutout
│   │   ├── image-extend/            # Cloudinary AI Extend (canvas fill) helper
│   │   ├── cloudinary.ts            # Upload with smart compression
│   │   ├── generation-queue.ts      # Enqueue + process generation jobs (see below)
│   │   ├── creatives.ts             # recordCreative() — upserts generated_creatives
│   │   ├── queues.ts                # BullMQ Queue factory
│   │   ├── redis.ts                 # ioredis connection (nullable if no REDIS_URL)
│   │   ├── rate-limit.ts            # Redis sliding-window rate limiter
│   │   ├── perf.ts                  # Structured timing logs (logPerf/measureAsync)
│   │   ├── concurrency.ts           # mapWithConcurrency, chunkArray
│   │   ├── editor-preview.ts        # Canvas builder's live-preview render path
│   │   └── utils.ts                 # cn() — clsx + tailwind-merge
│   │
│   ├── workers/
│   │   └── catalog-worker.ts        # DigitalOcean long-running BullMQ worker + 3s DB-poll fallback loop
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
├── supabase/                          # Hand-applied SQL migrations, run in numeric order (no migration table)
├── vercel.json                       # Two crons: daily sync (2 AM UTC) + daily generate drain (midnight UTC)
├── next.config.ts                    # External packages, CSP headers
└── ARCHITECTURE.md                   # This file
```

---

## Database schema (Supabase)

All tables have RLS enabled. The worker and cron routes use `SUPABASE_SERVICE_ROLE_KEY`
which bypasses RLS. Dashboard-facing API routes and server components use the
anon key with session context — users only see their own stores' data.
Migrations live in `supabase/*.sql`, applied by hand via the Supabase SQL Editor
in numeric order — there is no migration-tracking table or automated runner.

### Core tables

**`stores`**
Primary entity. One row per connected Shopify store.
```
id                    uuid PK
user_id               uuid → auth.users
shop_domain           text  (e.g. vinayak-test-store.myshopify.com)
shop_name             text
access_token          text  (1-hour expiring offline token — Shopify rejects non-expiring tokens)
refresh_token         text  (90-day; Shopify rotates BOTH on every refresh — always persist the new value)
token_expires_at      timestamptz
refresh_token_expires_at timestamptz
needs_reauth          bool  (set when token refresh fails — UI prompts reconnect)
feed_token            uuid  (public, used to authenticate /api/feed/ requests)
currency              text  (e.g. INR)
is_active             bool
last_synced_at        timestamptz
```

**`products`**
```
id              uuid PK
store_id        uuid → stores
shopify_id      text  (Shopify product GID)
title, handle, vendor, product_type, tags, description, status
option1_name, option2_name, option3_name  text  (which option position is "Size"/"Colour" — migration 008)
price, compare_at_price, inventory_quantity, sku   -- DEPRECATED variant[0] mirrors, kept for legacy readers
```

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
`is_sold_out` is a real Postgres generated column, not application-maintained —
it can't drift out of sync with inventory the way a manually-set boolean would.

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
variant_ids       text[] (Shopify variant IDs this image belongs to; empty = shown for every variant)
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
priority        int  (LOWER number = HIGHER priority; evaluated ascending)
conditions      jsonb  (array of RuleCondition)
condition_mode  text  ('all' | 'any')
active          bool
rule_type, rule_operator, rule_value  -- legacy single-condition columns, still honoured if conditions is empty
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

**`generated_creatives`**
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

**`bg_removal_cache`**
Caches AI background-removal/reconstruction output per source image URL, keyed
so the same product photo is never re-processed by the AI provider twice.
Used by `background-removal/`, `background-reconstruction/`, and
`product-layer-engine.ts` (which reads/writes it as one combined bundle:
transparent cutout + background plate + shot-type metadata).

---

## Authentication flow

Craftify uses two auth mechanisms side by side:

### 1. Supabase session (email login)
Used for the web dashboard (non-embedded access). Standard Supabase email/password
auth with SSR cookie-based sessions, validated in `middleware.ts`.

```
User visits /login → signs in → Supabase sets auth cookie → middleware validates
→ redirects to /dashboard
```

### 2. Shopify OAuth (embedded app)
Used when the app is accessed from Shopify admin. The install flow:

```
Merchant installs app from Shopify Partners
  → GET /api/shopify/install?shop=...
     → builds Shopify OAuth URL
     → redirects merchant to Shopify consent screen
  → Shopify redirects back to GET /api/shopify/callback?code=...&shop=...
     → exchanges code for an EXPIRING offline access token (Shopify rejects
       non-expiring tokens outright as of Dec 2025)
     → creates/updates stores row in DB
     → creates Supabase user account (or links existing)
     → triggers first product sync in background
     → redirects to /dashboard
  → For subsequent requests in the Shopify admin iframe:
     POST /api/shopify/auth { idToken }
     → exchanges the short-lived session token for a fresh offline token
     → returns { supabaseToken } for client-side auth
```

Expiring offline tokens last **1 hour** and ship with a 90-day refresh token.
`shopify-sync.ts`'s `ensureFreshToken()` refreshes the token ~5 minutes before
expiry on every sync, so the cron and the worker — which run with no browser
session to re-trigger token exchange — stay authenticated indefinitely. Shopify
rotates both tokens on every refresh and immediately invalidates the old
refresh token, so the new value is written back to `stores` in the same call.

The `shopifyFetch()` helper (in `shopify-token.ts`) wraps `fetch` to automatically
attach the `Authorization: Bearer <shopify-id-token>` header required by Shopify's
session-token checks for App Store review.

---

## Generation pipeline

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

Worker (two paths, same underlying code):
  ━━ BullMQ path (DigitalOcean worker, primary) ━━
  BullMQ job arrives → catalog-worker.ts
    → processGenerationJob(jobId, supabase, sharedContext)

  ━━ DB poll path (fallback, runs continuously on BOTH the worker and cron) ━━
  catalog-worker.ts also polls the DB directly every 3s (DB_POLL_INTERVAL_MS) —
  this is the path that actually matters day to day, since Vercel (AWS) cannot
  reach the DigitalOcean-hosted Valkey over a private network in some setups.
  GET /api/cron/generate (Vercel cron, currently scheduled DAILY — see note below)
    → processBatch(10, 4)  [up to 10 jobs per tick, 4 concurrently, loops until
      the queue is empty or a ~50s time budget runs out]
      → processGenerationJob() for each claimed job

For each job:
  processGenerationJob()
    → claim it (status pending → processing, atomically)
    → loadProduct()   with rules cached in JobContext
    → resolveTemplateFromRules()   — find matching template rule; no match → status 'skipped'
    → getTemplateCanvas()          — load canvas JSON, cached in JobContext
    → if job.image_id: use that image; else: primary image
    → if job.variant_id: load that variant for dynamic fields/price/stock; else: legacy product-level fields
    → compositeImage()             — render all template layers onto product photo
    → re-check the job hasn't been cancelled since claiming (Stop button race)
    → uploadBuffer()               — compress + upload to Cloudinary
    → upsert generated_creatives   — store the result URL
    → update generation_jobs → 'completed' (guarded: only if still 'processing')
```

> **Note on `/api/cron/generate`'s schedule**: the route's own code comment says
> "Configured in vercel.json to run every minute", but `vercel.json` currently
> schedules it **once daily** (`0 0 * * *`), same cadence as `/api/cron/sync`.
> This is stale documentation in the code, not a bug in generation itself — the
> DigitalOcean worker's own internal 3-second DB-poll loop (in
> `catalog-worker.ts`, always running as long as `pm2` is up) is what actually
> drains `generation_jobs` promptly in normal operation. The Vercel cron is a
> secondary backstop for when the whole worker droplet is down, and today only
> fires once a day in that scenario. Worth deciding deliberately (fix the
> comment, or increase the cron frequency) rather than leaving the mismatch.

### JobContext and caching

`createJobContext()` returns a `JobContext` with two Maps:
- `rulesByStore` — caches `getActiveTemplateRules()` result per store
- `templatesById` — caches template canvas JSON per template ID

`processBatch()` creates one `JobContext` per call and shares it across every
job in that batch. The BullMQ path shares a context across jobs too, but
refreshes it whenever more than `DB_POLL_INTERVAL_MS` (default 3000ms) has
passed since it was created — not every 5 minutes — so a burst of jobs
processed within the same few seconds shares one fetch, while jobs further
apart pick up rule/template edits made in between.

### Image compositing

`compositor.ts` uses `@napi-rs/canvas` (native Node.js bindings to Skia).
It renders at 2× super-sample (`SUPERSAMPLE` / `SUPERSAMPLE_SM`, both currently
2× — a small-canvas 3× mode was tried and reduced to 2× because it OOM-killed
the 1GB worker), then downsamples.

**Layer order is user-controlled via each layer's `zIndex`, not a hardcoded
type-based stack** — layers are sorted ascending by `zIndex` and drawn bottom
to top. In `ai_product` mode specifically, the product cutout isn't one of
`canvasData.layers`; it's drawn via `drawProductLayer()` and spliced into the
zIndex-sorted stack at the position its own configured `zIndex` implies (every
other layer with a lower zIndex draws first as "background", everything at or
above it draws after as "foreground"). `product_zoom` mode draws the original
photo as a single unit — no cutout, no separate background layer.

Output: JPEG at quality 95 (raised from 92 for higher fidelity; Cloudinary
still applies `f_auto,q_auto` on delivery). The canvas is always filled with a
solid background before any layer is drawn, so the output never needs an alpha
channel — JPEG is correct here even though intermediate layers can be
transparent PNGs/cutouts.

---

## Feed API

`GET /api/feed/[storeId]?token={feed_token}&format={csv|xml|json}`

This is the Meta Commerce Manager data source URL. Meta fetches it every few hours.

**Authentication**: `feed_token` from `stores.feed_token`. It is a public, read-only
token safe to embed in the URL. It grants access to this feed only.

**Content**: One row per in-stock product variant (of an active product) that
has a generated creative, or the original product photo as fallback if
generation hasn't caught up yet. Out-of-stock variants are completely absent —
no row, not even one marked "out of stock".

**Streaming**: Response is streamed (`ReadableStream`) to handle large catalogs
without buffering all rows in memory.

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

## Inventory sync and auto-generation

### Daily cron (`/api/cron/sync`, 2 AM UTC)

Runs `syncStoreProducts()` for every active store with `incremental: false`:
- Fetches ALL products from Shopify API (not just recently changed)
- Upserts `products`, `product_variants`, `product_images` tables
- `is_sold_out` is a generated DB column — recalculates automatically after upsert
- After sync: calls `autoGenerateRestockedVariants()` — finds in-stock variants
  with no creative AND no job already pending/processing, and queues generation
  for them (capped at 500 variants per cycle)

### Why full sync (not incremental)?
`product.updated_at` in Shopify does not always change when inventory decreases
via a POS sale. Incremental sync misses these changes. Full sync guarantees
inventory is always current, at roughly a few seconds per hundred products.

### Auto-generate on restock
When a variant transitions from sold-out → in-stock and has no creative:
1. `findUncoveredInStockVariants()` finds it after sync (also powers the
   dashboard's Feed Coverage card, so both agree on what "covered" means)
2. Excludes anything already pending/processing, so it isn't re-queued every
   day before the previous attempt has even finished
3. Queues a generation job at priority 200 (below user-triggered generates,
   which default to priority ~1–100 based on queue depth)
4. Worker renders and uploads the creative
5. Next Meta feed fetch: variant appears with a generated image

---

## Rule engine

Rules map products to templates. Evaluated at generation time (not stored on jobs).

**Rule structure**:
```
priority       — evaluated LOWEST-first (1 before 100)
conditions     — array of { field, operator, value }
condition_mode — 'all' (AND) | 'any' (OR)
template_id    — the template to use when the rule matches
```

**Available condition fields** (`RuleField` in `template-resolver.ts`):
`collection`, `product_type`, `vendor`, `tag`, `title_contains`,
`price_min`, `price_max`, `sku_prefix`, `all_products`

**Available operators** (`RuleOperator`):
`is`, `is_not`, `contains`, `starts_with`, `greater_than`, `less_than`

**Resolution**:
`resolveTemplateFromRules(product, rules)` walks rules by priority ascending.
First matching rule wins. If no rule matches, the job's status becomes
`'skipped'` (distinct from `'completed'`) — nothing is generated, and this is
countable/visible rather than looking like a silent success.

Legacy single-condition rules (`rule_type`/`rule_operator`/`rule_value` columns,
pre-dating multi-condition support) are still evaluated when `conditions` is empty.

---

## Two-worker architecture

### BullMQ Worker (DigitalOcean droplet, always on)
- Connects to Valkey (Redis-compatible) via `REDIS_URL`
- Claims jobs pushed to the queue
- Shared JobContext refreshed every `DB_POLL_INTERVAL_MS` (default 3s)
- `concurrency: WORKER_GENERATION_CONCURRENCY` (default 2 — each job holds
  several full-resolution image buffers in memory; higher reliably OOM-kills a
  1GB host)
- Start: `npm run worker` (managed by pm2)

### DB Poll (runs on the SAME worker process, continuously — not just on Vercel)
- `catalog-worker.ts` polls `generation_jobs` every `DB_POLL_INTERVAL_MS` and
  claims pending rows directly via `processBatch()` — this is the path that
  actually matters day to day, independent of whether BullMQ/Redis push works
- `/api/cron/generate` on Vercel calls the same `processBatch()` as a secondary
  backstop for when the worker droplet itself is down (see the schedule note above)

Both paths call the same `processGenerationJob()` function. The DB is the source
of truth; BullMQ is a delivery mechanism, not a store — a job that never gets a
BullMQ push still gets processed by the DB-poll loop.

---

## Environment variables

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

## Deployment

### Vercel (frontend + API)
- Auto-deploys on push to `main`
- Cron jobs configured in `vercel.json` — Vercel calls them on schedule (see
  the schedule note under Generation Pipeline above)
- Serverless functions time out per-route via `export const maxDuration = ...`
  (60–300s depending on the route's expected work)
- `@napi-rs/canvas` is in `serverExternalPackages` in `next.config.ts` — it's a
  native binary, not bundled by webpack/turbopack

### DigitalOcean (worker)
- Any Droplet with Node.js 20+, 1–2 GB RAM
- `REDIS_URL` must point to the same Valkey instance Vercel uses (when Redis is used at all)
- Start: `pm2 start npm --name catalog-worker -- run worker`
- Redeploy after a `git push` to `main`: `git pull && npm install && pm2 restart catalog-worker`
  — **this does not happen automatically**; Vercel's auto-deploy only covers
  the Next.js app, not this droplet

### Supabase
- Manual only: apply new files under `supabase/*.sql` by hand, in numeric
  order, via the Supabase dashboard's SQL Editor. There is no migration table
  and no automated runner — a new environment must have every file replayed
  in order from `001` onward.

---

## How to add a new template layer type

1. Add the type to the `Layer` union in `src/types/template.ts`
2. Add a render branch for it in `drawLayer()` in `src/lib/compositor.ts`
3. Add UI controls in `src/components/builder/` (the canvas editor)
4. Done — the compositor reads `canvasData.layers` directly from the template's
   stored JSON, sorted by each layer's own `zIndex`

## How to add a new rule condition field

1. Add the field to the `RuleField` union in `src/lib/template-resolver.ts`
2. Add evaluation logic for it in that file's condition-evaluation function
3. Add a UI field picker in `src/components/rules/rules-client.tsx`
4. Done — rule evaluation is pure TypeScript with no DB schema change needed
   (`conditions` is a jsonb array, not fixed columns)

---

## Common debugging

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
