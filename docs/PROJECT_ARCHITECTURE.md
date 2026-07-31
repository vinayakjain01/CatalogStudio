# Craftify — Full Architecture & Knowledge Map

_Compiled 2026-07-08 from a complete read-through of the codebase (8 parallel subsystem audits). This is a living reference — verify against current code before relying on it for anything load-bearing, especially DB schema (no migrations are checked into this repo)._

---

## 1. Project Overview

**Craftify** (formerly CatalogStudio) is an AI-powered creative-automation platform for Shopify brands. A merchant connects a Shopify store, its product catalog syncs in, the merchant builds one or more visual **templates** (layered canvas designs with text/image/logo/badge layers and product-image slots), defines **rules** that map products to templates (by tag/vendor/type/discount/import batch), and the platform bulk-generates a finished marketing creative (PNG) per product by running the product photo through AI background removal / AI outpainting and compositing it into the template. Finished creatives are stored on Cloudinary and exposed to the dashboard, a ZIP export, and a Meta (Facebook/Instagram) Shopping product feed (XML).

Stack: **Next.js 16.2.9** (App Router, async `params`/`searchParams`, `force-dynamic` opt-outs), **TypeScript**, **Supabase** (Postgres + Auth, no in-repo migrations — schema is dashboard-managed), **Cloudinary** (image hosting/transforms/AI generative fill), **BullMQ + ioredis** against a DigitalOcean-managed **Redis/Valkey**, a standalone **Node/PM2 worker** process, **Shopify Admin GraphQL API** + OAuth, **Meta Catalog** (feed-only, no Graph API calls), browser **directory upload** (local folder import), `@napi-rs/canvas` for server-side compositing, and **Vercel** for hosting + cron.

> Note on `AGENTS.md`: this repo pins Next.js 16.2.9 and ships framework docs under `node_modules/next/dist/docs/`. The codebase already uses the async `params`/`searchParams` convention consistently, and uses the `export const dynamic = 'force-dynamic'` escape hatch (not the newer `connection()`/`cacheLife` APIs) wherever a server component needs a fresh per-request Supabase read.

---

## 2. Knowledge Map (Dependency Flow)

```
Frontend (App Router pages/components)
   │  fetch/POST
   ▼
API Routes (src/app/api/**)
   │  calls
   ▼
Business Logic (src/lib/**)
   │  ├─ template-resolver.ts  (rules → template)
   │  ├─ compositor.ts         (render final PNG, @napi-rs/canvas)
   │  ├─ background-removal/*  (4 providers + Cloudinary cache)
   │  ├─ image-extend/*        (Cloudinary generative fill)
   │  ├─ shopify.ts / shopify-sync.ts (Admin GraphQL, product sync)
   │  └─ generation-queue.ts   (orchestrates DB + BullMQ)
   │
   ├──► Supabase Postgres (source of truth for everything: stores,
   │     products, product_images, templates, template_rules,
   │     generation_jobs, generated_images, sync_logs, catalog_imports,
   │     bg_removal_cache, image_extend_cache)
   │
   └──► queues.ts (BullMQ) ──► Redis/Valkey ──► catalog-worker.ts (PM2 process)
                                                     │
                                                     ├─ generation Worker → generation-queue.runJob()
                                                     │     → background-removal → image-extend → compositor
                                                     │     → cloudinary.uploadBuffer() → generated_images row
                                                     ├─ product-sync Worker → shopify-sync.syncStoreProducts()
                                                     ├─ feed/meta-refresh Workers (stubs, no-op)
                                                     └─ dbPollTick loop (Supabase-only fallback path, runs
                                                        regardless of Redis reachability — see §7 bug notes)

Vercel Cron (vercel.json, daily 00:00 UTC)
   ├─ /api/cron/sync     → syncStoreProducts() for all active stores, inline (no queue)
   └─ /api/cron/generate → processBatch() inline, drains generation_jobs for 50s budget

Dashboard reads: products/templates/rules/creatives pages query Supabase directly
                 (server components), independent of the worker.

Meta feed:  /api/feed/[storeId] (token-authed, public) streams products+generated_images
            as Google Shopping RSS/XML — consumed by Meta Commerce Manager externally.
```

