/**
 * Catalog Import Processor
 *
 * Writes products into the existing `products` table using ONLY columns
 * that exist in the actual schema:
 *
 *   id, store_id, shopify_id, title, handle, vendor, product_type, tags,
 *   price, compare_at_price, inventory_quantity, status, created_at,
 *   updated_at, creative_status, feed_status, collection, sku, image_url,
 *   discount_percent, last_creative_at, import_id
 *
 * NOTE: There is no `description` or `external_id` column.
 *  - We use `sku` as the idempotency key (conflict on store_id + sku).
 *  - `image_url` is stored directly on the products row (no product_images upsert needed,
 *    but we also try to upsert into product_images for compatibility with the generator).
 */

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { autoMapColumns, applyColumnMap, serializeColumnMap } from './column-mapper'
import type { ParsedSheet } from './parser'
import { downloadImage, uploadImageToCloudinary } from './image-resolver'
import type { ExtractedImage } from './image-extractor'

export interface ImportOptions {
  storeId: string
  userId: string
  importId: string
  columnMapOverride?: Record<string, string | null>
  downloadImages?: boolean
  /** row index (0-based, same indexing as sheet.rows) -> pasted/embedded image, if any */
  embeddedImages?: Map<number, ExtractedImage>
}

export interface ImportResult {
  imported: number
  failed: number
  errors: { row: number; reason: string }[]
}

export async function processImport(
  sheet: ParsedSheet,
  options: ImportOptions,
  supabase: SupabaseClient
): Promise<ImportResult> {
  const { storeId, userId, importId, columnMapOverride, downloadImages = true, embeddedImages } = options

  let columnMap = autoMapColumns(sheet.headers)
  if (columnMapOverride) {
    for (const [rawCol, canonical] of Object.entries(columnMapOverride)) {
      columnMap.set(rawCol, canonical as any)
    }
  }

  await supabase
    .from('catalog_imports')
    .update({
      column_map: serializeColumnMap(columnMap),
      total_rows: sheet.rows.length,
      status: 'processing',
      updated_at: new Date().toISOString(),
    })
    .eq('id', importId)

  const errors: { row: number; reason: string }[] = []
  let imported = 0
  let failed = 0

  for (let i = 0; i < sheet.rows.length; i++) {
    const rawRow = sheet.rows[i]
    const { canonical } = applyColumnMap(rawRow as Record<string, unknown>, columnMap)

    try {
      const title = canonical.title || canonical.sku || `Row ${i + 1}`
      const sku = canonical.sku || `import_${importId}_${i}`
      const price = parseFloat((canonical.price || '0').replace(/[^0-9.]/g, '')) || 0
      const compareAt = canonical.compare_at_price
        ? parseFloat(canonical.compare_at_price.replace(/[^0-9.]/g, '')) || null
        : null

      // Handle image — download & upload to Cloudinary if needed
      let finalImageUrl: string | null = canonical.image_url || null
      if (finalImageUrl && downloadImages) {
        try {
          const imageHash = crypto
            .createHash('sha256')
            .update(finalImageUrl)
            .digest('hex')
            .slice(0, 16)

          const { buffer } = await downloadImage(finalImageUrl)
          const { url } = await uploadImageToCloudinary(
            buffer,
            `catalog-imports/${storeId}/${imageHash}`
          )
          finalImageUrl = url
        } catch (imgErr: any) {
          console.warn(`[import] Image failed row ${i}: ${imgErr.message}`)
          // Keep original URL as fallback if download fails
        }
      } else if (!finalImageUrl && downloadImages && embeddedImages?.has(i)) {
        // No URL in the sheet for this row — but a photo was pasted/inserted
        // directly into the cell. Upload that image buffer straight to
        // Cloudinary instead of skipping the row's image entirely.
        const embedded = embeddedImages.get(i)!
        try {
          const imageHash = crypto
            .createHash('sha256')
            .update(embedded.buffer)
            .digest('hex')
            .slice(0, 16)

          const { url } = await uploadImageToCloudinary(
            embedded.buffer,
            `catalog-imports/${storeId}/${imageHash}`
          )
          finalImageUrl = url
        } catch (imgErr: any) {
          console.warn(`[import] Embedded image failed row ${i}: ${imgErr.message}`)
        }
      }

      // Upsert product using columns that ACTUALLY exist in your schema
      const { data: product, error: productError } = await supabase
        .from('products')
        .upsert({
          store_id: storeId,
          title,
          sku,
          vendor: canonical.vendor || null,
          product_type: canonical.product_type || null,
          collection: canonical.product_type || null,  // map product_type → collection too
          tags: canonical.tags
            ? canonical.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
            : [],
          price,
          compare_at_price: compareAt,
          status: 'active',
          inventory_quantity: canonical.inventory_quantity
            ? parseInt(canonical.inventory_quantity, 10) || 0
            : 0,
          image_url: finalImageUrl,
          import_id: importId,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'store_id,sku',
          ignoreDuplicates: false,
        })
        .select('id')
        .single()

      if (productError || !product) {
        throw new Error(productError?.message || 'Failed to upsert product')
      }

      // Also upsert into product_images so the compositor can find the image
      // (generation-queue loads from product_images, not products.image_url)
      if (finalImageUrl) {
        await supabase
          .from('product_images')
          .upsert({
            product_id: product.id,
            src: finalImageUrl,
            is_primary: true,
            position: 1,
          }, { onConflict: 'product_id,position', ignoreDuplicates: false })
          
      }

      // Record the import row
      await supabase
        .from('catalog_import_rows')
        .insert({
          import_id: importId,
          product_id: product.id,
          row_index: i,
          raw_data: rawRow,
          status: 'imported',
        })

      imported++

      // Update progress every 10 rows
      if (imported % 10 === 0) {
        await supabase
          .from('catalog_imports')
          .update({ imported_rows: imported, failed_rows: failed, updated_at: new Date().toISOString() })
          .eq('id', importId)
      }
    } catch (err: any) {
      failed++
      errors.push({ row: i + 1, reason: err.message })
      try {
        await supabase
          .from('catalog_import_rows')
          .insert({
            import_id: importId,
            product_id: null,
            row_index: i,
            raw_data: rawRow,
            status: 'failed',
            error_msg: err.message,
          })
      } catch { /* non-fatal */ }
    }
  }

  // Final status update
  await supabase
    .from('catalog_imports')
    .update({
      imported_rows: imported,
      failed_rows: failed,
      status: failed === sheet.rows.length ? 'failed' : 'completed',
      error_report: errors.length > 0 ? errors : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', importId)

  return { imported, failed, errors }
}