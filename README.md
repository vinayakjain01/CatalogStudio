# Craftify

Shopify catalog creative automation — sync products & variants, design
templates, map them to products with rules, bulk-generate creatives, and
publish a variant-level Meta Shopping feed.

**New to this repo? Read [`docs/PROJECT_ARCHITECTURE.md`](docs/PROJECT_ARCHITECTURE.md) first.**
It's a full handoff doc — deployment topology, schema, the generation
pipeline, migration history, and a list of mistakes already made once so
they aren't repeated. This README is just a quick start.

## Quick start

```bash
npm install
npm run dev          # Next.js app — http://localhost:3000
npm run worker        # separate process: BullMQ + DB-poll generation/sync worker
```

You'll need a `.env.local` (gitignored) with Supabase, Cloudinary, and
Shopify credentials — ask whoever holds them, or check the deployed Vercel
project's environment variables.

## Deploying

This app has **three independently-deployed pieces** — pushing to `main`
only updates one of them. See
[§2 of the architecture doc](docs/PROJECT_ARCHITECTURE.md#2-deployment-topology--read-this-first)
before assuming a code push is "live":

1. **Vercel** (the Next.js app) — auto-deploys on push to `main`.
2. **The worker** (DigitalOcean droplet) — deploys manually
   (`git pull && npm install && pm2 restart all` on the box).
3. **Supabase migrations** (`supabase/*.sql`) — no migration runner exists;
   each file is pasted into the Supabase SQL Editor by hand, in numeric
   order, **before** deploying code that depends on it.

## Stack

Next.js 16 (App Router) · TypeScript · Supabase (Postgres + Auth) ·
Cloudinary · BullMQ/Redis · Shopify Admin GraphQL API · `@napi-rs/canvas` ·
shadcn/ui + Tailwind v4.

## Repo layout

See [§11 of the architecture doc](docs/PROJECT_ARCHITECTURE.md#11-folder-guide)
for the annotated folder-by-folder guide.
