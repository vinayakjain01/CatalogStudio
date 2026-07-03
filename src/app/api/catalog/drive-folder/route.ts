/**
 * POST /api/catalog/drive-folder
 *
 * Scans a public Google Drive folder using the official Drive API v3 and
 * shows a match preview before the user commits to downloading images.
 *
 * Body: { folderUrl: string, storeId: string, importId: string }
 *
 * The server fetches products from the DB so it can build the correct
 * match keys (sku alone, or sku+color when a color column was imported).
 * This keeps matching logic in one place instead of duplicating it on
 * the client and in map-images/route.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import {
  scanDriveFolder,
  matchSkusToFiles,
  matchIdentifiersToMultipleFiles,
  normalizeName,
} from '@/lib/catalog-import/drive-folder-scanner'

export const maxDuration = 45

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { folderUrl, storeId, importId } = await request.json()
  if (!folderUrl)  return NextResponse.json({ error: 'folderUrl required' }, { status: 400 })
  if (!storeId)    return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  if (!importId)   return NextResponse.json({ error: 'importId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  const { data: products } = await admin
    .from('products')
    .select('id, sku, color, title')
    .eq('store_id', storeId)
    .eq('import_id', importId)

  if (!products?.length) {
    return NextResponse.json({ error: 'No products found for this import. Complete the sheet import first.' }, { status: 404 })
  }

  // Scan Drive folder
  let files
  try {
    files = await scanDriveFolder(folderUrl)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 })
  }

  // Build match identifiers.
  // When a color column was imported, use "sku color" composite key so
  // DVPS001-PURPLE and DVPS001-ORANGE map to different images.
  // When no color, use SKU alone.
  const identifiers = products.map((p: any) => {
    const parts = [p.sku, p.color].filter(Boolean)
    return parts.map((s: string) => normalizeName(s)).join(' ').trim()
  }).filter(Boolean) as string[]

  const productByIdentifier = new Map(
    products.map((p: any, i: number) => [identifiers[i], p])
  )

  // Use multi-file matching for the preview (shows image count per product)
  const multiMatched = matchIdentifiersToMultipleFiles(identifiers, files)
  const { unmatched } = matchSkusToFiles(identifiers, files)

  const totalMatchedImages = Array.from(multiMatched.values())
    .reduce((sum, arr) => sum + arr.length, 0)

  return NextResponse.json({
    totalImages: files.length,
    matchedProducts: multiMatched.size,
    totalMatchedImages,
    unmatchedProducts: unmatched.length,
    // Sample matched pairs for user confirmation
    matchedSample: Array.from(multiMatched.entries()).slice(0, 8).map(([identifier, fList]) => {
      const product = productByIdentifier.get(identifier)
      return {
        sku: product?.sku,
        color: product?.color,
        title: product?.title,
        imageCount: fList.length,
        filenames: fList.map(f => f.filename),
      }
    }),
    unmatchedSample: unmatched.slice(0, 8).map(identifier => {
      const product = productByIdentifier.get(identifier)
      return { sku: product?.sku, color: product?.color }
    }),
  })
}