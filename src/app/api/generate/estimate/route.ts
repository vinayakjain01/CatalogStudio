/**
 * GET /api/generate/estimate?storeId=&variantScope=&optionName=&optionValue=&imageScope=&filterType=&filterValue=&assetTypes=
 *
 * Read-only preview of exactly how many jobs a given generation scope would
 * enqueue, using the same computeGenerationRows() fan-out that POST
 * /api/generate/enqueue itself inserts from, so the estimate can never drift
 * from what a real submission produces.
 *
 * Auth:    Supabase session (getUser())
 * Query:   storeId (required), variantScope, optionName, optionValue,
 *          imageScope, filterType, filterValue, assetTypes (comma-separated,
 *          e.g. "catalog,feed" — defaults to "catalog")
 * Returns: { count, variants, products, overLimit, softWarn, limit,
 *          softWarnThreshold } — or { count: 0, products: 0 } when nothing matches
 *
 * Flow: verify user & store -> collect filtered product IDs -> computeGenerationRows() -> count + limit flags.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import {
  getAdminClient, collectFilteredProductIds, computeGenerationRows,
  MAX_JOBS_PER_ENQUEUE, SOFT_WARN_JOBS,
} from '@/lib/generation-queue'
import { ALL_ASSET_TYPES, type AssetType } from '@/types/template'

/**
 * GET /api/generate/estimate?storeId=&variantScope=&optionName=&optionValue=&imageScope=&filterType=&filterValue=
 *
 * Exact job count a given scope would enqueue — reuses computeGenerationRows(),
 * the same fan-out enqueueGeneration() itself inserts from, so the "Will
 * generate: N jobs" preview on the Creatives page can never drift from what a
 * click on Generate actually submits. Read-only: never writes generation_jobs.
 */
export async function GET(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const params = request.nextUrl.searchParams
  const storeId = params.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const variantScope = params.get('variantScope') || 'all'
  const optionName = (params.get('optionName') || '').trim()
  const optionValue = (params.get('optionValue') || '').trim()
  const imageScopeParam = params.get('imageScope') || 'all'
  const imageScope = imageScopeParam === 'first' ? 'first' : 'all'
  const filterType = params.get('filterType') as 'tag' | 'vendor' | 'product_type' | null
  const filterValue = params.get('filterValue') || undefined

  // Comma-separated, e.g. ?assetTypes=catalog,feed — mirrors what
  // /api/generate/enqueue accepts, so this estimate can never drift from the
  // real submit for a multi-placement request. Invalid values are dropped;
  // an empty result falls back to ['catalog'] rather than 400ing a preview
  // the merchant hasn't finished configuring yet.
  const assetTypesParam = (params.get('assetTypes') || 'catalog')
    .split(',')
    .map(t => t.trim())
    .filter((t): t is AssetType => ALL_ASSET_TYPES.includes(t as AssetType))
  const assetTypes: AssetType[] = assetTypesParam.length > 0 ? assetTypesParam : ['catalog']

  // Mirrors /api/generate/enqueue's own validation: an incomplete "specific
  // option" scope matches nothing rather than erroring, since the UI shows
  // this live while the merchant is still typing the option value.
  if (variantScope === 'specific' && (!optionName || !optionValue)) {
    return NextResponse.json({ count: 0, products: 0 })
  }

  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()

  let productIds: string[]
  try {
    productIds = await collectFilteredProductIds(
      storeId,
      filterType ? { type: filterType, value: filterValue } : null,
      admin
    )
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to load products' }, { status: 500 })
  }

  if (productIds.length === 0) {
    return NextResponse.json({ count: 0, products: 0 })
  }

  try {
    const rows = await computeGenerationRows(
      {
        storeId,
        productIds,
        variantOption: variantScope === 'specific' ? { name: optionName, value: optionValue } : null,
        imageScope,
        assetTypes,
      },
      admin
    )

    // Distinct variants, not just job count: "All poses" fans out several
    // jobs per variant, so `count` alone can't be compared against the
    // dashboard's Feed Coverage card, which counts VARIANTS. Surfacing both
    // lets the two numbers actually be checked against each other.
    const distinctVariants = new Set(rows.map(r => r.variant_id).filter(Boolean)).size

    return NextResponse.json({
      count: rows.length,
      variants: distinctVariants,
      products: productIds.length,
      overLimit: rows.length > MAX_JOBS_PER_ENQUEUE,
      softWarn: rows.length > SOFT_WARN_JOBS,
      limit: MAX_JOBS_PER_ENQUEUE,
      softWarnThreshold: SOFT_WARN_JOBS,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to compute estimate' }, { status: 500 })
  }
}
