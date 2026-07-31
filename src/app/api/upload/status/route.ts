/**
 * GET /api/upload/status?importId=...
 *
 * Server-side truth for an upload session's progress. The client tracks its own
 * per-file state for the live progress bar; this endpoint is what survives a
 * refresh, a second tab, or a crashed upload — and what the success screen uses
 * to confirm what actually landed in the database.
 */
import { NextRequest, NextResponse } from 'next/server'
import { countImportedRows, resolveUploadSession } from '@/lib/uploads/session'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const importId = request.nextUrl.searchParams.get('importId')

  const result = await resolveUploadSession(importId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  const { admin, importId: id, storeId } = result.session

  const { data: record } = await admin
    .from('catalog_imports')
    .select('status, total_rows, imported_rows, failed_rows, error_report, filename, updated_at')
    .eq('id', id)
    .single()

  const imported = await countImportedRows(admin, id)
  const total = record?.total_rows ?? 0
  const failed = record?.failed_rows ?? 0

  return NextResponse.json({
    importId: id,
    storeId,
    filename: record?.filename ?? null,
    status: record?.status ?? 'processing',
    total,
    imported,
    failed,
    remaining: Math.max(0, total - imported - failed),
    percent: total > 0 ? Math.round((imported / total) * 100) : 0,
    errors: record?.error_report ?? null,
    updatedAt: record?.updated_at ?? null,
  })
}
