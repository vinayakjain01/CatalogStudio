/**
 * Google Drive Folder Scanner — Drive API v3
 *
 * WHY THIS REWRITE
 * ────────────────
 * The previous version scraped Google Drive's folder HTML page.
 * This stopped working because:
 *   1. Google's servers return 403 to non-browser User-Agents
 *   2. Even when the HTML arrives, Google frequently changes its structure,
 *      causing the regex patterns to match nothing
 *   3. The lh3.googleusercontent.com download URL only works in a browser
 *      session context — server-side fetches get 403 or a login redirect
 *
 * THE FIX
 * ───────
 * Use the official Google Drive API v3 `files.list` endpoint.
 * - Works reliably for any folder shared as "Anyone with the link can view"
 * - Returns exact file names, MIME types, and IDs via JSON
 * - Paginated — handles folders with thousands of images
 * - No OAuth needed — a simple unrestricted API key is enough
 * - Download URLs use the authenticated `alt=media` pattern
 *
 * SETUP (one-time, ~2 minutes)
 * ─────────────────────────────
 * 1. Go to https://console.cloud.google.com/apis/credentials
 * 2. Create/select a project → APIs & Services → Library
 * 3. Search "Google Drive API" → Enable
 * 4. Credentials → Create Credentials → API Key
 * 5. (Optional) Restrict key to "Google Drive API" HTTP requests
 * 6. Add to Vercel env vars AND your droplet .env:
 *        GOOGLE_DRIVE_API_KEY=AIza...
 *
 * BACKWARD COMPATIBILITY
 * ──────────────────────
 * This module keeps the same exported interface as the old scanner:
 *   - DriveFolderFile (same shape, same fields)
 *   - scanDriveFolder()
 *   - matchSkusToFiles()
 *   - normalizeName()
 * No changes needed to route.ts or map-images/route.ts.
 */

export interface DriveFolderFile {
  fileId: string
  filename: string            // "DVPS001 - PURPLE.jpg"
  baseName: string            // "DVPS001 - PURPLE"
  normalizedName: string      // "dvps001 purple" (fuzzy match key)
  downloadUrl: string         // googleapis.com alt=media URL (needs API key)
  driveViewUrl: string        // human-visible Drive link
  mimeType: string
}

export interface MatchResult {
  matched: Map<string, DriveFolderFile>   // sku/matchKey → best file
  unmatched: string[]                      // identifiers with no image found
  unmatchedFiles: DriveFolderFile[]        // images with no matching product
}

// ─── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize any string to a fuzzy match key.
 * Replaces all separators (/ - _ . space) with single spaces, lowercases.
 *
 * 'GND/1043'        → 'gnd 1043'
 * 'DVPS001-PURPLE'  → 'dvps001 purple'
 * 'GND/ LFWR - 01'  → 'gnd lfwr 01'
 * 'GND871B'         → 'gnd871b'
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\/\-_\.\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractFolderIdFromUrl(url: string): string | null {
  const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}

// ─── Scanner ────────────────────────────────────────────────────────────────────

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml',
])

/**
 * Scan a public Google Drive folder and return all image files.
 *
 * Requires GOOGLE_DRIVE_API_KEY env var.
 * Falls back to a helpful error message if the key is missing.
 */
export async function scanDriveFolder(folderUrl: string): Promise<DriveFolderFile[]> {
  const folderId = extractFolderIdFromUrl(folderUrl)
  if (!folderId) {
    throw new Error(
      `Invalid Google Drive folder URL: "${folderUrl}". ` +
      `Expected format: https://drive.google.com/drive/folders/FOLDER_ID`
    )
  }

  const apiKey = process.env.GOOGLE_DRIVE_API_KEY
  if (!apiKey) {
    throw new Error(
      'GOOGLE_DRIVE_API_KEY is not configured. ' +
      'Go to console.cloud.google.com → Enable "Google Drive API" → Create API Key → ' +
      'add GOOGLE_DRIVE_API_KEY to your Vercel environment variables and droplet .env. ' +
      'This is a one-time 2-minute setup.'
    )
  }

  return await listAllImagesInFolder(folderId, apiKey)
}