---

## 3. Folder-by-Folder Guide

| Folder | Purpose | Critical files | Notes |
|---|---|---|---|
| `src/app/(auth)/` | Login/signup pages, Supabase password auth | `login/page.tsx`, `login/signup/page.tsx` | Plain client-side `signInWithPassword`/`signUp` |
| `src/app/api/shopify/` | OAuth install/callback/finalize + embedded-app launch | `install`, `callback`, `auth`, `auth/finalize` | Two parallel OAuth flows (manual connect vs. Shopify-embedded launch) — see §5 |
| `src/app/api/webhooks/` | Shopify GDPR mandatory webhooks | `customers/data_request`, `customers/redact`, `shop/redact` | First two are stubs (HMAC-verified, no-op); `shop/redact` actually deletes the store row |
| `src/app/api/cron/` | Vercel cron entry points | `generate/route.ts`, `sync/route.ts` | Run pipeline logic **inline**, not via BullMQ; secured by `CRON_SECRET` bearer header |
| `src/app/api/generate/` | Generation control plane | `enqueue`, `single`, `cancel`, `stats` | `enqueue` = bulk (DB + optional BullMQ), `single` = synchronous on-demand |
| `src/app/api/background/`, `src/app/api/image-extend/` | Standalone AI endpoints used by the live editor for preview | `remove/route.ts`, `cache/route.ts`, `image-extend/route.ts` | Same cache-check-then-generate pattern as the real pipeline, so editor preview matches final output |
| `src/app/api/templates/` | Template CRUD + thumbnail render | `route.ts`, `[templateId]/route.ts`, `[templateId]/thumbnail/route.ts` | `PUT` has no field allow-list (see §9) |
| `src/app/api/rules/` | Rules CRUD | `route.ts` (GET/POST), `[ruleId]/route.ts` (DELETE only) | **No update/reorder endpoint exists** |
| `src/app/api/products/`, `src/app/api/categories/` | Product listing/filtering API + template categories | | |
| `src/app/api/upload/folder/`, `/images/`, `/status/`, `/image/`, `/retry/` | Local folder upload → new store + products | `folder/route.ts` (session open/finalise), `images/route.ts` (per-image Cloudinary + product create) | Creates a brand-new store per import; every route re-verifies ownership via `lib/uploads/session.ts` |
| `src/app/api/catalog/export/` | XLSX/CSV export of one upload batch | `route.ts` | Only works for products with `import_id` set |
| `src/app/api/feed/[storeId]/` | Public Meta Shopping XML feed | `route.ts` | Token-authed via `stores.feed_token`, always XML regardless of `?format=` |
| `src/app/api/meta/connect/` | Persists a merchant-entered Meta Catalog ID | `route.ts` | No real Meta Graph API integration |
| `src/app/api/stores/[storeId]/sync/`, `src/app/api/active-store/`, `src/app/api/upload/` | Manual sync trigger, store-switcher cookie, generic image upload | | |
| `src/app/dashboard/` | All authenticated pages (products, upload, templates, rules, creatives, meta, settings) | `layout.tsx` (auth gate + active-store load), `page.tsx` (stat cards) | Nested under one server-component layout |
| `src/components/builder/` | **The live template editor (canonical, actively used)** | `template-builder-client.tsx`, `canvas-preview.tsx`, `layer-panel.tsx`, `layer-properties.tsx`, `smart-background.tsx`, `use-extend-preview.ts`, `use-transparent-preview.ts` | Pure DOM/CSS renderer, drag/resize via raw mouse listeners |
| `src/components/templates/` | **Legacy/dead** — superseded editor components | `canvas-preview.tsx`, `layer-properties.tsx`, `toolbar.tsx` | Zero live imports except `delete-template-button.tsx`, which **is** used |
| `src/components/rules/`, `src/components/products/`, `src/components/creatives/`, `src/components/upload/`, `src/components/meta/`, `src/components/settings/`, `src/components/dashboard/` | Feature-scoped UI for each dashboard section | | |
| `src/components/ui/` | shadcn primitives | | Standard, lightly customized |
| `src/lib/background-removal/` | Multi-provider abstraction + Cloudinary-backed cache | `index.ts`, `provider.ts`, `clipdrop-provider.ts`, `removebg-provider.ts`, `fal-birefnet-provider.ts`, `cloudinary-provider.ts` | `photoroom` is declared but unimplemented (dead union member) |
| `src/lib/image-extend/` | Cloudinary generative-fill (AI outpaint) wrapper + cache | `index.ts` | |
| `src/lib/catalog-import/` | Cloudinary upload + magic-byte type detection for imported images | `image-storage.ts` | Shared by the folder-upload route; the former Drive/Dropbox URL-normalization layer was removed with the Drive import |
| `src/lib/compositor.ts` | **The core rendering engine** — `@napi-rs/canvas` based, draws all layer types, backgrounds, supersampling/downscale | | Second, independent renderer from the DOM-based live editor — must be kept pixel-compatible by hand |
| `src/lib/template-resolver.ts` | Rule matching (product → template) | | First-match-wins by `priority DESC`, no tie-break |
| `src/lib/generation-queue.ts` | Orchestrates `generation_jobs` (DB) + optional BullMQ push; contains `runJob`/`processBatch` (the actual pipeline execution) | | Also the DB-poll fallback executor |
| `src/lib/queues.ts` | Thin BullMQ `Queue` wrapper (4 named queues) | | |
| `src/lib/redis.ts` | Singleton ioredis client, TLS auto-detect via `rediss://` | | |
| `src/lib/concurrency.ts` | Generic `mapWithConcurrency`/`chunkArray` helpers | | Not an external-API rate limiter |
| `src/lib/shopify.ts` | Shopify Admin **GraphQL** client, product pagination, throttle-retry | | REST API not used (deprecated for new apps) |
| `src/lib/shopify-sync.ts` | Product sync orchestration (fetch → upsert → image replace → change-detect → auto-enqueue) | | |
| `src/lib/shopify-token.ts` | Session-token → offline-token exchange (embedded app flow) | | |
| `src/lib/shopify-webhook.ts` | HMAC verification for Shopify webhooks | | |
| `src/lib/active-store.ts` | Server-side "current store" resolution + ownership check | | |
| `src/lib/cloudinary.ts` | Upload + delivery-URL helper (`f_auto,q_auto:best`) | | |
| `src/lib/uploads/` | Folder-upload support: shared file classification, session/ownership guard, browser-side alpha-safe compression, directory picking | `image-files.ts`, `session.ts`, `client-compress.ts`, `pick-files.ts` | `image-files.ts` predicates run on BOTH client and server so the two cannot drift |
| `src/lib/editor-preview.ts` | Dead code — its one export is never called (pages duplicate the logic inline) | | |
| `src/lib/supabase/` | Browser + server Supabase client factories | `client.ts`, `server.ts` | Server client forces `sameSite:none; secure; partitioned` cookies (needed inside the Shopify admin iframe) |
| `src/stores/builder-store.ts` | Zustand store for the live editor (single flat store, no persist middleware) | | |
| `src/types/template.ts` | Canonical types: `Template`, `CanvasData`, 7 layer types, `BackgroundSettings`, `ProductLayerSettings` | | |
| `src/workers/catalog-worker.ts` | PM2/tsx worker entrypoint: 4 BullMQ Workers + a DB-poll loop + stuck-job recovery on boot | | Runs `dbPollTick` unconditionally, even when Redis is reachable — dual execution path (see §9) |
| `src/middleware.ts` | Auth gate for `/dashboard*`, pass-through for Shopify OAuth routes | | Does **not** gate other API routes — each checks auth itself |
| `supabase/performance-indexes.sql` | Index definitions only | | **No table-creation migrations are checked into this repo** — schema below is reverse-engineered from query call sites |
| `docs/performance-infrastructure.md` | Pre-existing perf notes | | |

