/**
 * POST /api/upload/images
 *
 * Receives image bytes from the browser and runs them through the EXISTING
 * import pipeline — Cloudinary upload → `products` upsert → `product_images`
 * row → `catalog_import_rows` audit row. This is the second half of the old
 * Drive import, unchanged; only the byte source moved from the Drive API to
 * multipart form-data.
 *
 * Body (multipart/form-data):
 *   importId      the session from POST /api/upload/folder
 *   file          image bytes — repeatable
 *   name          product title/SKU for the file at the same position
 *   relativePath  path inside the picked folder, for the audit trail
 *   index         position within the batch, for row_index
 *
 * The client sends one file per request so progress, cancellation and retry are
 * per-image, but the handler accepts a batch so small images can be grouped.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  detectImageType,
  uploadImageToCloudinary,
} from '@/lib/catalog-import/image-storage'
import { UPLOAD_CLOUDINARY_PREFIX, resolveUploadSession } from '@/lib/uploads/session'
import { isSupportedImageFile, toProductName } from '@/lib/uploads/image-files'
import crypto from 'crypto'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/** Ceiling on files per request — the client sends 1; this bounds abuse. */
const MAX_FILES_PER_REQUEST = 10

interface FileResult {
  filename: string
  success: boolean
  product?: { id: string; title: string; sku: string; imageUrl: string }
  reason?: string
}

export async function POST(request: NextRequest) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Malformed upload payload' }, { status: 400 })
  }

  const result = await resolveUploadSession(form.get('importId'), form.get('storeId') || undefined)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  const { admin, storeId, importId } = result.session

  const files = form.getAll('file').filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files received' }, { status: 400 })
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many files in one request (max ${MAX_FILES_PER_REQUEST})` },
      { status: 413 }
    )
  }

  const names = form.getAll('name').map(String)
  const paths = form.getAll('relativePath').map(String)
  const indexes = form.getAll('index').map(v => Number.parseInt(String(v), 10))

  const results: FileResult[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const relativePath = paths[i] || file.name
    const productName = (names[i] || toProductName(file.name) || 'image').slice(0, 200)
    const rowIndex = Number.isFinite(indexes[i]) ? indexes[i] : i

    try {
      // ── Validate ──────────────────────────────────────────────────────────
      if (!isSupportedImageFile(file.name, file.type)) {
        throw new Error('Unsupported file type — only JPG, PNG, WEBP and AVIF are imported')
      }

      const buffer = Buffer.from(await file.arrayBuffer())

      if (buffer.length === 0) throw new Error('File is empty')
      if (buffer.length < 500) throw new Error(`Image too small (${buffer.length} bytes)`)

      // Magic-byte check: catches a renamed PDF/ZIP and truncated downloads
      // that the extension and MIME type both claim are images.
      const detected = detectImageType(buffer)
      if (!detected) {
        throw new Error('Corrupted or unrecognised image file')
      }
      if (detected === 'image/gif' || detected === 'image/heic') {
        throw new Error(`${detected.replace('image/', '').toUpperCase()} is not a supported format`)
      }

      // ── Store ─────────────────────────────────────────────────────────────
      // public_id derives from the CONTENT hash, so re-uploading identical bytes
      // (a retry, or the same photo in two subfolders) resolves to the one
      // Cloudinary asset instead of duplicating storage.
      const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
      const { url: cloudinaryUrl, cloudinaryId } = await uploadImageToCloudinary(
        buffer,
        `${UPLOAD_CLOUDINARY_PREFIX}/${storeId}/${contentHash.slice(0, 20)}`
      )

      // ── Create the product (identical to the Drive import) ────────────────
      const { data: product, error: productError } = await admin
        .from('products')
        .upsert({
          store_id: storeId,
          title: productName,
          sku: productName,
          status: 'active',
          price: 0,
          image_url: cloudinaryUrl,
          import_id: importId,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'store_id,sku', ignoreDuplicates: false })
        .select('id')
        .single()

      if (productError || !product) {
        throw new Error(productError?.message || 'Failed to create product')
      }

      // Create product_images row — DELETE existing first to ensure clean state,
      // then insert fresh. This avoids needing a unique constraint on product_id+position
      // and guarantees the product thumbnail always appears in the products list.
      await admin.from('product_images')
        .delete()
        .eq('product_id', product.id)
        .eq('position', 1)

      await admin.from('product_images').insert({
        product_id: product.id,
        src: cloudinaryUrl,
        is_primary: true,
        position: 1,
      })

      // Audit row — also the record /api/upload/image reads to delete the
      // Cloudinary asset, and what the session recount counts.
      //
      // Delete-then-insert keeps it idempotent at ONE row per product. Without
      // this, an image whose response was lost in transit (product committed,
      // client saw a network error) would add a second 'imported' row on retry
      // and inflate the count the Excel export reports.
      try {
        await admin.from('catalog_import_rows')
          .delete()
          .eq('import_id', importId)
          .eq('product_id', product.id)

        await admin.from('catalog_import_rows').insert({
          import_id: importId,
          product_id: product.id,
          row_index: rowIndex,
          raw_data: {
            filename: file.name,
            relative_path: relativePath,
            content_hash: contentHash,
            cloudinary_url: cloudinaryUrl,
            cloudinary_id: cloudinaryId,
            bytes: buffer.length,
            content_type: detected,
          },
          status: 'imported',
        })
      } catch { /* non-fatal */ }

      results.push({
        filename: file.name,
        success: true,
        product: {
          id: product.id,
          title: productName,
          sku: productName,
          imageUrl: cloudinaryUrl,
        },
      })
    } catch (err: any) {
      results.push({
        filename: file.name,
        success: false,
        reason: err?.message || 'Upload failed',
      })
    }
  }

  return NextResponse.json({
    results,
    imported: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  })
}
