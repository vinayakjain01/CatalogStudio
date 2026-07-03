/**
 * POST /api/catalog/map-images
 *
 * Takes a pre-scanned file list (from /api/catalog/drive-folder) and:
 *  1. Matches each file to a product by SKU
 *  2. Downloads the image from Drive (lh3 URL)
 *  3. Uploads to Cloudinary
 *  4. Updates product.image_url + upserts product_images row
 *
 * Body: {
 *   importId: string
 *   storeId: string
 *   files: DriveFolderFile[]   -- already scanned, passed from drive-folder response
 * }
 *
 * Accepts optional folderUrl to re-scan if files not provided.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { scanDriveFolder, matchSkusToFiles } from '@/lib/catalog-import/drive-folder-scanner'
import type { DriveFolderFile } from '@/lib/catalog-import/drive-folder-scanner'
import { downloadImage, uploadImageToCloudinary } from '@/lib/catalog-import/image-resolver'
import crypto from 'crypto'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { importId, storeId, files: providedFiles, folderUrl } = await request.json()
  if (!importId) return NextResponse.json({ error: 'importId required' }, { status: 400 })
  if (!storeId)  return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  if (!providedFiles?.length && !folderUrl) {
    return NextResponse.json({ error: 'Either files or folderUrl required' }, { status: 400 })
  }

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()

  // Load products for this import
  const { data: products } = await admin
    .from('products')
    .select('id, sku, title')
    .eq('store_id', storeId)
    .eq('import_id', importId)

  if (!products?.length) {
    return NextResponse.json({ error: 'No products found for this import' }, { status: 404 })
  }

  // Get file list — use provided (already scanned) or re-scan folder
  let driveFiles: DriveFolderFile[]
  if (providedFiles?.length) {
    driveFiles = providedFiles as DriveFolderFile[]
  } else {
    driveFiles = await scanDriveFolder(folderUrl)
  }

  const skus = products.map((p: any) => p.sku).filter(Boolean) as string[]
  const { matched, unmatched } = matchSkusToFiles(skus, driveFiles)

  await admin.from('catalog_imports').update({
    status: 'processing',
    updated_at: new Date().toISOString(),
  }).eq('id', importId)

  const results = {
    total: products.length,
    matched: 0,
    failed: 0,
    skipped: unmatched.length,
    errors: [] as { sku: string; reason: string }[],
  }

  for (const [sku, driveFile] of matched.entries()) {
    const product = products.find((p: any) => p.sku === sku)
    if (!product) continue

    try {
      // Download from lh3 (bypasses Drive virus-scan redirect)
      const { buffer } = await downloadImage(driveFile.downloadUrl)

      // Deterministic Cloudinary public_id based on Drive file ID
      const imageHash = crypto
        .createHash('sha256')
        .update(driveFile.fileId)
        .digest('hex')
        .slice(0, 20)

      const { url: cloudinaryUrl } = await uploadImageToCloudinary(
        buffer,
        `catalog-imports/${storeId}/${imageHash}`
      )

      // Update product row
      await admin.from('products').update({
        image_url: cloudinaryUrl,
        updated_at: new Date().toISOString(),
      }).eq('id', product.id)

      // Upsert product_images (used by generation worker)
      await admin.from('product_images').upsert({
        product_id: product.id,
        src: cloudinaryUrl,
        is_primary: true,
        position: 1,
      }, { onConflict: 'product_id,position' })

      results.matched++
    } catch (err: any) {
      results.failed++
      results.errors.push({ sku, reason: err.message })
    }
  }

  // Add unmatched as warnings (not errors — product imported fine, just no image)
  for (const sku of unmatched) {
    results.errors.push({ sku, reason: 'No matching image in Drive folder' })
  }

  await admin.from('catalog_imports').update({
    status: 'completed',
    imported_rows: results.matched,
    failed_rows: results.failed,
    error_report: results.errors.length ? results.errors : null,
    updated_at: new Date().toISOString(),
  }).eq('id', importId)

  return NextResponse.json({
    ...results,
    message: `${results.matched}/${skus.length} products matched to Drive images`,
  })
}