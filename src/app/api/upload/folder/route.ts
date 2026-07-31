/**
 * Folder upload session lifecycle.
 *
 *   POST  /api/upload/folder   open a session   { folderName, totalFiles }
 *   PATCH /api/upload/folder   close a session  { importId, failed?, errors? }
 *
 * Opening a session reproduces exactly what the old Drive import did in its
 * first half — auto-create a `line_sheet` store named after the import, plus a
 * `catalog_imports` row to group the batch — but without downloading anything.
 * The images then stream in one request at a time via /api/upload/images.
 *
 * Splitting "open" from "upload" is what makes hundreds of images possible:
 * no single request has to carry the whole folder or outlive a function timeout.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { ACTIVE_STORE_COOKIE } from '@/lib/active-store'
import {
  LOCAL_FOLDER_SOURCE,
  countImportedRows,
  resolveUploadSession,
} from '@/lib/uploads/session'
import crypto from 'crypto'

export const dynamic = 'force-dynamic'

/** Keep auto-generated catalog names readable in the store switcher. */
function sanitizeFolderName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const folderName = sanitizeFolderName(body?.folderName)
  const totalFiles = Number.isFinite(body?.totalFiles) ? Math.max(0, Math.trunc(body.totalFiles)) : 0

  const admin = getAdminClient()

  // Date-stamped so repeated uploads stay tellable apart in the store switcher.
  const importDate = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
  const storeName = folderName
    ? `${folderName} — ${importDate}`
    : `Uploaded Products — ${importDate}`

  const { data: newStore, error: storeError } = await admin
    .from('stores')
    .insert({
      user_id: user.id,
      shop_name: storeName,
      display_name: storeName,
      shop_domain: `upload-${Date.now()}`,
      source: 'line_sheet',
      is_active: true,
      feed_token: crypto.randomUUID(),
    })
    .select('id')
    .single()

  if (storeError || !newStore) {
    return NextResponse.json({ error: 'Failed to create catalog' }, { status: 500 })
  }

  const storeId = newStore.id

  const { data: importRecord, error: importError } = await admin
    .from('catalog_imports')
    .insert({
      store_id: storeId,
      user_id: user.id,
      filename: folderName || 'uploaded-folder',
      source_url: `${LOCAL_FOLDER_SOURCE}://${folderName || 'folder'}`,
      status: 'processing',
      total_rows: totalFiles,
    })
    .select('id')
    .single()

  if (importError || !importRecord) {
    // Don't leave an orphan store behind if the import row failed.
    await admin.from('stores').delete().eq('id', storeId)
    return NextResponse.json({ error: 'Failed to create upload session' }, { status: 500 })
  }

  const res = NextResponse.json({
    importId: importRecord.id,
    storeId,
    storeName,
    total: totalFiles,
  })

  // Point the dashboard at the catalog we just created, so Products/Templates
  // show the uploaded items the moment the user navigates there. getActiveStore()
  // otherwise falls back to the OLDEST store, not this one.
  res.cookies.set(ACTIVE_STORE_COOKIE, storeId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })

  return res
}

/**
 * Finalise a session once the client has stopped uploading.
 *
 * `imported` is recounted from catalog_import_rows rather than trusted from the
 * request, because that count is what /api/catalog/export reports.
 */
export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const result = await resolveUploadSession(body?.importId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  const { admin, importId } = result.session

  const failed = Number.isFinite(body?.failed) ? Math.max(0, Math.trunc(body.failed)) : 0

  // Client-reported failures. Bounded and stringified because this lands in a
  // jsonb column that the Excel export reads back.
  const rawErrors: unknown[] = Array.isArray(body?.errors) ? body.errors.slice(0, 100) : []
  const errors = rawErrors
    .map(entry => {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      return {
        filename: String(e.filename ?? '').slice(0, 260),
        reason: String(e.reason ?? 'Unknown error').slice(0, 500),
      }
    })
    .filter(e => e.filename)

  const imported = await countImportedRows(admin, importId)

  await admin
    .from('catalog_imports')
    .update({
      status: imported === 0 && failed > 0 ? 'failed' : 'completed',
      imported_rows: imported,
      failed_rows: failed,
      error_report: errors.length ? errors : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', importId)

  return NextResponse.json({ importId, imported, failed })
}