---

## 4. Database Design (reverse-engineered — no migrations in repo)

No `supabase/migrations` folder exists. Every table/column below is inferred from actual `.from()/.select()/.insert()/.update()` call sites across the codebase, not from a schema file — treat column lists as "columns observed in use," not exhaustive.

| Table | Key columns observed | Relationships |
|---|---|---|
| `stores` | `id, user_id, shop_name, shop_domain (unique), shop_email, access_token (plaintext), scope, token_expires_at, currency, needs_reauth, is_active, installed_at, last_synced_at, feed_token, meta_catalog_id, meta_feed_status, meta_feed_last_sync` | root; `user_id` → Supabase auth user |
| `products` | `id, store_id, shopify_id, title, handle, vendor, product_type, tags[], price, compare_at_price, inventory_quantity, status, sku, import_id, image_url, updated_at` | `store_id`→stores; unique `(store_id, shopify_id)`; `import_id`→catalog_imports |
| `product_images` | `id, product_id, shopify_image_id, src, alt, position, is_primary` | `product_id`→products; fully delete+reinserted on every Shopify sync |
| `templates` | `id, store_id, user_id, category_id, name, description, canvas_data (jsonb), thumbnail_url, is_active, created_at, updated_at` | `category_id`→template_categories |
| `template_categories` | `id, user_id, store_id, name, created_at` | |
| `template_rules` | `id, store_id, user_id, rule_type, rule_operator, rule_value, priority, template_id, is_active` | `template_id`→templates |
| `generation_jobs` | `id, store_id, product_id, template_id, creative_type, status (pending/processing/completed/failed/cancelled), batch_id, attempts, max_attempts, locked_at, error, bg_removal_status, transparent_url, created_at, updated_at` | queue-table backing both BullMQ and DB-poll execution |
| `generated_images` | `id, product_id, template_id, creative_type, cloudinary_public_id, generated_url, status, updated_at` | unique `(product_id, template_id, creative_type)`; **no `store_id` column**; `status` is only ever written as `'completed'` anywhere in the codebase |
| `sync_logs` | `id, store_id, sync_type, status, products_synced, error_message, completed_at, created_at` | audit trail per sync run |
| `catalog_imports` | `id, store_id, user_id, filename, source_url, status, total_rows, imported_rows, failed_rows, error_report` | groups one upload batch |
| `catalog_import_rows` | raw staging rows per import | `import_id`→catalog_imports |
| `bg_removal_cache` | keyed by sha256 of source URL → Cloudinary transparent-PNG URL | |
| `image_extend_cache` | keyed by `(source URL, width, height)` hash → extended-image URL | |

