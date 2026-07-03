/**
 * POST /api/catalog/load-drive-images
 *
 * The simplest possible Drive-to-tool image loader.
 *
 * 1. Takes a Drive folder URL + storeId
 * 2. Lists ALL image files in the folder via Drive API
 * 3. For each image: downloads it, uploads to Cloudinary
 * 4. Tries to match the image filename against any product SKU in the store
 *    (simple: if filename contains SKU → match)
 * 5. Matched → updates product.image_url + creates product_images row
 * 6. Unmatched → uploads to Cloudinary anyway, returns the URL
 *
 * Does NOT need importId. Works on any products already in the store.
 * Errors per-image are logged but never stop the whole import.
 *
 * Body: { storeId: string, folderUrl: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { downloadImage, uploadImageToCloudinary } from '@/lib/catalog-import/image-resolver'
import crypto from 'crypto'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function extractFolderId(url: string): string | null {
  // handles /folders/ID, /drive/u/0/folders/ID, ?id=ID, etc.
  const folderMatch = url.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (folderMatch) return folderMatch[1]
  const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (idMatch) return idMatch[1]
  return null
}

interface DriveFileItem {
  id: string
  name: string
  mimeType: string
}

async function listDriveImages(folderId: string, apiKey: string): Promise<DriveFileItem[]> {
  const files: DriveFileItem[] = []
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
        throw new Error(
          `Drive API access denied: ${msg}. ` +
          `Check: (1) folder is shared "Anyone with link can view", ` +
          `(2) Google Drive API is enabled in Cloud Console, ` +
          `(3) GOOGLE_DRIVE_API_KEY is set correctly.`
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

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { storeId, folderUrl } = await request.json()
  if (!storeId)   return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  if (!folderUrl) return NextResponse.json({ error: 'folderUrl required' }, { status: 400 })

  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const apiKey = process.env.GOOGLE_DRIVE_API_KEY
  if (!apiKey) {
    return NextResponse.json({
      error: 'GOOGLE_DRIVE_API_KEY is not set. ' +
        'Go to console.cloud.google.com → Enable Google Drive API → ' +
        'Create API Key → add GOOGLE_DRIVE_API_KEY to Vercel environment variables.',
    }, { status: 503 })
  }

  const folderId = extractFolderId(folderUrl)
  if (!folderId) {
    return NextResponse.json({
      error: 'Invalid Google Drive folder URL. Expected: https://drive.google.com/drive/folders/FOLDER_ID',
    }, { status: 400 })
  }

  // List all image files in the folder
  let driveFiles: DriveFileItem[]
  try {
    driveFiles = await listDriveImages(folderId, apiKey)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 })
  }

  if (driveFiles.length === 0) {
    return NextResponse.json({
      error: 'No images found in this Drive folder. ' +
        'Check the folder contains .jpg/.png/.webp files and is shared publicly.',
    }, { status: 404 })
  }

  const admin = getAdminClient()

  // Load all products for this store (no importId filter — works for any products)
  const { data: products } = await admin
    .from('products')
    .select('id, sku, title')
    .eq('store_id', storeId)

  // Build product lookup: normalizedName → product
  // Multiple variants: "dvps001" → product with SKU DVPS001
  const productsByNorm = new Map<string, any>()
  for (const p of (products ?? [])) {
    if (p.sku) {
      productsByNorm.set(normalizeName(p.sku), p)
    }
  }

  const results = {
    totalImages: driveFiles.length,
    matched: 0,
    uploaded: 0,
    failed: 0,
    errors: [] as { filename: string; reason: string }[],
    preview: [] as { filename: string; sku: string; cloudinaryUrl: string }[],
  }

  // Process images in batches of 5 to avoid memory pressure
  const BATCH = 5
  for (let i = 0; i < driveFiles.length; i += BATCH) {
    const batch = driveFiles.slice(i, i + BATCH)

    await Promise.all(batch.map(async (file) => {
      try {
        // Download from Drive API (alt=media gives raw bytes directly)
        const downloadUrl = `${DRIVE_API}/files/${file.id}?alt=media&key=${apiKey}`
        const { buffer } = await downloadImage(downloadUrl)

        // Deterministic Cloudinary ID based on file ID
        const imageHash = crypto.createHash('sha256').update(file.id).digest('hex').slice(0, 20)
        const { url: cloudinaryUrl } = await uploadImageToCloudinary(
          buffer,
          `catalog-imports/${storeId}/${imageHash}`
        )

        results.uploaded++

        // Try to match this image to a product by filename
        const base = normalizeName(file.name.replace(/\.[^.]+$/, ''))
        let matchedProduct: any = null

        for (const [normSku, product] of productsByNorm.entries()) {
          // filename contains SKU: "dvps001 purple front" contains "dvps001"
          if (base.includes(normSku) || normSku.includes(base)) {
            matchedProduct = product
            break
          }
        }

        if (matchedProduct) {
          // Update product image
          await admin.from('products').update({
            image_url: cloudinaryUrl,
            updated_at: new Date().toISOString(),
          }).eq('id', matchedProduct.id)

          // Create product_images row
          await admin.from('product_images').upsert({
            product_id: matchedProduct.id,
            src: cloudinaryUrl,
            is_primary: true,
            position: 1,
          }, { onConflict: 'product_id,position' })

          results.matched++
          if (results.preview.length < 5) {
            results.preview.push({
              filename: file.name,
              sku: matchedProduct.sku,
              cloudinaryUrl,
            })
          }
        }
      } catch (err: any) {
        results.failed++
        results.errors.push({ filename: file.name, reason: err.message })
      }
    }))
  }

  return NextResponse.json({
    ...results,
    message: `Loaded ${results.uploaded} images, matched ${results.matched} products`,
  })
}