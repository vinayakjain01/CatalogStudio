/**
 * @module shopify
 *
 * Shopify Admin GraphQL client used by the sync pipeline (shopify-sync.ts) to
 * pull the full product/variant/image catalog for a store.
 *
 * RESPONSIBILITIES:
 *   - createShopifyClient — builds an axios-backed GraphQL client bound to one shop + access token, exposing getShop/getProducts/getProductCount
 *   - calculateDiscount — percentage discount from a price vs. compare-at price
 *
 * DEPENDENCIES: axios (HTTP), measureAsync (perf instrumentation on the paginated product fetch).
 *
 * IMPORTANT — why GraphQL and not REST:
 * Shopify has turned off the REST Admin *product* endpoints
 * (/admin/api/.../products.json, /products/count.json, etc.) for apps created
 * after the REST deprecation cutoff. Those endpoints now return HTTP 403
 * ("Request failed with status code 403"). All product/shop reads below go
 * through the GraphQL Admin API, which is the supported path.
 *
 * v2 — FULL VARIANT SYNC. This previously requested `variants(first: 1)` and
 * flattened variant[0] onto the product, so a product with three colours synced
 * as one row and the other two were lost. Everything in v2 is addressed per
 * variant (generation, the products page, the Meta feed's
 * {store}_{product}_{variant} ids), so the whole variant set is fetched, along
 * with image dimensions and which variant each image belongs to.
 *
 * ids are still returned numeric (GIDs stripped to their trailing number) and
 * tags as a comma-separated string, matching what shopify-sync.ts expects.
 */

import axios, { AxiosInstance } from 'axios'
import { measureAsync } from '@/lib/perf'

const API_VERSION = '2026-04'

/** Shopify's default ceiling is 100 variants/product; 250 leaves headroom. */
const VARIANT_PAGE_SIZE = 250

export interface ShopifyProduct {
  id: number
  title: string
  handle: string
  vendor: string
  product_type: string
  tags: string
  status: string
  description: string
  published_at: string | null
  variants: ShopifyVariant[]
  images: ShopifyImage[]
  created_at: string
  updated_at: string
  /** Positional option names, e.g. ["Size", "Colour"] — matches product_variants.option1/2/3. */
  option_names: (string | null)[]
}

export interface ShopifyVariant {
  id: number
  title: string
  sku: string | null
  barcode: string | null
  price: string
  compare_at_price: string | null
  inventory_quantity: number
  /** 'deny' blocks purchase at zero stock; 'continue' allows overselling. */
  inventory_policy: 'deny' | 'continue'
  option1: string | null
  option2: string | null
  option3: string | null
  position: number
  weight: number | null
  weight_unit: string | null
  /** Shopify image id this variant displays, if any. */
  image_id: number | null
}

export interface ShopifyImage {
  id: number
  src: string
  alt: string | null
  position: number
  width: number | null
  height: number | null
  /** Shopify variant ids that use this image — populated during mapping. */
  variant_ids: string[]
}

export interface ShopifyShop {
  id: number
  name: string
  email: string
  domain: string
  currency: string
}

