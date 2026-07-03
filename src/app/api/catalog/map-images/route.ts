/**
 * POST /api/catalog/map-images
 *
 * Downloads images from a Google Drive folder, uploads to Cloudinary,
 * and links them to the imported products.
 *
 * Body: { importId: string, storeId: string, folderUrl: string }
 *
 * Uses composite matching (SKU + color when available) so variants of
 * the same style number with different colors get the correct image.
 * Supports multiple images per product (front/back/detail shots).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import {
  scanDriveFolder,
  matchIdentifiersToMultipleFiles,
  normalizeName,
  type DriveFolderFile,
} from '@/lib/catalog-import/drive-folder-scanner'
import { downloadImage, uploadImageToCloudinary } from '@/lib/catalog-import/image-resolver'
import crypto from 'crypto'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { importId, storeId, folderUrl } = await request.json()
  if (!importId)  return NextResponse.json({ error: 'importId required' }, { status: 400 })
  if (!storeId)   return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  if (!folderUrl) return NextResponse.json({ error: 'folderUrl required' }, { status: 400 })

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
    return NextResponse.json({ error: 'No products found for this import' }, { status: 404 })
  }

  await admin.from('catalog_imports')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', importId)

  // Scan Drive folder
  let driveFiles: DriveFolderFile[]
  try {
    driveFiles = await scanDriveFolder(folderUrl)
  } catch (err: any) {
    await admin.from('catalog_imports')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', importId)
    return NextResponse.json({ error: `Drive folder error: ${err.message}` }, { status: 422 })
  }

  // Build composite identifiers (sku + color)
  const identifiers = products.map((p: any) => {
    return [p.sku, p.color].filter(Boolean).map((s: string) => normalizeName(s)).join(' ').trim()
  }) as string[]

  const productByIdx = products  // same index as identifiers array

  // One-to-many matching: each product can have multiple images
  const matched = matchIdentifiersToMultipleFiles(identifiers, driveFiles)

  const results = {
    totalProducts: products.length,
    productsMatched: 0,
    imagesUploaded: 0,
    imagesFailed: 0,
    productsUnmatched: 0,
    errors: [] as { sku?: string; color?: string; reason: string }[],
  }

  for (let i = 0; i < identifiers.length; i++) {
    const identifier = identifiers[i]
    const product = productByIdx[i]
    const matchedFiles = matched.get(identifier) ?? []

    if (matchedFiles.length === 0) {
      results.productsUnmatched++
      results.errors.push({
        sku: product.sku,
        color: product.color,
        reason: 'No matching image in Drive folder',
      })
      continue
    }

    let anySucceeded = false
    let firstImageUrl: string | null = null
    let position = 1

    for (const driveFile of matchedFiles) {
      try {
        const { buffer } = await downloadImage(driveFile.downloadUrl)

        const imageHash = crypto
          .createHash('sha256').update(driveFile.fileId).digest('hex').slice(0, 20)

        const { url: cloudinaryUrl } = await uploadImageToCloudinary(
          buffer,
          `catalog-imports/${storeId}/${imageHash}`
        )

        // Upsert product_images — one row per image angle
        await admin.from('product_images').upsert({
          product_id: product.id,
          src: cloudinaryUrl,
          is_primary: position === 1,
          position,
        }, { onConflict: 'product_id,position' })

        if (position === 1) firstImageUrl = cloudinaryUrl
        anySucceeded = true
        results.imagesUploaded++
        position++
      } catch (err: any) {
        results.imagesFailed++
        results.errors.push({
          sku: product.sku, color: product.color,
          reason: `File "${driveFile.filename}": ${err.message}`,
        })
        // Continue — a failed image never stops the rest
      }
    }

    if (anySucceeded && firstImageUrl) {
      await admin.from('products').update({
        image_url: firstImageUrl,
        updated_at: new Date().toISOString(),
      }).eq('id', product.id)
      results.productsMatched++
    }
  }

  await admin.from('catalog_imports').update({
    status: 'completed',
    imported_rows: results.productsMatched,
    failed_rows: results.productsUnmatched,
    error_report: results.errors.length ? results.errors : null,
    updated_at: new Date().toISOString(),
  }).eq('id', importId)

  return NextResponse.json({
    ...results,
    message: `${results.productsMatched}/${products.length} products matched, ${results.imagesUploaded} images uploaded`,
  })
}