async function listAllImagesInFolder(
  folderId: string,
  apiKey: string
): Promise<DriveFolderFile[]> {
  const files: DriveFolderFile[] = []
  let pageToken: string | undefined

  // Drive API: list all files in the folder, filtering to image MIME types
  // The `(mimeType contains 'image/')` query is more reliable than listing
  // specific MIME types since Drive auto-detects the correct type on upload.
  const query = `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`

  do {
    const params = new URLSearchParams({
      q: query,
      key: apiKey,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: '1000',
      orderBy: 'name',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const url = `https://www.googleapis.com/drive/v3/files?${params}`
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const msg: string = body?.error?.message ?? res.statusText

      if (res.status === 400 && msg.includes('Invalid Value')) {
        throw new Error(
          'Invalid Google Drive folder URL. ' +
          'Make sure you\'re using a folder link (not a file link): ' +
          'https://drive.google.com/drive/folders/FOLDER_ID'
        )
      }
      if (res.status === 403) {
        const hint = msg.includes('API key')
          ? 'Your API key is invalid or has expired.'
          : msg.includes('not been used') || msg.includes('disabled')
            ? 'The Google Drive API is not enabled on your API key. Enable it at console.cloud.google.com → APIs & Services → Library → Google Drive API.'
            : 'The folder is not publicly accessible. Set sharing to "Anyone with the link can view".'
        throw new Error(`Drive API access denied: ${hint}`)
      }
      if (res.status === 404) {
        throw new Error(
          'Folder not found. Check the folder link is correct and shared publicly.'
        )
      }
      throw new Error(`Drive API error (HTTP ${res.status}): ${msg}`)
    }

    const data = await res.json()

    for (const f of (data.files ?? [])) {
      if (!IMAGE_MIMES.has(f.mimeType)) continue
      const baseName = f.name.replace(/\.[^.]+$/, '')
      files.push({
        fileId: f.id,
        filename: f.name,
        baseName,
        normalizedName: normalizeName(baseName),
        // Drive API authenticated download — works for files shared as "anyone with link"
        downloadUrl: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${apiKey}`,
        driveViewUrl: `https://drive.google.com/file/d/${f.id}/view`,
        mimeType: f.mimeType,
      })
    }

    pageToken = data.nextPageToken
  } while (pageToken)

  if (files.length === 0) {
    throw new Error(
      'No image files found in the Drive folder. ' +
      'Make sure the folder contains .jpg, .png, or .webp files ' +
      'and is shared as "Anyone with the link can view".'
    )
  }

  return files
}

// ─── Matching ────────────────────────────────────────────────────────────────────

/**
 * Match a list of identifiers (SKUs, or composite "sku color" keys) to
 * Drive image files using a multi-level normalized fuzzy match.
 *
 * Matching levels (in priority order):
 *   1. Exact normalized match:  "dvps001 purple" === "dvps001 purple"
 *   2. Identifier contained in filename: "dvps001" found inside "dvps001 purple front"
 *   3. Filename base contained in identifier (handles when filename is longer)
 *
 * One file is consumed per identifier (first-wins for level 1).
 * Multiple files CAN match the same identifier (e.g. front/back shots) — this
 * returns the BEST single match; use matchIdentifiersToMultipleFiles() for
 * one-to-many.
 *
 * identifiers: flat string array, each entry normalized before matching.
 *   Simple: ['DVPS001', 'DVPS002']
 *   Composite: ['dvps001 purple', 'dvps001 orange']  (built by caller)
 */
export function matchSkusToFiles(
  identifiers: string[],
  files: DriveFolderFile[]
): MatchResult {
  const matched = new Map<string, DriveFolderFile>()
  const usedIds = new Set<string>()

  // Build fast lookup tables
  const byExact = new Map<string, DriveFolderFile>()
  const byNoSpace = new Map<string, DriveFolderFile>()
  for (const f of files) {
    byExact.set(f.normalizedName, f)
    byNoSpace.set(f.normalizedName.replace(/\s+/g, ''), f)
  }

  for (const identifier of identifiers) {
    const norm = normalizeName(identifier)
    const normNoSp = norm.replace(/\s+/g, '')

    // Level 1: exact normalized match
    let hit = byExact.get(norm) ?? byNoSpace.get(normNoSp)
    if (hit && usedIds.has(hit.fileId)) hit = undefined

    // Level 2: substring match
    if (!hit) {
      for (const f of files) {
        if (usedIds.has(f.fileId)) continue
        const fn = f.normalizedName
        const fnNoSp = fn.replace(/\s+/g, '')
        if (
          fn.includes(norm) ||
          norm.includes(fn) ||
          fnNoSp.includes(normNoSp) ||
          normNoSp.includes(fnNoSp)
        ) {
          hit = f
          break
        }
      }
    }

    if (hit && !usedIds.has(hit.fileId)) {
      matched.set(identifier, hit)
      usedIds.add(hit.fileId)
    }
  }

  return {
    matched,
    unmatched: identifiers.filter(id => !matched.has(id)),
    unmatchedFiles: files.filter(f => !usedIds.has(f.fileId)),
  }
}

/**
 * One-to-many variant: returns ALL Drive files that match each identifier.
 * Used when products have multiple images (front/back/detail shots).
 */
export function matchIdentifiersToMultipleFiles(
  identifiers: string[],
  files: DriveFolderFile[]
): Map<string, DriveFolderFile[]> {
  const result = new Map<string, DriveFolderFile[]>()

  for (const identifier of identifiers) {
    const norm = normalizeName(identifier)
    const normNoSp = norm.replace(/\s+/g, '')
    const hits: DriveFolderFile[] = []

    for (const f of files) {
      const fn = f.normalizedName
      const fnNoSp = fn.replace(/\s+/g, '')
      if (
        fn === norm ||
        fn.includes(norm) ||
        norm.includes(fn) ||
        fnNoSp.includes(normNoSp) ||
        normNoSp.includes(fnNoSp)
      ) {
        hits.push(f)
      }
    }

    if (hits.length > 0) {
      result.set(identifier, hits)
    }
  }

  return result
}