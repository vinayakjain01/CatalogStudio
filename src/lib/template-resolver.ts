/**
 * @module template-resolver
 *
 * Rules engine: product (+ variant) → template.
 *
 * RESPONSIBILITIES:
 *   - getActiveTemplateRules — load a store's active rules, priority-ordered (ascending; lower number wins)
 *   - resolveTemplateForProduct — load rules and resolve the first matching template for one product/variant
 *   - evaluateCondition — evaluate a single v2 condition against a product/variant
 *   - ruleMatches — evaluate a full rule (v2 multi-condition, or legacy single-condition fallback)
 *   - resolveTemplateFromRules — first-match-wins template id for a product/variant against an already-loaded rule list
 *   - matchingRules — every rule that would match, in priority order (rule-editor preview)
 *
 * NOTE ON PLACEMENTS (asset_type): a template's own asset_type column is a
 * builder convenience only — it seeds the canvas to that placement's aspect
 * ratio when the template is created, nothing more. Which placement(s) get
 * generated is chosen per generation request (the Creatives page's "Generate
 * for" picker), NOT by matching a job's asset_type against a template's. Rule
 * resolution here is asset-type-agnostic: one template, matched by its rule as
 * usual, renders every placement the merchant asked for (see
 * ASSET_TYPE_CONFIG-driven canvas overrides in generation-queue.ts).
 *
 * v2 — MULTI-CONDITION RULES. A rule used to be a single
 * (rule_type, rule_operator, rule_value) triple, so "vendor is Saundh AND
 * product_type is Kaftan" could not be expressed at all. A rule now carries an
 * array of conditions combined with AND or OR.
 *
 * Legacy single-condition rows are still evaluated, so rules written before the
 * migration keep resolving until they are re-saved in the new format.
 *
 * PRIORITY DIRECTION CHANGED: the v2 spec defines "lower number = higher
 * priority", the opposite of the previous `order by priority desc`. Rules are
 * now walked ascending. If you kept pre-v2 rules instead of wiping them, their
 * relative order has inverted and needs checking.
 */
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

export type RuleField =
  | 'collection' | 'product_type' | 'vendor' | 'tag' | 'title_contains'
  | 'price_min' | 'price_max' | 'sku_prefix' | 'all_products'

export type RuleOperator =
  | 'is' | 'is_not' | 'contains' | 'starts_with' | 'greater_than' | 'less_than'

export interface RuleCondition {
  field: RuleField
  operator: RuleOperator
  value: string
}

export interface TemplateRule {
  id: string
  template_id: string
  priority: number
  conditions?: RuleCondition[] | null
  condition_mode?: 'all' | 'any' | null
  /** Legacy single-condition columns — still honoured when conditions is empty. */
  rule_type?: string | null
  rule_operator?: string | null
  rule_value?: string | null
  created_at?: string | null
}

/** Everything a rule can be evaluated against. */
export interface RuleProduct {
  id: string
  title?: string | null
  tags?: string[] | null
  vendor?: string | null
  product_type?: string | null
  collection?: string | null
  sku?: string | null
  price?: number | null
  compare_at_price?: number | null
  import_id?: string | null
}

/** Variant overrides for price/sku when resolving per variant. */
export interface RuleVariant {
  price?: number | null
  compare_at_price?: number | null
  sku?: string | null
}

/**
 * Load a store's active rules ordered by priority ascending (v2 semantics:
 * lower priority number wins), with created_at as a deterministic tie-break
 * for rules sharing a priority.
 */
export async function getActiveTemplateRules(storeId: string): Promise<TemplateRule[]> {
  const supabase = getAdminClient()

  const { data: rules } = await supabase
    .from('template_rules')
    .select('*')
    .eq('store_id', storeId)
    .eq('is_active', true)
    // Lower priority number wins (v2 semantics). created_at is a deterministic
    // tie-break — Postgres row order is otherwise unspecified, which made two
    // rules at the same priority match unpredictably between runs.
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })

  return rules ?? []
}

/**
 * Load a store's active rules and resolve the first matching template id for
 * one product (+ optional variant). Convenience wrapper combining
 * getActiveTemplateRules + resolveTemplateFromRules for a single lookup.
 */
export async function resolveTemplateForProduct(
  product: RuleProduct,
  storeId: string,
  variant?: RuleVariant
): Promise<string | null> {
  const rules = await getActiveTemplateRules(storeId)
  return resolveTemplateFromRules(product, rules, variant)
}

const lower = (v: unknown) => String(v ?? '').toLowerCase().trim()

