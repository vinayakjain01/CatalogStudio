/**
 * POST /api/catalog/import
 *
 * Accepts either:
 *   - multipart/form-data with a `file` field (Excel/CSV upload)
 *   - JSON body { url: string } (Google Sheets / Drive URL)
 *
 * Query param ?preview=true returns parsed headers + sample rows + auto-detected
 * column map WITHOUT actually importing (for the column mapping UI step).
 *
 * Without ?preview, performs the full import.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { parseLineSheet } from '@/lib/catalog-import/parser'
import { processImport } from '@/lib/catalog-import/processor'
import { fetchFromUrl } from '@/lib/catalog-import/google-fetcher'
import { autoMapColumns, serializeColumnMap } from '@/lib/catalog-import/column-mapper'
import { extractEmbeddedImages, toRowImageMap } from '@/lib/catalog-import/image-extractor'

export const maxDuration = 300  // 5 min for large files

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isPreview = request.nextUrl.searchParams.get('preview') === 'true'
  const contentType = request.headers.get('content-type') || ''

  let fileBuffer: Buffer
  let filename = 'upload'
  let storeId: string | null = null
  let columnMapOverride: Record<string, string | null> | undefined

  // ── Parse request ──────────────────────────────────────────────────────────
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    storeId = formData.get('store_id') as string | null
    const colMapStr = formData.get('column_map') as string | null
    if (colMapStr) columnMapOverride = JSON.parse(colMapStr)

    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const arrayBuffer = await file.arrayBuffer()
    fileBuffer = Buffer.from(arrayBuffer)
    filename = file.name
  } else {
    const body = await request.json()
    storeId = body.store_id
    columnMapOverride = body.column_map

    if (body.url) {
      const fetched = await fetchFromUrl(body.url)
      fileBuffer = fetched.buffer
      filename = fetched.filename
    } else {
      return NextResponse.json({ error: 'Either file or url required' }, { status: 400 })
    }
  }

  if (!storeId) return NextResponse.json({ error: 'store_id required' }, { status: 400 })

  // Verify the store belongs to this user
  const { data: store } = await supabase
    .from('stores')
    .select('id, source')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  // ── Parse the file ─────────────────────────────────────────────────────────
  let sheet
  try {
    sheet = parseLineSheet(fileBuffer)
  } catch (err: any) {
    return NextResponse.json({ error: `Parse error: ${err.message}` }, { status: 422 })
  }

  // ── Pull out any images pasted/inserted directly into cells ───────────────
  // (only meaningful for .xlsx — CSV can't carry image bytes at all, and
  // Google Sheet URLs are now fetched as .xlsx specifically for this reason)
  const isXlsx = filename.toLowerCase().endsWith('.xlsx') ||
    contentType.includes('spreadsheetml')
  const embeddedImages = isXlsx
    ? toRowImageMap(await extractEmbeddedImages(fileBuffer, sheet.sheetName).catch(err => {
        console.warn(`[import] Embedded image extraction failed: ${err.message}`)
        return []
      }))
    : new Map()

  // ── Preview mode: return headers + sample + column map ────────────────────
  if (isPreview) {
    const detectedMap = autoMapColumns(sheet.headers)
    return NextResponse.json({
      headers: sheet.headers,
      sampleRows: sheet.rows.slice(0, 3),
      totalRows: sheet.rows.length,
      sheetName: sheet.sheetName,
      detectedColumnMap: serializeColumnMap(detectedMap),
      embeddedImagesFound: embeddedImages.size,
    })
  }

  // ── Full import ────────────────────────────────────────────────────────────
  const admin = getAdminClient()

  // Create import record
  const { data: importRecord, error: importErr } = await admin
    .from('catalog_imports')
    .insert({
      store_id: storeId,
      user_id: user.id,
      filename,
      status: 'pending',
      total_rows: sheet.rows.length,
    })
    .select('id')
    .single()

  if (importErr || !importRecord) {
    return NextResponse.json({ error: 'Failed to create import record' }, { status: 500 })
  }

  // Run import (synchronous for now — background worker for large files)
  // For files > 100 rows, a BullMQ job would be better; this handles up to ~500 rows
  // within Vercel's 5-minute timeout
  try {
    const result = await processImport(sheet, {
      storeId,
      userId: user.id,
      importId: importRecord.id,
      columnMapOverride,
      downloadImages: true,
      embeddedImages,
    }, admin)

    return NextResponse.json({
      importId: importRecord.id,
      imported: result.imported,
      failed: result.failed,
      errors: result.errors.slice(0, 20),  // cap error detail in response
      message: `Imported ${result.imported} products${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
    })
  } catch (err: any) {
    await admin
      .from('catalog_imports')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', importRecord.id)

    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}