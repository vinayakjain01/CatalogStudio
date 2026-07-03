/**
 * Column Auto-Mapper
 *
 * Real customer line sheets are wildly inconsistent. This module maps any
 * column name variant to a canonical internal field name.
 *
 * Strategy:
 *  1. Exact match (case-insensitive)
 *  2. Normalized match (strip spaces, underscores, dashes, lowercase)
 *  3. Keyword match (does the column name contain a known keyword?)
 *  4. Score the best match per canonical field
 *
 * Returns a map: { detected_column_name: canonical_field_name }
 */

export type CanonicalField =
  | 'sku'
  | 'title'
  | 'description'
  | 'price'
  | 'compare_at_price'
  | 'image_url'
  | 'vendor'
  | 'product_type'
  | 'tags'
  | 'inventory_quantity'
  | 'status'
  | 'color'

// Ordered by priority — first match wins for each canonical field
const FIELD_SYNONYMS: Record<CanonicalField, string[]> = {
  sku: [
    'sku', 'product sku', 'vendor sku', 'vendor code', 'item code',
    'product code', 'style number', 'style no', 'reference code', 'ref code',
    'article no', 'article number', 'barcode', 'model number', 'item no',
    'part number', 'product id', 'productid', 'id',
  ],
  title: [
    'title', 'name', 'product name', 'product title', 'style name',
    'item name', 'description short', 'short description', 'item description',
    'collection name', 'product', 'item',
  ],
  description: [
    'description', 'product description', 'long description', 'details',
    'full description', 'detail', 'about', 'notes',
  ],
  price: [
    'price', 'retail price', 'mrp', 'selling price', 'sale price',
    'unit price', 'cost', 'rate', 'amount', 'value',
  ],
  compare_at_price: [
    'compare at price', 'compare_at_price', 'original price', 'old price',
    'was price', 'list price', 'before price', 'full price', 'regular price',
    'market price', 'maximum retail price',
  ],
  image_url: [
    'image url', 'image', 'image reference', 'photo', 'product image',
    'product photo', 'thumbnail', 'primary image', 'image link',
    'photo url', 'picture', 'picture url', 'img', 'img url',
    'image src', 'cover image', 'main image', 'front image',
  ],
  vendor: [
    'vendor', 'brand', 'brand name', 'manufacturer', 'supplier',
    'company', 'maker', 'producer',
  ],
  color: [
    'colour', 'color', 'colour name', 'color name', 'shade', 'colorway',
    'colourway',
  ],
  product_type: [
    'product type', 'type', 'category', 'product category', 'sub category',
    'subcategory', 'collection', 'department', 'group', 'class',
  ],
  tags: [
    'tags', 'tag', 'keywords', 'labels', 'attributes',
  ],
  inventory_quantity: [
    'inventory', 'quantity', 'stock', 'qty', 'units', 'available',
    'inventory quantity', 'stock quantity', 'pieces', 'pcs',
  ],
  status: [
    'status', 'active', 'published', 'available',
  ],
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_\-\.]+/g, '').trim()
}

/**
 * Given an array of raw column headers, returns the best canonical mapping.
 *
 * @returns Map<rawColName, canonicalField | null>
 */
export function autoMapColumns(
  headers: string[]
): Map<string, CanonicalField | null> {
  const result = new Map<string, CanonicalField | null>()
  // Track which canonical fields are already claimed (first-wins per canonical)
  const claimed = new Set<CanonicalField>()

  // Build reverse lookup: normalize(synonym) → canonical
  const exactLookup = new Map<string, CanonicalField>()
  for (const [canonical, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    for (const syn of synonyms) {
      const key = normalize(syn)
      if (!exactLookup.has(key)) {
        exactLookup.set(key, canonical as CanonicalField)
      }
    }
  }

  for (const header of headers) {
    const normalizedHeader = normalize(header)

    // 1. Exact normalized match
    const exactMatch = exactLookup.get(normalizedHeader)
    if (exactMatch && !claimed.has(exactMatch)) {
      result.set(header, exactMatch)
      claimed.add(exactMatch)
      continue
    }

    // 2. Keyword contains match — find the best scoring canonical
    let bestCanonical: CanonicalField | null = null
    let bestScore = 0

    for (const [canonical, synonyms] of Object.entries(FIELD_SYNONYMS)) {
      if (claimed.has(canonical as CanonicalField)) continue
      for (const syn of synonyms) {
        const normalizedSyn = normalize(syn)
        if (
          normalizedHeader.includes(normalizedSyn) ||
          normalizedSyn.includes(normalizedHeader)
        ) {
          // Score by specificity: longer synonym = more specific = higher score
          const score = normalizedSyn.length
          if (score > bestScore) {
            bestScore = score
            bestCanonical = canonical as CanonicalField
          }
        }
      }
    }

    if (bestCanonical) {
      result.set(header, bestCanonical)
      claimed.add(bestCanonical)
    } else {
      result.set(header, null) // unmapped — kept as-is in raw_data
    }
  }

  return result
}

/**
 * Apply a column map to a raw row object.
 * Returns both the canonical fields and all original fields.
 */
export function applyColumnMap(
  rawRow: Record<string, unknown>,
  columnMap: Map<string, CanonicalField | null>
): {
  canonical: Partial<Record<CanonicalField, string>>
  raw: Record<string, unknown>
} {
  const canonical: Partial<Record<CanonicalField, string>> = {}

  for (const [header, field] of columnMap.entries()) {
    if (field && rawRow[header] !== undefined && rawRow[header] !== null && rawRow[header] !== '') {
      canonical[field] = String(rawRow[header]).trim()
    }
  }

  return { canonical, raw: rawRow }
}

/**
 * Serialize a column map to JSON for DB storage.
 */
export function serializeColumnMap(
  map: Map<string, CanonicalField | null>
): Record<string, string | null> {
  return Object.fromEntries(map.entries())
}

/**
 * Deserialize a column map from DB JSON.
 */
export function deserializeColumnMap(
  obj: Record<string, string | null>
): Map<string, CanonicalField | null> {
  return new Map(
    Object.entries(obj).map(([k, v]) => [k, v as CanonicalField | null])
  )
}