Two things worth flagging explicitly since the original brief asked about `creative_status`/`feed_status`: **neither column name exists anywhere in the code.** The actual analogues are `generated_images.status` and `stores.meta_feed_status`.

Also notable: **two parallel product-image models coexist** — the relational `product_images` table (Shopify-sync path, raw Shopify CDN URLs) vs. a single `products.image_url` column (folder-upload path — which also writes a `product_images` row, so uploaded products appear in both). Code written against one will silently misbehave for products created via the other pipeline.

---

## 5. Authentication & Shopify OAuth

- **Supabase auth**: `src/middleware.ts` calls `getUser()` on every non-excluded route; redirects unauthenticated users off `/dashboard*` and authenticated users off `/login*`. It does **not** gate other API routes — each one checks auth independently.
- **Two OAuth flows**:
  1. **Manual connect** (Settings page → `/api/shopify/install` → Shopify → `/api/shopify/callback`): CSRF nonce in an httpOnly cookie, verified on return; exchanges `code` for an **offline** (non-expiring) token via raw query-string construction (`grant_options[]=offline`, deliberately bypassing `URLSearchParams` encoding).
  2. **Embedded app launch** (`/api/shopify/auth`): triggered when Shopify opens the app in an iframe; verifies HMAC over launch params, and if an App Bridge `id_token` is present, does a **token-exchange** grant for a fresh offline token (`shopify-token.ts`). Signs the store owner into Supabase via `admin.generateLink` + `verifyOtp` (magic-link, no password).
- **Tokens are stored in plaintext** in `stores.access_token` — no encryption/KMS wrapping anywhere in the codebase.
- **GDPR webhooks**: `customers/data_request` and `customers/redact` are HMAC-verified stubs (return 200, do nothing, comment claims no PII is stored). `shop/redact` actually deletes the `stores` row and relies on `ON DELETE CASCADE` (not verified against real schema in this repo).
- **Active store**: single `active_store_id` cookie, re-validated server-side against the current user on every read (`active-store.ts`).

