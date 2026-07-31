/**
 * POST /api/upload/retry   { importId, filenames?: string[] }
 *
 * Reopens a finalised session so the client can re-send the images that failed.
 *
 * The server holds no copy of a failed file — the bytes never made it past the
 * network error — so the retry itself is the client re-POSTing to
 * /api/upload/images. What this endpoint does is reset the session's accounting:
 * status back to `processing`, failure tally and stale error report cleared, so
 * a session that finished as `failed` isn't frozen that way after a good retry.
 *
 * Re-importing an image cleanly is handled at the write site — /api/upload/images
 * replaces a product's audit row rather than adding one — so there is nothing to
 * clean up here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { countImportedRows, resolveUploadSession } from '@/lib/uploads/session'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))

  const result = await resolveUploadSession(body?.importId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  const { admin, importId } = result.session

  const filenames: string[] = Array.isArray(body?.filenames)
    ? body.filenames.filter((f: unknown): f is string => typeof f === 'string' && !!f).slice(0, 1000)
    : []

  const imported = await countImportedRows(admin, importId)

  const { data: record } = await admin
    .from('catalog_imports')
    .update({
      status: 'processing',
      imported_rows: imported,
      failed_rows: 0,
      error_report: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', importId)
    .select('total_rows')
    .single()

  return NextResponse.json({
    importId,
    imported,
    total: record?.total_rows ?? 0,
    retrying: filenames.length,
  })
}
