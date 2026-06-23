# Performance Infrastructure

This upgrade keeps Vercel as the frontend/API host and keeps Supabase and Cloudinary as the system of record. Redis/BullMQ is optional but recommended for production workers.

## Runtime Layout

- Vercel: Next.js app, dashboard, API routes, authenticated user workflows.
- Supabase: Postgres data, auth, existing queue table fallback.
- Cloudinary: generated creative masters and delivery transformations.
- Redis: BullMQ dispatch for background work.
- DigitalOcean Droplet: long-running workers via `npm run worker`.

## Required Environment

Set these on the worker host:

```bash
REDIS_URL=redis://...
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
WORKER_GENERATION_CONCURRENCY=4
WORKER_SYNC_CONCURRENCY=1
```

Keep the existing Vercel env vars. If `REDIS_URL` is absent, generation still uses the Supabase `generation_jobs` queue drained by `/api/cron/generate`.

## Deploy Steps

1. Run `npm install` on Vercel and the worker host.
2. Apply `supabase/performance-indexes.sql` in Supabase SQL editor.
3. Deploy the Next.js app to Vercel.
4. On the Droplet, run `npm run worker` under a process manager such as systemd or pm2.
5. Keep Vercel cron enabled for `/api/cron/generate` as a fallback.

## Metrics

Performance logs emit JSON lines with the `[perf]` prefix for:

- `shopify.products.page_fetch`
- `shopify.products.fetch_all`
- `shopify.sync.total`
- `creative.render.asset_preload`
- `creative.render.png_encode`
- `creative.render.total`
- `cloudinary.upload.stream`
- `queue.generation.*`
- `supabase.*`
- `worker.*`
