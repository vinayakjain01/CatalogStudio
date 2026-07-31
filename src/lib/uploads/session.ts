/**
 * Upload session helpers.
 *
 * A folder upload spans many HTTP requests: one to open the session, one per
 * image, plus status/delete/retry calls. Every one of those carries an
 * `importId` supplied by the CLIENT, so each must independently prove the
 * caller owns that import before touching a row.
 *
 * The old Drive route needed none of this — it created the store inside the
 * single request that used it. Splitting the flow across requests is what makes
 * this guard mandatory.
 */
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Prefix for the Cloudinary public_id namespace of folder-uploaded images. */
export const UPLOAD_CLOUDINARY_PREFIX = 'folder-uploads'

/** Marker stored in `catalog_imports.source_url` for locally uploaded batches. */
export const LOCAL_FOLDER_SOURCE = 'local-folder'

export interface UploadSession {
  userId: string
  importId: string
  storeId: string
  admin: SupabaseClient
}

/**
 * Shape written into `catalog_import_rows.raw_data` by /api/upload/images.
 *
 * Every field is optional because the column is untyped jsonb shared with the
 * older import paths — rows written before a field existed simply lack it.
 */
export interface ImportRowData {
  filename?: string
  relative_path?: string
  content_hash?: string
  cloudinary_url?: string
  cloudinary_id?: string
  bytes?: number
  content_type?: string
}

/** Narrow an untyped jsonb value to the fields we write. */
export function readRowData(raw: unknown): ImportRowData {
  return (raw && typeof raw === 'object' ? raw : {}) as ImportRowData
}

export type SessionResult =
  | { ok: true; session: UploadSession }
  | { ok: false; error: string; status: number }

/**
 * Resolve + authorise an upload session.
 *
 * Checks, in order: authenticated user → import exists and belongs to them →
 * the import's store also belongs to them. The second store check is not
 * redundant: it stops a caller from pairing their own import with someone
 * else's store id, which would write products into a foreign catalog.
 */
export async function resolveUploadSession(
  importId: unknown,
  expectedStoreId?: unknown
): Promise<SessionResult> {
  if (typeof importId !== 'string' || !importId) {
    return { ok: false, error: 'importId required', status: 400 }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Unauthorized', status: 401 }

  const admin = getAdminClient()

  const { data: importRecord } = await admin
    .from('catalog_imports')
    .select('id, user_id, store_id')
    .eq('id', importId)
    .single()

  if (!importRecord || importRecord.user_id !== user.id) {
    return { ok: false, error: 'Upload session not found', status: 404 }
  }

  if (expectedStoreId && importRecord.store_id !== expectedStoreId) {
    return { ok: false, error: 'Store does not match this upload session', status: 403 }
  }

  const { data: store } = await admin
    .from('stores')
    .select('id')
    .eq('id', importRecord.store_id)
    .eq('user_id', user.id)
    .single()

  if (!store) {
    return { ok: false, error: 'Catalog not found', status: 404 }
  }

  return {
    ok: true,
    session: {
      userId: user.id,
      importId: importRecord.id,
      storeId: importRecord.store_id,
      admin,
    },
  }
}

/**
 * Recount a session's rows straight from `catalog_import_rows`.
 *
 * The DB is the source of truth for "imported" rather than a client tally —
 * a cancelled tab, a duplicate retry, or a mid-flight refresh all leave the
 * client's own counter wrong, and this is what the Excel export reads.
 */
export async function countImportedRows(
  admin: SupabaseClient,
  importId: string
): Promise<number> {
  const { count } = await admin
    .from('catalog_import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', importId)
    .eq('status', 'imported')

  return count ?? 0
}
