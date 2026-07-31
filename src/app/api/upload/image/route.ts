/**
 * DELETE /api/upload/image   { importId, productId }
 *
 * Removes one already-uploaded image from a session: its `product_images` rows,
 * its audit row, the product itself, and the backing Cloudinary asset.
 *
 * Used by the "remove" control on uploaded items. Removing an image BEFORE
 * upload never reaches the server — the client just drops it from the batch.
 */
import { NextRequest, NextResponse } from 'next/server'
import { deleteImageFromCloudinary } from '@/lib/catalog-import/image-storage'
import { countImportedRows, readRowData, resolveUploadSession } from '@/lib/uploads/session'

export const dynamic = 'force-dynamic'

export async function DELETE(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const productId = body?.productId

  if (typeof productId !== 'string' || !productId) {
    return NextResponse.json({ error: 'productId required' }, { status: 400 })
  }

  const result = await resolveUploadSession(body?.importId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  const { admin, importId, storeId } = result.session

  // Scope the product to BOTH the session's store and import so a valid session
  // can never be used to delete a product belonging to another catalog.
  const { data: product } = await admin
    .from('products')
    .select('id')
    .eq('id', productId)
    .eq('store_id', storeId)
    .eq('import_id', importId)
    .single()

  if (!product) {
    return NextResponse.json({ error: 'Product not found in this upload' }, { status: 404 })
  }

  // Read the Cloudinary id from the audit row before deleting it.
  const { data: rows } = await admin
    .from('catalog_import_rows')
    .select('id, raw_data')
    .eq('import_id', importId)
    .eq('product_id', productId)

  const cloudinaryIds = (rows ?? [])
    .map(row => readRowData(row.raw_data).cloudinary_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  await admin.from('catalog_import_rows').delete().eq('import_id', importId).eq('product_id', productId)
  await admin.from('product_images').delete().eq('product_id', productId)
  await admin.from('products').delete().eq('id', productId)

  // Best-effort storage cleanup — a Cloudinary failure must not resurrect a
  // product the user has already been told is gone.
  for (const cloudinaryId of cloudinaryIds) {
    try {
      await deleteImageFromCloudinary(cloudinaryId)
    } catch { /* orphaned asset is acceptable; the DB row is what users see */ }
  }

  const imported = await countImportedRows(admin, importId)
  await admin
    .from('catalog_imports')
    .update({ imported_rows: imported, updated_at: new Date().toISOString() })
    .eq('id', importId)

  return NextResponse.json({ success: true, productId, imported })
}
