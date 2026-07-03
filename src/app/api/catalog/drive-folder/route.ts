/**
 * POST /api/catalog/drive-folder
 *
 * Scans a public Google Drive folder and returns a match preview.
 * Matches by SKU against filenames — files like "DVPS001 - PURPLE.jpg"
 * match SKU "DVPS001" because the SKU tokens appear in the filename.
 *
 * Body: { folderUrl: string, storeId: string, importId: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import {
  scanDriveFolder,
  matchIdentifiersToMultipleFiles,
  matchSkusToFiles,
  normalizeName,
} from '@/lib/catalog-import/drive-folder-scanner'

export const maxDuration = 45

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { folderUrl, storeId, importId } = await request.json()
  if (!folderUrl) return NextResponse.json({ error: 'folderUrl required' }, { status: 400 })
  if (!storeId)   return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  if (!importId)  return NextResponse.json({ error: 'importId required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()

  // Only query columns guaranteed to exist in the schema
  const { data: products, error: productsError } = await admin
    .from('products')
    .select('id, sku, title')
    .eq('store_id', storeId)
    .eq('import_id', importId)

  if (productsError) {
    return NextResponse.json({ error: `DB error: ${productsError.message}` }, { status: 500 })
  }
  if (!products?.length) {
    return NextResponse.json({
      error: 'No products found for this import. Complete the line sheet import step first.',
    }, { status: 404 })
  }

  // Scan Drive folder
  let files
  try {
    files = await scanDriveFolder(folderUrl)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 })
  }

  // Build match identifiers — just normalized SKU
  // The substring matching in matchIdentifiersToMultipleFiles handles:
  //   SKU "DVPS001" → matches "DVPS001 - PURPLE.jpg", "DVPS001 - OCEAN.jpg" etc.
  const identifiers = products
    .map((p: any) => normalizeName(p.sku || ''))
    .filter(Boolean) as string[]

  const productByIndex = products as any[]

  const multiMatched = matchIdentifiersToMultipleFiles(identifiers, files)
  const { unmatched } = matchSkusToFiles(identifiers, files)

  const totalMatchedImages = Array.from(multiMatched.values())
    .reduce((sum, arr) => sum + arr.length, 0)

  return NextResponse.json({
    totalImages: files.length,
    matchedProducts: multiMatched.size,
    totalMatchedImages,
    unmatchedProducts: unmatched.length,
    matchedSample: Array.from(multiMatched.entries()).slice(0, 8).map(([identifier, fList]) => {
      const idx = identifiers.indexOf(identifier)
      const product = productByIndex[idx]
      return {
        sku: product?.sku,
        color: null,
        title: product?.title,
        imageCount: fList.length,
        filenames: fList.map((f: any) => f.filename),
      }
    }),
    unmatchedSample: unmatched.slice(0, 8).map((identifier) => {
      const idx = identifiers.indexOf(identifier)
      const product = productByIndex[idx]
      return { sku: product?.sku, color: null }
    }),
  })
}