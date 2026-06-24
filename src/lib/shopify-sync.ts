import { SupabaseClient } from '@supabase/supabase-js'
import { chunkArray } from '@/lib/concurrency'
import { logPerf, measureAsync } from '@/lib/perf'
import { createShopifyClient, ShopifyProduct } from '@/lib/shopify'
import { enqueueGeneration } from '@/lib/generation-queue'

type StoreRow = {
  id: string
  shop_domain: string
  access_token: string
  last_synced_at?: string | null
}

type SyncOptions = {
  storeId: string
  syncType: 'manual' | 'cron'
  autoEnqueueChanged?: boolean
  incremental?: boolean
  supabase: SupabaseClient
}

type ExistingProduct = {
  id: string
  shopify_id: string
  price: number
  compare_at_price: number | null
  tags: string[] | null
  vendor: string | null
  product_type: string | null
}

const PRODUCT_BATCH_SIZE = 100
const IMAGE_BATCH_SIZE = 100

export async function syncStoreProducts({
  storeId,
  syncType,
  autoEnqueueChanged = false,
  incremental = false,
  supabase,
}: SyncOptions): Promise<number> {
  const started = Date.now()
  const { data: store, error: storeError } = await supabase
    .from('stores')
    .select('*')
    .eq('id', storeId)
    .single()

  if (storeError || !store) throw new Error('Store not found')

  const { data: syncLog } = await supabase
    .from('sync_logs')
    .insert({ store_id: storeId, sync_type: syncType, status: 'running' })
    .select()
    .single()

  try {
    const synced = await syncProducts(store as StoreRow, {
      supabase,
      autoEnqueueChanged,
      incremental,
    })

    await supabase
      .from('stores')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', storeId)

    await supabase
      .from('sync_logs')
      .update({
        status: 'completed',
        products_synced: synced,
        completed_at: new Date().toISOString(),
      })
      .eq('id', syncLog?.id)

    logPerf('shopify.sync.total', Date.now() - started, {
      storeId,
      syncType,
      products: synced,
    })

    return synced
  } catch (err: any) {
    // A 403/401 means the stored token is invalid/expired (Shopify's
    // non-expiring-token deprecation). Flag the store so the UI prompts a
    // reconnect instead of silently failing every sync.
    const msg = String(err?.message || '')
    const isAuthError = msg.includes('403') || msg.includes('401') ||
      msg.toLowerCase().includes('access token')
    if (isAuthError) {
      await supabase
        .from('stores')
        .update({ needs_reauth: true })
        .eq('id', storeId)
    }

    await supabase
      .from('sync_logs')
      .update({
        status: 'failed',
        error_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', syncLog?.id)
    throw err
  }
}

async function syncProducts(
  store: StoreRow,
  {
    supabase,
    autoEnqueueChanged,
    incremental,
  }: {
    supabase: SupabaseClient
    autoEnqueueChanged: boolean
    incremental: boolean
  }
) {
  const shopify = createShopifyClient(store.shop_domain, store.access_token)
  const shopifyProducts = await measureAsync(
    'shopify.products.fetch_all',
    () => shopify.getProducts({
      updatedAtMin: incremental ? store.last_synced_at || undefined : undefined,
    }),
    { storeId: store.id, incremental }
  )

  console.log('Products fetched:', shopifyProducts.length, 'Store:', store.shop_domain)
  if (shopifyProducts.length === 0) return 0

  const existingByShopifyId = await loadExistingProducts(
    supabase,
    store.id,
    shopifyProducts.map(product => product.id.toString())
  )

  const productRows = shopifyProducts.map(sp => toProductRow(store.id, sp))
  const productIdByShopifyId = new Map<string, string>()
  const changedProductIds: string[] = []

  for (const batch of chunkArray(productRows, PRODUCT_BATCH_SIZE)) {
    const { data, error } = await measureAsync(
      'supabase.products.batch_upsert',
      () => supabase
        .from('products')
        .upsert(batch, { onConflict: 'store_id,shopify_id' })
        .select('id, shopify_id'),
      { rows: batch.length, storeId: store.id }
    )
    if (error) throw new Error(error.message)

    for (const product of data || []) {
      productIdByShopifyId.set((product as any).shopify_id, (product as any).id)
    }
  }

  for (const row of productRows) {
    const productId = productIdByShopifyId.get(row.shopify_id)
    if (!productId) continue

    const existing = existingByShopifyId.get(row.shopify_id)
    if (!existing || productChanged(existing, row)) {
      changedProductIds.push(productId)
    }
  }

  await replaceProductImages(supabase, productIdByShopifyId, shopifyProducts)

  if (autoEnqueueChanged && changedProductIds.length > 0) {
    try {
      await enqueueGeneration({ storeId: store.id, productIds: changedProductIds }, supabase)
    } catch (err) {
      console.error('auto-enqueue failed:', err)
    }
  }

  return productRows.length
}

async function loadExistingProducts(
  supabase: SupabaseClient,
  storeId: string,
  shopifyIds: string[]
) {
  const existingByShopifyId = new Map<string, ExistingProduct>()

  for (const ids of chunkArray(shopifyIds, 1000)) {
    const { data, error } = await measureAsync(
      'supabase.products.existing_lookup',
      () => supabase
        .from('products')
        .select('id, shopify_id, price, compare_at_price, tags, vendor, product_type')
        .eq('store_id', storeId)
        .in('shopify_id', ids),
      { rows: ids.length, storeId }
    )
    if (error) throw new Error(error.message)
    for (const row of data || []) {
      existingByShopifyId.set((row as ExistingProduct).shopify_id, row as ExistingProduct)
    }
  }

  return existingByShopifyId
}

function toProductRow(storeId: string, sp: ShopifyProduct) {
  const primaryVariant = sp.variants[0]
  const price = primaryVariant ? parseFloat(primaryVariant.price) : 0
  const compareAtPrice = primaryVariant?.compare_at_price
    ? parseFloat(primaryVariant.compare_at_price)
    : null
  const tags = sp.tags
    ? sp.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
    : []

  return {
    store_id: storeId,
    shopify_id: sp.id.toString(),
    title: sp.title,
    handle: sp.handle,
    vendor: sp.vendor || null,
    product_type: sp.product_type || null,
    tags,
    price,
    compare_at_price: compareAtPrice,
    inventory_quantity: primaryVariant?.inventory_quantity || 0,
    status: sp.status,
    updated_at: new Date().toISOString(),
  }
}

function productChanged(existing: ExistingProduct, next: ReturnType<typeof toProductRow>) {
  return fingerprint(existing) !== fingerprint(next)
}

function fingerprint(value: {
  price: number
  compare_at_price: number | null
  tags: string[] | null
  vendor: string | null
  product_type: string | null
}) {
  return JSON.stringify([
    value.price,
    value.compare_at_price,
    [...(value.tags || [])].sort(),
    value.vendor,
    value.product_type,
  ])
}

async function replaceProductImages(
  supabase: SupabaseClient,
  productIdByShopifyId: Map<string, string>,
  shopifyProducts: ShopifyProduct[]
) {
  const imageRows = []
  const productIdsWithImages: string[] = []

  for (const sp of shopifyProducts) {
    const productId = productIdByShopifyId.get(sp.id.toString())
    if (!productId || !sp.images?.length) continue

    productIdsWithImages.push(productId)
    for (const [idx, img] of sp.images.entries()) {
      imageRows.push({
        product_id: productId,
        shopify_image_id: img.id.toString(),
        src: img.src,
        alt: img.alt || null,
        position: img.position || idx,
        is_primary: idx === 0,
      })
    }
  }

  for (const productIds of chunkArray(productIdsWithImages, IMAGE_BATCH_SIZE)) {
    const { error } = await measureAsync(
      'supabase.product_images.batch_delete',
      () => supabase.from('product_images').delete().in('product_id', productIds),
      { rows: productIds.length }
    )
    if (error) throw new Error(error.message)
  }

  for (const batch of chunkArray(imageRows, 1000)) {
    const { error } = await measureAsync(
      'supabase.product_images.batch_insert',
      () => supabase.from('product_images').insert(batch),
      { rows: batch.length }
    )
    if (error) throw new Error(error.message)
  }
}