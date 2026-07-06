/**
 * POST /api/drive/import
 *
 * The simplest possible workflow:
 *   1. User pastes a Google Drive folder URL
 *   2. This endpoint lists ALL images in that folder
 *   3. Downloads each one, uploads to Cloudinary
 *   4. Auto-creates a line_sheet "store" named after the folder date
 *   5. Creates one "product" per image — filename is the SKU/title, image is the photo
 *   6. Returns the list of created products with their image URLs
 *
 * User never needs to: select a catalog, map columns, enter names/prices.
 * The created products behave exactly like any other product in the generation
 * pipeline — templates, rules, generation, and creative export all work normally.
 *
 * Body: { folderUrl: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { downloadImage, uploadImageToCloudinary } from '@/lib/catalog-import/image-resolver'
import crypto from 'crypto'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'

// ── Drive helpers ─────────────────────────────────────────────────────────────

function extractFolderId(url: string): string | null {
  const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (m) return m[1]
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  return m2 ? m2[1] : null
}

interface DriveFile { id: string; name: string; mimeType: string }

async function listAllImages(folderId: string, apiKey: string): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
      key: apiKey,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: '1000',
      orderBy: 'name',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(`${DRIVE_API}/files?${params}`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const msg: string = body?.error?.message ?? res.statusText

      if (res.status === 403) {
        const isKeyIssue = msg.toLowerCase().includes('api key') || msg.toLowerCase().includes('disabled')
        throw new Error(isKeyIssue
          ? `Google Drive API key issue: ${msg}. Check GOOGLE_DRIVE_API_KEY is set and the Drive API is enabled.`
          : `Drive folder access denied: ${msg}. Make sure folder is shared as "Anyone with the link can view".`
        )
      }
      throw new Error(`Drive API error ${res.status}: ${msg}`)
    }

    const data = await res.json()
    files.push(...(data.files ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)

  return files
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { folderUrl } = await request.json()
  if (!folderUrl) return NextResponse.json({ error: 'folderUrl required' }, { status: 400 })

  // ── Check API key ─────────────────────────────────────────────────────────
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY
  if (!apiKey) {
    return NextResponse.json({
      error: 'GOOGLE_DRIVE_API_KEY is not configured.',
      setup: [
        'Go to https://console.cloud.google.com',
        'APIs & Services → Library → search "Google Drive API" → Enable',
        'Credentials → Create Credentials → API Key',
        'Add GOOGLE_DRIVE_API_KEY=your_key to Vercel environment variables',
        'Redeploy the app',
      ],
    }, { status: 503 })
  }

  // ── Validate folder URL ───────────────────────────────────────────────────
  const folderId = extractFolderId(folderUrl)
  if (!folderId) {
    return NextResponse.json({
      error: 'Invalid Google Drive folder URL. Expected: https://drive.google.com/drive/folders/FOLDER_ID',
    }, { status: 400 })
  }

  // ── List images ───────────────────────────────────────────────────────────
  let driveFiles: DriveFile[]
  try {
    driveFiles = await listAllImages(folderId, apiKey)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 })
  }

  if (driveFiles.length === 0) {
    return NextResponse.json({
      error: 'No images found in this folder. Make sure the folder contains image files (.jpg, .png, .webp) and is shared as "Anyone with the link can view".',
    }, { status: 404 })
  }

  // ── Auto-create a line_sheet store for this import ────────────────────────
  const admin = getAdminClient()
  const importDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  const storeName = `Drive Import — ${importDate}`

  const { data: newStore } = await admin
    .from('stores')
    .insert({
      user_id: user.id,
      shop_name: storeName,
      display_name: storeName,
      shop_domain: `drive-${Date.now()}`,
      source: 'line_sheet',
      is_active: true,
      feed_token: crypto.randomUUID(),
    })
    .select('id')
    .single()

  if (!newStore) {
    return NextResponse.json({ error: 'Failed to create catalog' }, { status: 500 })
  }

  const storeId = newStore.id

  // Create an import record for tracking + later export
  const { data: importRecord } = await admin
    .from('catalog_imports')
    .insert({
      store_id: storeId,
      user_id: user.id,
      filename: `drive-folder-${folderId}`,
      source_url: folderUrl,
      status: 'processing',
      total_rows: driveFiles.length,
    })
    .select('id')
    .single()

  const importId = importRecord?.id ?? null

  // ── Download + upload + create products ───────────────────────────────────
  const results = {
    storeId,
    importId,
    total: driveFiles.length,
    imported: 0,
    failed: 0,
    products: [] as { id: string; title: string; sku: string; imageUrl: string }[],
    errors: [] as { filename: string; reason: string }[],
  }

  // Process in batches of 5 to avoid memory spikes and Vercel timeout
  const BATCH = 5
  for (let i = 0; i < driveFiles.length; i += BATCH) {
    const batch = driveFiles.slice(i, i + BATCH)

    const batchResults = await Promise.all(batch.map(async (file) => {
      try {
        // Download from Drive via authenticated API endpoint
        const downloadUrl = `${DRIVE_API}/files/${file.id}?alt=media&key=${apiKey}`
        const { buffer } = await downloadImage(downloadUrl)

        // Upload to Cloudinary with deterministic ID (skip if already exists)
        const imageHash = crypto.createHash('sha256').update(file.id).digest('hex').slice(0, 20)
        const { url: cloudinaryUrl } = await uploadImageToCloudinary(
          buffer,
          `drive-imports/${storeId}/${imageHash}`
        )

        // Filename without extension becomes the product title + SKU
        const nameWithoutExt = file.name.replace(/\.[^.]+$/, '')

        // Create the product — no price, no vendor, just the image
        const { data: product } = await admin
          .from('products')
          .upsert({
            store_id: storeId,
            title: nameWithoutExt,
            sku: nameWithoutExt,
            status: 'active',
            price: 0,
            image_url: cloudinaryUrl,
            import_id: importId,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'store_id,sku', ignoreDuplicates: false })
          .select('id')
          .single()

        if (!product) throw new Error('Failed to create product')

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

        // Track import row
        if (importId) {
          try {
            await admin.from('catalog_import_rows').insert({
              import_id: importId,
              product_id: product.id,
              row_index: i,
              raw_data: { filename: file.name, drive_id: file.id, cloudinary_url: cloudinaryUrl },
              status: 'imported',
            })
          } catch { /* non-fatal */ }
        }

        return {
          success: true,
          product: { id: product.id, title: nameWithoutExt, sku: nameWithoutExt, imageUrl: cloudinaryUrl },
        }
      } catch (err: any) {
        return { success: false, filename: file.name, reason: err.message }
      }
    }))

    for (const r of batchResults) {
      if (r.success && r.product) {
        results.imported++
        results.products.push(r.product)
      } else if (!r.success) {
        results.failed++
        results.errors.push({ filename: r.filename!, reason: r.reason! })
      }
    }
  }

  // Finalize import record
  if (importId) {
    await admin.from('catalog_imports').update({
      status: results.failed === driveFiles.length ? 'failed' : 'completed',
      imported_rows: results.imported,
      failed_rows: results.failed,
      error_report: results.errors.length ? results.errors : null,
      updated_at: new Date().toISOString(),
    }).eq('id', importId)
  }

  return NextResponse.json({
    ...results,
    message: `${results.imported} images imported successfully${results.failed > 0 ? `, ${results.failed} failed` : ''}`,
  })
}