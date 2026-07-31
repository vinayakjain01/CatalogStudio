'use client'

/**
 * Folder-upload orchestration.
 *
 * Owns the whole client side of the import: scanning the picked directory,
 * classifying and de-duplicating files, running a bounded parallel upload pool,
 * and handling cancel / retry / remove. The UI components read this state and
 * render it — they hold no upload logic of their own.
 *
 * Session shape mirrors the server: one `catalog_imports` row opened up front,
 * one request per image, one finalise call at the end.
 *
 * Item state lives in a ref that `setItems` mirrors for rendering. The upload
 * pool runs across hundreds of async callbacks and has to read the CURRENT
 * status of an item mid-flight; a plain state variable would hand those
 * callbacks a stale snapshot from whenever they were created.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { mapWithConcurrency } from '@/lib/concurrency'
import { prepareImageForUpload } from '@/lib/uploads/client-compress'
import {
  buildUniqueNames,
  isSupportedImageFile,
  isSystemOrHiddenPath,
} from '@/lib/uploads/image-files'
import type { PickedFile } from '@/lib/uploads/pick-files'

/** Parallel in-flight uploads. Enough to saturate a normal connection without
 *  tripping per-IP rate limits or starving the browser's connection pool. */
const UPLOAD_CONCURRENCY = 4

export type ItemStatus =
  | 'ready'      // selected, waiting for the user to start
  | 'duplicate'  // same file found twice in the folder tree — excluded by default
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'cancelled'

export interface UploadItem {
  id: string
  file: File
  /** Path inside the picked folder, e.g. "shirts/red-01.jpg". */
  relativePath: string
  /** Product title + SKU — unique within the batch. */
  productName: string
  previewUrl: string
  size: number
  width?: number
  height?: number
  status: ItemStatus
  error?: string
  productId?: string
  imageUrl?: string
}

export type Phase = 'idle' | 'scanning' | 'preview' | 'uploading' | 'done'

export interface ScanSummary {
  /** Files ignored for being an unsupported type (PDF, ZIP, video, text…). */
  unsupported: number
  /** Files ignored as OS/system/hidden entries. */
  system: number
  /** Exact repeats within the folder tree. */
  duplicates: number
  folderName: string
}

export interface UploadSession {
  importId: string
  storeId: string
  storeName: string
}

const EMPTY_SUMMARY: ScanSummary = { unsupported: 0, system: 0, duplicates: 0, folderName: '' }