See the full agent report for a longer list of specific issues (duplicated HMAC/regex helpers, inconsistent cookie flags across the three places that set `active_store_id`, silent swallow of token-exchange failures) — summarized in §9.

## 6. Product Sync

`shopify-sync.ts` pulls products via **GraphQL only** (REST is 403'd for new apps), paginated 250/page, optionally filtered by `updated_at` for incremental syncs. Only `variants[0]`'s price/inventory is captured — multi-variant products lose all other variants' data, and no `variants` table exists. Images are fully deleted and reinserted per sync (not diffed). Upsert key is `(store_id, shopify_id)`. **There is no reconciliation for products deleted/archived in Shopify** — they persist in Craftify forever. Auth failures set `stores.needs_reauth = true`.

## 7. Template System

A template is a `name` + JSON `canvas_data` blob: `{width, height, aspectRatio, backgroundColor, backgroundImageUrl, layers[], backgroundSettings?, templateMode?, productLayerSettings?}`. Seven layer types (`text, image, rectangle, badge, logo, overlay, sticker`), all sharing `x/y/width/height` as **percentages** plus `rotation/opacity/zIndex`. Text/badge content supports `{{variables}}` (title, price, etc.) resolved by `resolveVariables()`.

Two renderers exist and must be kept in sync by hand:
1. **Live editor** (`src/components/builder/canvas-preview.tsx`) — pure DOM/CSS, hand-rolled drag/resize.
2. **Server compositor** (`src/lib/compositor.ts`, `@napi-rs/canvas`) — used for thumbnails and final generation output.

"AI Product Mode" and "Smart Background" are v2 additions layered on top of the same `CanvasData` shape (optional fields, backward-compatible with older saved templates). The live editor calls the same `/api/background/remove` and `/api/image-extend` endpoints the real pipeline uses, so editor preview should visually match final output.

**`src/components/templates/*` (except `delete-template-button.tsx`) is dead code** — a superseded prior iteration of the builder, unreferenced by any route.

## 8. Rules Engine

A rule is `{rule_type, rule_operator, rule_value, priority, template_id}`. Types: `tag`, `vendor`, `product_type`, `discount` (computed from price/compare_at_price), `default` (matches everything), `catalog_import` (matches `product.import_id`). Matching (`template-resolver.ts`) is a **linear scan in `priority DESC` order, first match wins** — not most-specific-wins, and ties have no secondary sort key (DB-order-dependent). No match → `null`, and callers treat that as a silent no-op (bulk worker marks the job `completed` with an error string rather than a distinct `skipped` status). **There is no update/reorder API for rules — only create and delete.**

## 9. Generation Pipeline (end-to-end)

```
POST /api/generate/enqueue (or /api/generate/single for one product)
  → paginate matching products
  → generation-queue.enqueueGeneration()
      → insert generation_jobs rows (status=pending)  [DB is always source of truth]
      → if Redis configured: BullMQ addBulk onto "creative-generation" queue,
        payload = { jobId } only (worker re-fetches everything from the DB)
      → if Redis push fails: silently logged, job stays DB-only pending

Execution (either via BullMQ Worker in catalog-worker.ts, or the DB-poll
fallback / Vercel cron drain) converges on generation-queue.runJob():
  1. Load product + images, resolve template (job.template_id or
     template-resolver.resolveTemplateFromRules)
  2. If templateMode === 'ai_product': background-removal (4-provider
     abstraction, cached in bg_removal_cache, Cloudinary as default provider)
  3. compositor.compositeImage(): @napi-rs/canvas — draws background,
     product layer (with optional image-extend/AI-outpaint via Cloudinary
     generative fill, cached in image_extend_cache), then foreground layers
     (text/badge/logo/overlay), supersampled then downscaled to 2048px PNG
  4. cloudinary.uploadBuffer() → catalog-creatives/ folder
  5. Upsert generated_images (onConflict product_id,template_id,creative_type)
  6. Mark generation_jobs completed
```

Background removal providers: `cloudinary` (default), `clipdrop`, `removebg`, `fal-birefnet`, with configurable fallback chain (`BG_REMOVAL_FALLBACK_PROVIDERS`). Image extend = Cloudinary Generative Fill (AI outpainting) to fit a product photo to the template's aspect ratio without cropping, skipped if AR is already within 1%.

## 10. Queue & Worker Architecture

Four BullMQ queues (`queues.ts`): `creative-generation`, `product-sync`, `feed-generation`, `meta-refresh` — only the first two have real processors; the latter two are logging stubs. `catalog-worker.ts` (run via `npm run worker`, presumably under PM2 in production — no `ecosystem.config.js` is checked into this repo) runs all four BullMQ Workers **plus** a separate `dbPollTick` loop that polls `generation_jobs`/`processBatch` directly against Supabase every `DB_POLL_INTERVAL_MS` (default 3s) — explicitly because, per the code's own comment, Vercel (AWS) cannot reach the DigitalOcean Valkey instance over VPC in some deployment topologies. This means **generation jobs can be picked up by two independent code paths** in the same process; correctness is preserved by an atomic `status='pending'` claim check, but it's redundant. Vercel cron (`/api/cron/generate`, `/api/cron/sync`, daily per `vercel.json` despite a stale code comment claiming "every minute") provides a third, fully inline execution path independent of the worker.

BullMQ retry: 3 attempts, exponential backoff (5s base), no dead-letter queue. `@bull-board/express` is a declared dependency but **never wired up** — there is no queue monitoring dashboard.

## 11. Import System

- **Shopify sync**: see §6.
- **Local folder upload** (`/dashboard/upload`): the browser's directory-upload capability hands over the whole tree (nested folders included); the client classifies and de-duplicates files, downscales anything over the ~4.5 MB request-body ceiling (PNGs resized only, never JPEG-converted, so alpha survives for the background-removal path), then POSTs one image per request. Each image becomes a product with the filename minus extension as both `title` and `sku`; colliding basenames across subfolders are disambiguated by parent folder, because `(store_id, sku)` is an upsert key and would otherwise silently overwrite. Creates a brand-new store per upload.
- **Excel/CSV/"line sheet" file upload import does not exist in this codebase.** `exceljs` is an unused dependency; `xlsx` is used only for the export route.
- `jszip` is used only client-side for the "download all creatives as ZIP" button — unrelated to import.

## 12. API Structure (full route inventory)

| Route | Method(s) | Purpose |
|---|---|---|
| `/api/active-store` | POST | Set active-store cookie (ownership-checked) |
| `/api/background/remove`, `/api/background/cache` | GET/POST, GET/DELETE | Background-removal trigger + cache inspect/invalidate |
| `/api/catalog/export` | GET | XLSX/CSV export of one upload batch |
| `/api/categories` | GET/POST | Template categories |
| `/api/creatives/[creativeId]` | GET/DELETE(?) | Single creative |
| `/api/cron/generate`, `/api/cron/sync` | GET | Vercel cron entry points, `CRON_SECRET`-gated |
| `/api/upload/folder` | POST/PATCH | Open / finalise a folder-upload session (creates store + `catalog_imports` row) |
| `/api/upload/images` | POST | Multipart image(s) → Cloudinary + product + `product_images` + audit row |
| `/api/upload/status` | GET | Server-side progress for an upload session |
| `/api/upload/image` | DELETE | Remove one uploaded product + its Cloudinary asset |
| `/api/upload/retry` | POST | Reset failure accounting so the client can re-send failed images |
| `/api/feed/[storeId]` | GET | Public Meta Shopping XML feed, `feed_token`-gated |
| `/api/generate/enqueue`, `/single`, `/cancel`, `/stats` | POST/GET | Generation control plane |
| `/api/image-extend` | GET/POST | Standalone AI-extend for editor preview |
| `/api/meta/connect` | POST | Save merchant's Meta Catalog ID |
| `/api/products` | GET | Paginated/filtered product list |
| `/api/rules`, `/api/rules/[ruleId]` | GET/POST, DELETE only | Rules CRUD (no update) |
| `/api/shopify/auth`, `/finalize`, `/callback`, `/install` | GET | OAuth flows (§5) |
| `/api/stores/[storeId]/sync` | POST | Manual sync trigger |
| `/api/templates`, `/api/templates/[templateId]`, `/[templateId]/thumbnail` | GET/POST/PUT, POST | Template CRUD + thumbnail render |
| `/api/upload` | POST | Generic image upload (PNG/JPG/WEBP, 10MB cap) |
| `/api/webhooks/customers/data_request`, `/customers/redact`, `/shop/redact` | POST | Shopify GDPR mandatory webhooks |

## 13. Deployment Flow

- **App + API routes**: Vercel (serverless functions), Next.js 16.
- **Cron**: `vercel.json` — `/api/cron/sync` and `/api/cron/generate`, both daily at `0 0 * * *`.
- **Worker**: a long-running Node process (`npm run worker` → `tsx src/workers/catalog-worker.ts`), intended to run under PM2, hosted separately (comments reference DigitalOcean) because Vercel functions can't hold a persistent BullMQ connection and, per an in-code comment, can't always reach the DO-hosted Valkey over VPC — hence the DB-poll fallback loop living in the same worker process.
- **Data**: Supabase Postgres (schema managed outside this repo — no migrations checked in) + Supabase Auth.
- **Media**: Cloudinary (all AI processing outputs + final creatives + user uploads).
- **Redis/Valkey**: DigitalOcean-managed, TLS auto-detected via `rediss://` URL scheme.

## 14. Environment Variables (as referenced in code)

| Variable | Used for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase client (browser + server, RLS-scoped) |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin client, bypasses RLS (used widely — see §9 for the audit flag) |
| `SHOPIFY_CLIENT_ID`, `NEXT_PUBLIC_SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Shopify OAuth app credentials |
| `SHOPIFY_SCOPES` | Requested OAuth scopes |
| `NEXT_PUBLIC_APP_URL` | Base URL for building redirect/feed URLs |
| `CRON_SECRET` | Bearer-auth for `/api/cron/*` and internal sync calls |
| `REDIS_URL` | BullMQ/ioredis connection (TLS auto-enabled if `rediss://`) |
| `WORKER_GENERATION_CONCURRENCY`, `WORKER_SYNC_CONCURRENCY`, `DB_POLL_INTERVAL_MS` | Worker tuning |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Cloudinary SDK |
| `BG_REMOVAL_PROVIDER`, `BG_REMOVAL_FALLBACK_PROVIDERS` | Background-removal provider selection |
| `CLIPDROP_API_KEY`, `REMOVEBG_API_KEY`, `FAL_API_KEY` | Individual background-removal provider credentials |
| `NODE_ENV` | Cookie `secure` flag branching in OAuth routes |

## 15. External Services

Supabase (DB + Auth) · Cloudinary (media hosting, transforms, generative fill) · Shopify Admin GraphQL API + OAuth · Meta Commerce Manager (feed-consumer only, no API integration) · DigitalOcean Managed Redis/Valkey · Clipdrop / remove.bg / fal.ai BiRefNet (background removal) · Vercel (hosting + cron).

---

## 16. Known Limitations / Technical Debt (documented, not fixed)

Grouped by severity/theme; each item was found and cited with file:line by the subsystem audits.

**Security**
- Shopify `access_token` stored in **plaintext** in `stores.access_token` — no column encryption.
- Inconsistent cookie flags for `active_store_id` across three different set-sites (`httpOnly` true in one, false in two others; mixed `sameSite`) — could silently fail to persist depending on entry path.
- Embedded-app OAuth launch (`/api/shopify/auth`) has no replay protection (HMAC verified, but Shopify's `timestamp` param is present and never checked for staleness).
- `PUT /api/templates/[templateId]` spreads the raw request body into the update with no field allow-list — currently safe only because the client only ever sends 3 fields.
- `/api/upload` (generic editor-asset upload) allows png/jpg/webp only, while the folder-import path (`/api/upload/images`) also accepts avif — two allowlists, deliberately different, but worth collapsing if avif support is ever wanted in the editor.

**Correctness / reliability**
- DB-poll retry path (`generation-queue.ts` `failJob`) compares `attempts < max_attempts` but **`attempts` is never incremented anywhere in that file** — retry accounting is effectively broken (verify against the worker's own increment logic, if any, before relying on retry limits).
- Two independent execution paths (BullMQ Worker + `dbPollTick`) always run concurrently in the worker process regardless of whether Redis is actually reachable.
- Meta feed URL shown in the dashboard (`MetaStoreCard`) points at `/api/meta/feed/[storeId]`, which **does not exist**; the real route is `/api/feed/[storeId]` — a broken link a merchant would paste into Meta Commerce Manager.
- Settings page shows `?format=json`/`?format=csv` feed links that the feed route entirely ignores (always returns XML) — dead/misleading UI, comment suggests it's unfinished "Phase 5" work.
- No reconciliation for Shopify products deleted/archived upstream — they persist in Craftify indefinitely.
- Only `variants[0]` is synced per product — multi-variant price/inventory data is lost, with no `variants` table.
- `product_images` is fully deleted and reinserted on every sync (not diffed), non-atomically (separate HTTP calls, no transaction) — a crash mid-sync can leave a product with zero images.
- Folder upload creates a new store per upload, making its `(store_id, sku)` dedup key ineffective across repeated uploads of the same folder (inherited from the Drive import it replaced).
- Rules engine has no update/reorder API — editing a rule requires delete + recreate; `GET /api/rules` doesn't filter `is_active` while the resolver does, so the UI can show rules that aren't actually being evaluated.
- Rule priority ties have no secondary sort key (Postgres row order is unspecified) — match order can be unstable.
- `generated_images.status` is only ever written as `'completed'`, yet three separate call sites filter on it defensively — logic drift risk if a future write path ever inserts another value.
- Vercel cron schedule (daily) contradicts an in-code comment claiming "every minute"; `/api/cron/sync` has no time budget and can hit the function timeout mid-loop over many stores with no resumption logic.

**Dead code / tech debt**
- `src/components/templates/{canvas-preview,layer-properties,toolbar}.tsx` — fully superseded, unreferenced.
- `src/lib/editor-preview.ts` — its export is never called.
- `exceljs` and `@bull-board/express` are declared dependencies with zero usage in `src/`.
- `photoroom` is a declared-but-unimplemented background-removal provider (silently falls back to Cloudinary if selected).
- Duplicated HMAC-verification, `getAppOrigin`, and Shopify-domain-regex implementations across `auth/route.ts`/`callback/route.ts`/`install/route.ts`/`connect-store-form.tsx`.
- Two independent rendering engines (DOM/CSS editor vs. `@napi-rs/canvas` compositor) must be kept pixel-compatible by hand — no shared rendering core.
- Compositor's text layers do not word-wrap (canvas `fillText` only horizontally compresses overflow) — long titles render squished rather than wrapping.
- Cloudinary fonts are registered under the family name `"Inter"` but are actually Noto Sans TTFs — cosmetic mislabeling with real metric implications.

**Performance**
- Products list page uses `count: 'exact'` (full table scan cost on Postgres) plus a leading-wildcard `ilike` search that can't use the existing b-tree index.
- Image-extend's eager-generation path appears to re-upload the source image to Cloudinary a second time even after `ensureOnCloudinary` already uploaded it once per cache miss.

---

## 17. Suggested Future Improvements (not implemented, for discussion only)

- Encrypt `stores.access_token` at rest (KMS-wrapped or pgsodium).
- Add a `PATCH /api/rules/[ruleId]` endpoint and drag-to-reorder UI; make `GET /api/rules` respect `is_active` consistently with the resolver.
- Fix or remove the dead `/api/meta/feed/[storeId]` reference and the non-functional `?format=json|csv` feed links.
- Add a reconciliation step for Shopify-side deletes/archives during sync.
- Populate a real `variants` table instead of collapsing to `variants[0]`.
- Wire up `@bull-board/express` (already a dependency) for queue visibility, or remove it.
- Decide on a single generation execution path (BullMQ vs. DB-poll) per deployment rather than always running both.
- Delete the dead `src/components/templates/*` files and `src/lib/editor-preview.ts`.
- Add real word-wrap to compositor text layers.
- If a spreadsheet/line-sheet import is still a product goal, it needs to be built from scratch — `image-resolver.ts` only covers the URL-normalization half of that problem.