/** "gid://shopify/Product/123" -> 123 ; tolerant of plain numbers/nulls. */
function gidToId(gid: string | number | null | undefined): number {
  if (gid == null) return 0
  if (typeof gid === 'number') return gid
  const tail = gid.split('/').pop() || ''
  const n = parseInt(tail, 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Build a GraphQL Admin API client bound to one shop and access token.
 * Returns { getShop, getProducts, getProductCount } — all product/shop reads
 * go through GraphQL since Shopify has turned off the REST product endpoints
 * for apps created after the REST deprecation cutoff.
 */
export function createShopifyClient(shopDomain: string, accessToken: string) {
  const client: AxiosInstance = axios.create({
    baseURL: `https://${shopDomain}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  })

  /**
   * Run a GraphQL query with light throttle handling. Shopify returns HTTP 200
   * for GraphQL even on user errors, but 4xx (incl. 403) for auth/transport
   * issues — those still throw via axios so callers see a real failure.
   */
  async function graphql<T = any>(
    query: string,
    variables: Record<string, unknown> = {},
    attempt = 0
  ): Promise<T> {
    let data: any
    try {
      const res = await client.post('/graphql.json', { query, variables })
      data = res.data
    } catch (err: any) {
      console.error('SHOPIFY GRAPHQL HTTP ERROR')
      console.error(err.response?.status)
      console.error(err.response?.data)
      throw err
    }

    // Throttled? back off and retry a couple of times.
    const throttled = data?.errors?.some(
      (e: any) => e?.extensions?.code === 'THROTTLED'
    )
    if (throttled && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      return graphql<T>(query, variables, attempt + 1)
    }

    if (data?.errors?.length) {
      throw new Error(
        'Shopify GraphQL error: ' +
          data.errors.map((e: any) => e.message).join('; ')
      )
    }

    return data.data as T
  }

  async function getShop(): Promise<ShopifyShop> {
    const data = await graphql<{
      shop: {
        id: string
        name: string
        email: string
        currencyCode: string
        primaryDomain: { host: string }
      }
    }>(`
      query {
        shop {
          id
          name
          email
          currencyCode
          primaryDomain { host }
        }
      }
    `)

    return {
      id: gidToId(data.shop.id),
      name: data.shop.name,
      email: data.shop.email,
      domain: data.shop.primaryDomain?.host ?? shopDomain,
      currency: data.shop.currencyCode,
    }
  }

  /**
   * Map a variant's selectedOptions ([{name:'Color',value:'Red'}, …]) onto the
   * positional option1/option2/option3 columns Shopify's own data model uses.
   */
  function optionsToPositional(selected: any[]): [string | null, string | null, string | null] {
    const values = (selected ?? []).map(o => o?.value ?? null)
    return [values[0] ?? null, values[1] ?? null, values[2] ?? null]
  }

  async function getProducts(
    options: { sinceId?: string; updatedAtMin?: string } | string = {}
  ): Promise<ShopifyProduct[]> {
    const updatedAtMin =
      typeof options === 'string' ? undefined : options.updatedAtMin

    // v2 syncs EVERY status — the products list filters by status itself, and a
    // draft product still needs a creative before it goes live. Previously this
    // hard-filtered status:active, so drafts were invisible to the app.
    const filters: string[] = []
    if (updatedAtMin) filters.push(`updated_at:>='${updatedAtMin}'`)
    const searchQuery = filters.length ? filters.join(' ') : null

    const QUERY = `
      query Products($cursor: String, $q: String) {
        products(first: 100, after: $cursor, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            vendor
            productType
            tags
            status
            description
            publishedAt
            createdAt
            updatedAt
            options { name }
            images(first: 250) {
              nodes { id url altText width height }
            }
            variants(first: ${VARIANT_PAGE_SIZE}) {
              pageInfo { hasNextPage }
              nodes {
                id
                title
                sku
                barcode
                price
                compareAtPrice
                inventoryQuantity
                inventoryPolicy
                position
                selectedOptions { name value }
                image { id }
                inventoryItem {
                  measurement { weight { unit value } }
                }
              }
            }
          }
        }
      }
    `

    const all: ShopifyProduct[] = []
    let cursor: string | null = null

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
          nodes: any[]
        }
      } = await measureAsync(
        'shopify.products.page_fetch',
        () =>
          graphql<{
            products: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
              nodes: any[]
            }
          }>(QUERY, { cursor, q: searchQuery }),
        { cursor }
      )

      for (const node of data.products.nodes) {
        const variantNodes = node.variants?.nodes ?? []

        // Never silently truncate a catalog: a product past the page size would
        // lose variants, and the loss would only surface as missing creatives.
        if (node.variants?.pageInfo?.hasNextPage) {
          console.warn(
            `[shopify] product ${node.title} has more than ${VARIANT_PAGE_SIZE} variants — extras not synced`
          )
        }

        const variants: ShopifyVariant[] = variantNodes.map((v: any, idx: number) => {
          const [option1, option2, option3] = optionsToPositional(v.selectedOptions)
          const weight = v.inventoryItem?.measurement?.weight
          return {
            id: gidToId(v.id),
            title: v.title ?? '',
            sku: v.sku || null,
            barcode: v.barcode || null,
            price: v.price ?? '0',
            compare_at_price: v.compareAtPrice ?? null,
            inventory_quantity: v.inventoryQuantity ?? 0,
            // Shopify returns the enum uppercase (DENY / CONTINUE).
            inventory_policy: String(v.inventoryPolicy ?? 'DENY').toLowerCase() === 'continue'
              ? 'continue'
              : 'deny',
            option1,
            option2,
            option3,
            position: v.position ?? idx + 1,
            weight: weight?.value ?? null,
            weight_unit: weight?.unit ?? null,
            image_id: v.image?.id ? gidToId(v.image.id) : null,
          }
        })

        // Invert variant -> image into image -> variants, which is the direction
        // the products page and the feed actually query.
        const variantIdsByImage = new Map<number, string[]>()
        for (const v of variants) {
          if (v.image_id == null) continue
          const list = variantIdsByImage.get(v.image_id) ?? []
          list.push(String(v.id))
          variantIdsByImage.set(v.image_id, list)
        }

        all.push({
          id: gidToId(node.id),
          title: node.title,
          handle: node.handle,
          vendor: node.vendor ?? '',
          product_type: node.productType ?? '',
          tags: Array.isArray(node.tags) ? node.tags.join(', ') : node.tags ?? '',
          status: (node.status ?? '').toLowerCase(),
          description: node.description ?? '',
          published_at: node.publishedAt ?? null,
          created_at: node.createdAt,
          updated_at: node.updatedAt,
          option_names: [0, 1, 2].map(i => (node.options?.[i]?.name as string | undefined) ?? null),
          variants,
          images: (node.images?.nodes ?? []).map((img: any, idx: number) => {
            const imageId = gidToId(img.id)
            return {
              id: imageId,
              src: img.url,
              alt: img.altText ?? null,
              position: idx + 1,
              width: img.width ?? null,
              height: img.height ?? null,
              variant_ids: variantIdsByImage.get(imageId) ?? [],
            }
          }),
        })
      }

      if (data.products.pageInfo.hasNextPage) {
        cursor = data.products.pageInfo.endCursor
      } else {
        break
      }
    }

    return all
  }

  async function getProductCount(): Promise<number> {
    const data = await graphql<{ productsCount: { count: number } }>(`
      query {
        productsCount { count }
      }
    `)
    return data.productsCount?.count ?? 0
  }

  return { getShop, getProducts, getProductCount }
}

/**
 * Percentage discount of price vs. compareAtPrice, rounded to the nearest
 * whole percent. Returns 0 when there's no compare-at price or it isn't
 * actually higher than price (no discount to show).
 */
export function calculateDiscount(
  price: string,
  compareAtPrice: string | null
): number {
  if (!compareAtPrice) return 0
  const p = parseFloat(price)
  const c = parseFloat(compareAtPrice)
  if (c <= 0 || p >= c) return 0
  return Math.round(((c - p) / c) * 100)
}
