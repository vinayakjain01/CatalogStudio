/**
 * Catalog Import Processor
 *
 * Takes parsed line-sheet rows and a column map, then:
 *  1. Creates/updates product rows in the `products` table
 *  2. Downloads images and uploads to Cloudinary
 *  3. Creates product_images rows
 *  4. Updates the catalog_import row with progress
 *  5. Creates catalog_import_rows for error reporting + output export
 *
 * The products table is exactly the same schema used by Shopify products.
 * No downstream code needs to know the source was a line sheet.
 */

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { autoMapColumns, applyColumnMap, serializeColumnMap } from './column-mapper'
import type { ParsedSheet } from './parser'
import { downloadImage, uploadImageToCloudinary } from './image-resolver'

export interface ImportOptions {
  storeId: string
  userId: string
  importId: string
  /** Override auto-detected column map with user-provided mapping */
  columnMapOverride?: Record<string, string | null>
  /** If false, skip image downloading (dry-run or preview) */
  downloadImages?: boolean
}

export interface ImportResult {
  imported: number
  failed: number
  errors: { row: number; reason: string }[]
}

/**
 * Process a parsed sheet and insert products into the DB.
 */
export async function processImport(
  sheet: ParsedSheet,
  options: ImportOptions,
  supabase: SupabaseClient
): Promise<ImportResult> {
  const {
    storeId,
    userId,
    importId,
    columnMapOverride,
    downloadImages = true,
  } = options

  // Determine column map
  let columnMap = autoMapColumns(sheet.headers)

  // Apply user overrides if provided
  if (columnMapOverride) {
    for (const [rawCol, canonical] of Object.entries(columnMapOverride)) {
      columnMap.set(rawCol, canonical as any)
    }
  }

  // Save column map to import row
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
      // Build product record
      const title = canonical.title || canonical.sku || `Row ${i + 1}`
      const sku = canonical.sku || ''
      const price = parseFloat(canonical.price?.replace(/[^0-9.]/g, '') || '0') || 0
      const compareAt = canonical.compare_at_price
        ? parseFloat(canonical.compare_at_price.replace(/[^0-9.]/g, '')) || null
        : null

      // Upsert product — use SKU as the external_id for idempotency
      // so re-importing the same file updates rather than duplicates
      const externalId = sku || `row_${importId}_${i}`
      const { data: product, error: productError } = await supabase
        .from('products')
        .upsert({
          store_id: storeId,
          external_id: externalId,
          title,
          vendor: canonical.vendor || null,
          product_type: canonical.product_type || null,
          tags: canonical.tags
            ? canonical.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
            : [],
          description: canonical.description || null,
          price,
          compare_at_price: compareAt,
          status: 'active',
          inventory_quantity: canonical.inventory_quantity
            ? parseInt(canonical.inventory_quantity, 10) || 0
            : 0,
          import_id: importId,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'store_id,external_id',
          ignoreDuplicates: false,
        })
        .select('id')
        .single()

      if (productError || !product) {
        throw new Error(productError?.message || 'Failed to upsert product')
      }

      // Handle product image
      if (canonical.image_url && downloadImages) {
        try {
          const imageHash = crypto
            .createHash('sha256')
            .update(canonical.image_url)
            .digest('hex')
            .slice(0, 16)

          // Check if image already uploaded for this product
          const { data: existingImage } = await supabase
            .from('product_images')
            .select('id')
            .eq('product_id', product.id)
            .eq('is_primary', true)
            .maybeSingle()

          if (!existingImage) {
            // Download and upload to Cloudinary
            const { buffer } = await downloadImage(canonical.image_url)
            const { url } = await uploadImageToCloudinary(
              buffer,
              `catalog-imports/${storeId}/${imageHash}`
            )

            await supabase
              .from('product_images')
              .upsert({
                product_id: product.id,
                src: url,
                is_primary: true,
                position: 1,
              }, { onConflict: 'product_id,position' })
          }
        } catch (imgErr: any) {
          // Image failure is non-fatal — product still imports, just no image
          console.warn(`[import] Image failed for row ${i}: ${imgErr.message}`)
        }
      }

      // Record import row
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
          .update({
            imported_rows: imported,
            failed_rows: failed,
            updated_at: new Date().toISOString(),
          })
          .eq('id', importId)
      }
    } catch (err: any) {
      failed++
      errors.push({ row: i + 1, reason: err.message })

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
    }
  }

  // Final update
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