export function useFolderUpload() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [items, setItems] = useState<UploadItem[]>([])
  const [summary, setSummary] = useState<ScanSummary>(EMPTY_SUMMARY)
  const [session, setSession] = useState<UploadSession | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef<UploadSession | null>(null)
  const itemsRef = useRef<UploadItem[]>([])
  /** Object URLs we created, so they can be revoked on unmount. */
  const objectUrlsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const urls = objectUrlsRef.current
    const abort = abortRef
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url))
      urls.clear()
      abort.current?.abort()
    }
  }, [])

  /** Single writer for item state — keeps the ref and the rendered copy in step. */
  const commit = useCallback((next: UploadItem[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  const patchItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    commit(itemsRef.current.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }, [commit])

  /** Record a decoded image's real dimensions once its thumbnail loads. */
  const setDimensions = useCallback((id: string, width: number, height: number) => {
    const target = itemsRef.current.find(item => item.id === id)
    if (!target || target.width !== undefined) return
    patchItem(id, { width, height })
  }, [patchItem])

  // ── Scan ────────────────────────────────────────────────────────────────────

  const selectFiles = useCallback((picked: PickedFile[] | null) => {
    if (!picked) return
    // An empty array still runs the scan, so an empty folder (or one holding
    // nothing but PDFs) reports why nothing happened instead of silently no-op'ing.

    setPhase('scanning')
    setFatalError(null)

    let unsupported = 0
    let system = 0
    let duplicates = 0

    // Identity for "the same file twice". Content hashing hundreds of large
    // files would stall the scan for tens of seconds; name+size+mtime catches
    // the real case (a folder copied into its own subfolder) instantly, and the
    // server's content-hashed public_id de-duplicates storage for the rest.
    const seen = new Set<string>()
    const accepted: { file: File; relativePath: string; isDuplicate: boolean }[] = []

    for (const { file, relativePath } of picked) {
      if (isSystemOrHiddenPath(relativePath)) { system++; continue }
      if (!isSupportedImageFile(file.name, file.type)) { unsupported++; continue }
      if (file.size === 0) { unsupported++; continue }

      const key = `${file.name}:${file.size}:${file.lastModified}`
      const isDuplicate = seen.has(key)
      if (isDuplicate) duplicates++
      seen.add(key)

      accepted.push({ file, relativePath, isDuplicate })
    }

    const names = buildUniqueNames(
      accepted.map(a => ({ relativePath: a.relativePath, name: a.file.name }))
    )

    const nextItems: UploadItem[] = accepted.map((entry, index) => {
      const previewUrl = URL.createObjectURL(entry.file)
      objectUrlsRef.current.add(previewUrl)

      return {
        id: `${index}-${entry.relativePath}`,
        file: entry.file,
        relativePath: entry.relativePath,
        productName: names[index],
        previewUrl,
        size: entry.file.size,
        status: entry.isDuplicate ? 'duplicate' : 'ready',
      }
    })

    // Root folder name — used to name the auto-created catalog.
    const firstPath = accepted[0]?.relativePath ?? ''
    const folderName = firstPath.includes('/') ? firstPath.split('/')[0] : ''

    commit(nextItems)
    setSummary({ unsupported, system, duplicates, folderName })
    setPhase(nextItems.length > 0 ? 'preview' : 'idle')

    if (nextItems.length === 0) {
      setFatalError(
        'No supported images found in that folder. Supported formats: JPG, PNG, WEBP, AVIF.'
      )
    }
  }, [commit])

  // ── Remove ──────────────────────────────────────────────────────────────────

  const removeItem = useCallback(async (id: string) => {
    const target = itemsRef.current.find(item => item.id === id)
    if (!target) return

    // Already in the database — delete it there too, not just from this list.
    if (target.status === 'uploaded' && target.productId && sessionRef.current) {
      patchItem(id, { status: 'uploading' })
      try {
        const res = await fetch('/api/upload/image', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            importId: sessionRef.current.importId,
            productId: target.productId,
          }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          patchItem(id, { status: 'uploaded', error: data.error || 'Could not remove' })
          return
        }
      } catch {
        patchItem(id, { status: 'uploaded', error: 'Could not remove — network error' })
        return
      }
    }

    URL.revokeObjectURL(target.previewUrl)
    objectUrlsRef.current.delete(target.previewUrl)
    commit(itemsRef.current.filter(item => item.id !== id))
  }, [patchItem, commit])

  /** Re-include a file that was auto-excluded as a duplicate. */
  const includeItem = useCallback((id: string) => {
    patchItem(id, { status: 'ready' })
  }, [patchItem])

  // ── Upload ──────────────────────────────────────────────────────────────────

  const uploadOne = useCallback(async (
    item: UploadItem,
    index: number,
    activeSession: UploadSession,
    signal: AbortSignal
  ) => {
    if (signal.aborted) {
      patchItem(item.id, { status: 'cancelled' })
      return
    }

    patchItem(item.id, { status: 'uploading', error: undefined })

    try {
      const { blob, filename } = await prepareImageForUpload(item.file)

      const form = new FormData()
      form.append('importId', activeSession.importId)
      form.append('storeId', activeSession.storeId)
      form.append('file', blob, filename)
      form.append('name', item.productName)
      form.append('relativePath', item.relativePath)
      form.append('index', String(index))

      const res = await fetch('/api/upload/images', { method: 'POST', body: form, signal })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error || `Upload failed (${res.status})`)
      }

      const fileResult = data.results?.[0]
      if (!fileResult?.success) {
        throw new Error(fileResult?.reason || 'Upload failed')
      }

      patchItem(item.id, {
        status: 'uploaded',
        productId: fileResult.product.id,
        imageUrl: fileResult.product.imageUrl,
        error: undefined,
      })
    } catch (err: any) {
      if (signal.aborted || err?.name === 'AbortError') {
        patchItem(item.id, { status: 'cancelled' })
        return
      }
      patchItem(item.id, { status: 'failed', error: err?.message || 'Upload failed' })
    }
  }, [patchItem])

  /** Close the session out, recording whatever failed. */
  const finalize = useCallback(async (activeSession: UploadSession) => {
    const failures = itemsRef.current.filter(item => item.status === 'failed')
    try {
      await fetch('/api/upload/folder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importId: activeSession.importId,
          failed: failures.length,
          errors: failures.map(f => ({ filename: f.relativePath, reason: f.error })),
        }),
      })
    } catch { /* the session row stays 'processing'; products are already created */ }
  }, [])

  const runUploads = useCallback(async (
    targets: UploadItem[],
    activeSession: UploadSession
  ) => {
    const controller = new AbortController()
    abortRef.current = controller

    await mapWithConcurrency(targets, UPLOAD_CONCURRENCY, (item, index) =>
      uploadOne(item, index, activeSession, controller.signal)
    )

    abortRef.current = null
    await finalize(activeSession)
    setPhase('done')
  }, [uploadOne, finalize])

  const startUpload = useCallback(async () => {
    const targets = itemsRef.current.filter(item => item.status === 'ready')
    if (targets.length === 0) return

    setFatalError(null)
    setPhase('uploading')

    let activeSession = sessionRef.current
    if (!activeSession) {
      try {
        const res = await fetch('/api/upload/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderName: summary.folderName,
            totalFiles: targets.length,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Could not start the upload')

        activeSession = {
          importId: data.importId,
          storeId: data.storeId,
          storeName: data.storeName,
        }
        sessionRef.current = activeSession
        setSession(activeSession)
      } catch (err: any) {
        setFatalError(err?.message || 'Could not start the upload')
        setPhase('preview')
        return
      }
    }

    await runUploads(targets, activeSession)
  }, [summary.folderName, runUploads])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    // Items still queued never reach uploadOne's guard once the pool unwinds,
    // so mark everything not yet settled here.
    commit(itemsRef.current.map(item =>
      item.status === 'ready' || item.status === 'uploading'
        ? { ...item, status: 'cancelled' as ItemStatus }
        : item
    ))
  }, [commit])

  const retryFailed = useCallback(async () => {
    const activeSession = sessionRef.current
    if (!activeSession) return

    const targets = itemsRef.current.filter(
      item => item.status === 'failed' || item.status === 'cancelled'
    )
    if (targets.length === 0) return

    setFatalError(null)
    setPhase('uploading')

    try {
      await fetch('/api/upload/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importId: activeSession.importId,
          filenames: targets.map(t => t.file.name),
        }),
      })
    } catch { /* accounting reset is best-effort; the re-upload is what matters */ }

    await runUploads(targets, activeSession)
  }, [runUploads])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    objectUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
    objectUrlsRef.current.clear()
    sessionRef.current = null
    commit([])
    setSummary(EMPTY_SUMMARY)
    setSession(null)
    setFatalError(null)
    setPhase('idle')
  }, [commit])

  // ── Derived counts ──────────────────────────────────────────────────────────

  const selectable = items.filter(i => i.status !== 'duplicate').length
  const uploaded = items.filter(i => i.status === 'uploaded').length
  const failed = items.filter(i => i.status === 'failed').length
  const cancelled = items.filter(i => i.status === 'cancelled').length
  const inFlight = items.filter(i => i.status === 'uploading').length
  const settled = uploaded + failed + cancelled

  return {
    phase,
    items,
    summary,
    session,
    fatalError,
    counts: {
      total: items.length,
      selectable,
      uploaded,
      failed,
      cancelled,
      inFlight,
      remaining: Math.max(0, selectable - settled),
      percent: selectable > 0 ? Math.round((settled / selectable) * 100) : 0,
    },
    selectFiles,
    removeItem,
    includeItem,
    setDimensions,
    startUpload,
    cancel,
    retryFailed,
    reset,
  }
}
