-- Performance-only indexes for large catalogs.
-- These do not change table structure, API contracts, RLS, or business logic.

create index if not exists idx_products_store_status_updated
  on public.products (store_id, status, updated_at desc);

create index if not exists idx_products_store_shopify
  on public.products (store_id, shopify_id);

create index if not exists idx_products_store_vendor
  on public.products (store_id, vendor);

create index if not exists idx_products_store_product_type
  on public.products (store_id, product_type);

create index if not exists idx_products_tags_gin
  on public.products using gin (tags);

create index if not exists idx_product_images_product_primary
  on public.product_images (product_id, is_primary);

create index if not exists idx_generated_images_product_status_updated
  on public.generated_images (product_id, status, updated_at desc);

create index if not exists idx_generated_images_template_type
  on public.generated_images (template_id, creative_type);

create index if not exists idx_generation_jobs_status_locked_created
  on public.generation_jobs (status, locked_at, created_at);

create index if not exists idx_generation_jobs_store_status
  on public.generation_jobs (store_id, status);

create index if not exists idx_generation_jobs_batch
  on public.generation_jobs (batch_id);

create index if not exists idx_templates_store_created
  on public.templates (store_id, created_at desc);

create index if not exists idx_template_rules_store_active_priority
  on public.template_rules (store_id, is_active, priority desc);

create index if not exists idx_sync_logs_store_created
  on public.sync_logs (store_id, created_at desc);
