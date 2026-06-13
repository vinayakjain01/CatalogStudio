import axios from 'axios'

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

export function createShopifyClient(shopDomain: string, accessToken: string) {
  const baseURL = `https://${shopDomain}/admin/api/2025-04`

  const client = axios.create({
    baseURL,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  })

  async function getShop(): Promise<ShopifyShop> {
    const { data } = await client.get('/shop.json')
    return data.shop
  }

  async function getProducts(sinceId?: string): Promise<ShopifyProduct[]> {
    const allProducts: ShopifyProduct[] = []
    let url = '/products.json?limit=250&status=active'
    if (sinceId) url += `&since_id=${sinceId}`

    while (url) {
      const { data, headers } = await client.get(url)
      allProducts.push(...data.products)

      // Handle pagination via Link header
      const linkHeader = headers['link']
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
        if (match) {
          // Extract just the path+query from the full URL
          const nextUrl = new URL(match[1])
          url = nextUrl.pathname.replace('/admin/api/2024-01', '') + nextUrl.search
        } else {
          url = ''
        }
      } else {
        url = ''
      }
    }

    return allProducts
  }

  async function getProductCount(): Promise<number> {
    const { data } = await client.get('/products/count.json?status=active')
    return data.count
  }

  return { getShop, getProducts, getProductCount }
}

export function calculateDiscount(price: string, compareAtPrice: string | null): number {
  if (!compareAtPrice) return 0
  const p = parseFloat(price)
  const c = parseFloat(compareAtPrice)
  if (c <= 0 || p >= c) return 0
  return Math.round(((c - p) / c) * 100)
}