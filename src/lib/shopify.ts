import axios, { AxiosInstance } from 'axios'
import { measureAsync } from '@/lib/perf'

/**
 * Shopify Admin client.
 *
 * IMPORTANT — why GraphQL and not REST:
 * Shopify has turned off the REST Admin *product* endpoints
 * (/admin/api/.../products.json, /products/count.json, etc.) for apps created
 * after the REST deprecation cutoff. Those endpoints now return HTTP 403
 * ("Request failed with status code 403"). All product/shop reads below go
 * through the GraphQL Admin API, which is the supported path.
 *
 * The public shape (ShopifyProduct / ShopifyVariant / ShopifyImage / ShopifyShop)
 * is kept identical to the old REST shape so that shopify-sync.ts and every other
 * caller keep working unchanged:
 *   - ids are numeric (GIDs are stripped to their trailing number)
 *   - tags is a comma-separated string
 *   - status is lowercase ("active" | "draft" | "archived")
 *   - variant.price / compare_at_price are strings
 *   - images have { id, src, alt, position }
 */

const API_VERSION = '2026-04'

export interface ShopifyProduct {
  id: number
  title: string
  handle: string
  vendor: string
  product_type: string
  tags: string
  status: string
  variants: ShopifyVariant[]
  images: ShopifyImage[]
  created_at: string
  updated_at: string
}

export interface ShopifyVariant {
  id: number
  price: string
  compare_at_price: string | null
  inventory_quantity: number
}

export interface ShopifyImage {
  id: number
  src: string
  alt: string | null
  position: number
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

  async function getProducts(
    options: { sinceId?: string; updatedAtMin?: string } | string = {}
  ): Promise<ShopifyProduct[]> {
    const updatedAtMin =
      typeof options === 'string' ? undefined : options.updatedAtMin

    // Build the Shopify search query string (same semantics as the old
    // ?status=active&updated_at_min=... REST params).
    const filters = ['status:active']
    if (updatedAtMin) filters.push(`updated_at:>='${updatedAtMin}'`)
    const searchQuery = filters.join(' ')

    const QUERY = `
      query Products($cursor: String, $q: String) {
        products(first: 250, after: $cursor, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            vendor
            productType
            tags
            status
            createdAt
            updatedAt
            variants(first: 1) {
              nodes {
                id
                price
                compareAtPrice
                inventoryQuantity
              }
            }
            images(first: 250) {
              nodes { id url altText }
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
        all.push({
          id: gidToId(node.id),
          title: node.title,
          handle: node.handle,
          vendor: node.vendor ?? '',
          product_type: node.productType ?? '',
          tags: Array.isArray(node.tags) ? node.tags.join(', ') : node.tags ?? '',
          status: (node.status ?? '').toLowerCase(),
          created_at: node.createdAt,
          updated_at: node.updatedAt,
          variants: (node.variants?.nodes ?? []).map((v: any) => ({
            id: gidToId(v.id),
            price: v.price ?? '0',
            compare_at_price: v.compareAtPrice ?? null,
            inventory_quantity: v.inventoryQuantity ?? 0,
          })),
          images: (node.images?.nodes ?? []).map((img: any, idx: number) => ({
            id: gidToId(img.id),
            src: img.url,
            alt: img.altText ?? null,
            position: idx + 1,
          })),
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
        productsCount(query: "status:active") { count }
      }
    `)
    return data.productsCount?.count ?? 0
  }

  return { getShop, getProducts, getProductCount }
}

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