import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
// Node.js 20 has no native WebSocket global — must pass ws explicitly
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws') as any

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      realtime: { transport: ws },
    }
  )
}

interface Product {
  id: string
  tags: string[]
  vendor: string | null
  product_type: string | null
  price: number
  compare_at_price: number | null
}

export interface TemplateRule {
  id: string
  rule_type: string
  rule_operator: string
  rule_value: string
  priority: number
  template_id: string
}

export async function getActiveTemplateRules(storeId: string): Promise<TemplateRule[]> {
  const supabase = getAdminClient()

  const { data: rules } = await supabase
    .from('template_rules')
    .select('*')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .order('priority', { ascending: false })

  return rules || []
}

export async function resolveTemplateForProduct(
  product: Product,
  storeId: string
): Promise<string | null> {
  const rules = await getActiveTemplateRules(storeId)
  return resolveTemplateFromRules(product, rules)
}

export function resolveTemplateFromRules(
  product: Product,
  rules: TemplateRule[]
): string | null {
  if (rules.length === 0) return null
  const discount =
    product.compare_at_price && product.compare_at_price > product.price
      ? Math.round(((product.compare_at_price - product.price) / product.compare_at_price) * 100)
      : 0

  for (const rule of rules) {
    const { rule_type, rule_operator, rule_value } = rule

    if (rule_type === 'default') return rule.template_id

    // catalog_import: applies to all products from a specific import
    // rule_value = import_id. product must have import_id set.
    if (rule_type === 'catalog_import') {
      if ((product as any).import_id === rule_value) return rule.template_id
    }

    if (rule_type === 'tag') {
      const tagLower = rule_value.toLowerCase()
      const match = product.tags.some(t => {
        const tl = t.toLowerCase()
        return rule_operator === 'equals' ? tl === tagLower : tl.includes(tagLower)
      })
      if (match) return rule.template_id
    }

    if (rule_type === 'vendor' && product.vendor) {
      const vl = product.vendor.toLowerCase()
      const rv = rule_value.toLowerCase()
      if (rule_operator === 'equals' ? vl === rv : vl.includes(rv)) return rule.template_id
    }

    if (rule_type === 'product_type' && product.product_type) {
      const pl = product.product_type.toLowerCase()
      const rv = rule_value.toLowerCase()
      if (rule_operator === 'equals' ? pl === rv : pl.includes(rv)) return rule.template_id
    }

    if (rule_type === 'discount') {
      const threshold = parseFloat(rule_value)
      if (
        (rule_operator === 'greater_than' && discount > threshold) ||
        (rule_operator === 'less_than' && discount < threshold) ||
        (rule_operator === 'equals' && discount === threshold)
      ) return rule.template_id
    }
  }

  return null
}