/** Compare two strings under a text operator. */
function textMatches(actual: string, operator: RuleOperator, expected: string): boolean {
  const a = lower(actual)
  const e = lower(expected)
  switch (operator) {
    case 'is':          return a === e
    case 'is_not':      return a !== e
    case 'starts_with': return a.startsWith(e)
    case 'contains':
    default:            return a.includes(e)
  }
}

/**
 * Evaluate one condition.
 *
 * Some fields carry their own comparison semantics regardless of the operator
 * chosen in the UI (`price_min` is always a floor, `sku_prefix` always a
 * prefix), which keeps a mis-set operator from silently inverting a rule.
 */
export function evaluateCondition(
  condition: RuleCondition,
  product: RuleProduct,
  variant?: RuleVariant
): boolean {
  const { field, operator, value } = condition
  const price = Number(variant?.price ?? product.price ?? 0)
  const sku = variant?.sku ?? product.sku ?? ''

  switch (field) {
    case 'all_products':
      return true

    case 'tag': {
      const tags = product.tags ?? []
      // is_not must hold for EVERY tag, not merely fail to find one match.
      if (operator === 'is_not') return !tags.some(t => lower(t) === lower(value))
      return tags.some(t => textMatches(t, operator, value))
    }

    case 'vendor':        return textMatches(product.vendor ?? '', operator, value)
    case 'product_type':  return textMatches(product.product_type ?? '', operator, value)
    case 'collection':    return textMatches(product.collection ?? '', operator, value)
    case 'title_contains':return textMatches(product.title ?? '', 'contains', value)
    case 'sku_prefix':    return textMatches(sku, 'starts_with', value)

    case 'price_min': {
      const threshold = parseFloat(value)
      return Number.isFinite(threshold) && price >= threshold
    }
    case 'price_max': {
      const threshold = parseFloat(value)
      return Number.isFinite(threshold) && price <= threshold
    }

    default:
      return false
  }
}

/** Legacy (pre-v2) single-condition evaluation. */
function evaluateLegacyRule(rule: TemplateRule, product: RuleProduct, variant?: RuleVariant): boolean {
  const type = rule.rule_type ?? ''
  const op = rule.rule_operator ?? 'equals'
  const value = rule.rule_value ?? ''
  const price = Number(variant?.price ?? product.price ?? 0)
  const compareAt = Number(variant?.compare_at_price ?? product.compare_at_price ?? 0)
  const discount = compareAt > price ? Math.round(((compareAt - price) / compareAt) * 100) : 0
  const eq = op === 'equals'

  switch (type) {
    case 'default':        return true
    case 'catalog_import': return product.import_id === value
    case 'tag':
      return (product.tags ?? []).some(t =>
        eq ? lower(t) === lower(value) : lower(t).includes(lower(value)))
    case 'vendor':
      return Boolean(product.vendor) &&
        (eq ? lower(product.vendor) === lower(value) : lower(product.vendor).includes(lower(value)))
    case 'product_type':
      return Boolean(product.product_type) &&
        (eq ? lower(product.product_type) === lower(value) : lower(product.product_type).includes(lower(value)))
    case 'discount': {
      const threshold = parseFloat(value)
      if (!Number.isFinite(threshold)) return false
      if (op === 'greater_than') return discount > threshold
      if (op === 'less_than') return discount < threshold
      return discount === threshold
    }
    default:
      return false
  }
}

/** Does this rule match? First-match-wins is applied by the caller. */
export function ruleMatches(
  rule: TemplateRule,
  product: RuleProduct,
  variant?: RuleVariant
): boolean {
  const conditions = rule.conditions ?? []

  // No v2 conditions — fall back to the legacy columns.
  if (conditions.length === 0) {
    if (rule.rule_type) return evaluateLegacyRule(rule, product, variant)
    // A rule with neither conditions nor a legacy type matches nothing. Treating
    // it as a catch-all would silently apply an unconfigured rule to the catalog.
    return false
  }

  return rule.condition_mode === 'any'
    ? conditions.some(c => evaluateCondition(c, product, variant))
    : conditions.every(c => evaluateCondition(c, product, variant))
}

/**
 * First-match-wins template id for a product (+ optional variant) against an
 * already-loaded, priority-ordered rule list. Returns null if no rule matches.
 */
export function resolveTemplateFromRules(
  product: RuleProduct,
  rules: TemplateRule[],
  variant?: RuleVariant
): string | null {
  for (const rule of rules) {
    if (rule.template_id && ruleMatches(rule, product, variant)) return rule.template_id
  }
  return null
}

/**
 * Rules that would match, in priority order — powers the rule editor's
 * "preview matched products" without duplicating the matching logic.
 */
export function matchingRules(
  product: RuleProduct,
  rules: TemplateRule[],
  variant?: RuleVariant
): TemplateRule[] {
  return rules.filter(rule => ruleMatches(rule, product, variant))
}
