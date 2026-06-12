import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'

function getAdminClient() {
  return createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
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

interface Rule {
  id: string
  rule_type: string
  rule_operator: string
  rule_value: string
  priority: number
  template_id: string
}

export async function resolveTemplateForProduct(
  product: Product,
  storeId: string
): Promise<string | null> {
  const supabase = getAdminClient()

  const { data: rules } = await supabase
    .from('template_rules')
    .select('*')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .order('priority', { ascending: false })

  if (!rules || rules.length === 0) return null

  const discount =
    product.compare_at_price && product.compare_at_price > product.price
      ? Math.round(((product.compare_at_price - product.price) / product.compare_at_price) * 100)
      : 0

  for (const rule of rules) {
    const { rule_type, rule_operator, rule_value } = rule

    if (rule_type === 'default') return rule.template_id

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