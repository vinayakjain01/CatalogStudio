/**
 * Google Drive Folder Scanner
 *
 * Scans a public Google Drive folder to get the list of image files.
 *
 * The fundamental challenge: Google Drive doesn't provide a public REST API
 * for listing folder contents without OAuth. However, the HTML page for a
 * publicly shared folder embeds file metadata as JSON in the page source.
 *
 * We parse that JSON to extract file IDs and filenames, then build
 * lh3.googleusercontent.com download URLs which bypass the virus-scan
 * redirect that plagues uc?export=download.
 *
 * SKU matching strategy for this dataset:
 *   'GND/1043' → normalize → 'gnd 1043' → matches 'GND-1043.jpg' → 'gnd 1043'
 *   'GND/ LFWR - 01' → normalize → 'gnd lfwr 01' → matches 'GND-LFWR-01.jpg'
 *   'GND871B' → normalize → 'gnd871b' → matches 'GND871B.jpg'
 */

export interface DriveFolderFile {
  fileId: string
  filename: string            // original: "GND-1043.jpg"
  baseName: string            // without ext: "GND-1043"
  normalizedName: string      // fuzzy key: "gnd 1043"
  downloadUrl: string         // lh3.googleusercontent.com/d/{id}=s0
  driveViewUrl: string
}

/**
 * Normalize any identifier (SKU or filename base) to a fuzzy-match key.
 * Converts ALL separators (/, -, _, space) to single spaces, lowercases.
 *
 * 'GND/1043'       → 'gnd 1043'
 * 'GND-1043'       → 'gnd 1043'
 * 'GND/ LFWR - 01' → 'gnd lfwr 01'
 * 'GND871B'        → 'gnd871b'
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

/**
 * Scan a public Google Drive folder.
 * Returns all image files found with their file IDs and normalized names.
 */
export async function scanDriveFolder(folderUrl: string): Promise<DriveFolderFile[]> {
  const folderId = extractFolderIdFromUrl(folderUrl)
  if (!folderId) throw new Error(`Not a valid Google Drive folder URL: ${folderUrl}`)

  // Fetch the folder HTML page
  const res = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    redirect: 'follow',
  })

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('Drive folder is not publicly accessible. Set sharing to "Anyone with the link can view".')
    }
    throw new Error(`Drive folder returned HTTP ${res.status}`)
  }

  const html = await res.text()
  const files = parseFilesFromDriveHtml(html)

  if (files.length === 0) {
    // The HTML parsing may fail if Google changes their page structure.
    // In that case, tell the user what happened.
    throw new Error(
      'Could not read file list from Drive folder. ' +
      'Make sure: (1) folder is shared as "Anyone with the link can view", ' +
      '(2) it contains image files (.jpg/.png/.webp), ' +
      '(3) the link is a folder link, not a file link.'
    )
  }

  return files
}

function parseFilesFromDriveHtml(html: string): DriveFolderFile[] {
  const files: DriveFolderFile[] = []
  const seen = new Set<string>()

  // Google Drive embeds file data in several JSON structures in the page HTML.
  // We use multiple patterns to maximize coverage across Drive's HTML variations.

  // Pattern 1: JSON array entries that look like ["FILENAME.ext","FILE_ID","mime/type",...]
  // The file ID is a 28-44 char base64url string
  const p1 = /"([^"]{1,120}\.(jpe?g|png|webp|gif|JPE?G|PNG|WEBP|GIF))","([a-zA-Z0-9_-]{25,})"(?:,"([^"]*)")?/g
  let m: RegExpExecArray | null
  while ((m = p1.exec(html)) !== null) {
    const filename = m[1]
    const fileId = m[3]
    if (!seen.has(fileId)) {
      seen.add(fileId)
      files.push(buildFile(fileId, filename))
    }
  }

  // Pattern 2: reversed order ["FILE_ID","FILENAME.ext"]
  const p2 = /"([a-zA-Z0-9_-]{25,})","([^"]{1,120}\.(jpe?g|png|webp|gif))"/gi
  while ((m = p2.exec(html)) !== null) {
    const fileId = m[1]
    const filename = m[2]
    if (!seen.has(fileId)) {
      seen.add(fileId)
      files.push(buildFile(fileId, filename))
    }
  }

  // Pattern 3: data-id attributes (older Drive HTML)
  const p3 = /data-id="([a-zA-Z0-9_-]{25,})"[^>]*title="([^"]{1,120}\.(jpe?g|png|webp|gif))"/gi
  while ((m = p3.exec(html)) !== null) {
    const fileId = m[1]
    const filename = m[2]
    if (!seen.has(fileId)) {
      seen.add(fileId)
      files.push(buildFile(fileId, filename))
    }
  }

  return files
}

function buildFile(fileId: string, filename: string): DriveFolderFile {
  const baseName = filename.replace(/\.[^.]+$/, '')
  return {
    fileId,
    filename,
    baseName,
    normalizedName: normalizeName(baseName),
    downloadUrl: `https://lh3.googleusercontent.com/d/${fileId}=s0`,
    driveViewUrl: `https://drive.google.com/file/d/${fileId}/view`,
  }
}

// ─── SKU ↔ File matching ──────────────────────────────────────────────────────

export interface MatchResult {
  matched: Map<string, DriveFolderFile>   // sku → file
  unmatched: string[]                      // SKUs with no image
  unmatchedFiles: DriveFolderFile[]        // files with no SKU
}

/**
 * Match a list of SKUs against Drive files by normalized name comparison.
 *
 * Two-pass algorithm:
 *  1. Exact normalized match  ('gnd 1043' === 'gnd 1043')
 *  2. Contains match          ('gnd 1043' is contained in 'gnd 1043 front')
 *
 * This handles:
 *  GND/1043  → GND-1043.jpg      ✓ (exact after normalization)
 *  GND/ LFWR - 01 → GND-LFWR-01.jpg  ✓
 *  GND871B   → GND871B.jpg       ✓
 */
export function matchSkusToFiles(
  skus: string[],
  files: DriveFolderFile[]
): MatchResult {
  const matched = new Map<string, DriveFolderFile>()
  const usedIds = new Set<string>()

  // Build lookup: normalizedName → file
  const byNorm = new Map<string, DriveFolderFile>()
  // Also: normalized without spaces → file (for GND871B style)
  const byNormNoSpace = new Map<string, DriveFolderFile>()
  for (const f of files) {
    byNorm.set(f.normalizedName, f)
    byNormNoSpace.set(f.normalizedName.replace(/\s+/g, ''), f)
  }

  for (const sku of skus) {
    const norm = normalizeName(sku)
    const normNoSp = norm.replace(/\s+/g, '')

    // Pass 1: exact
    let hit = byNorm.get(norm) ?? byNormNoSpace.get(normNoSp)

    // Pass 2: contains (file name contains the SKU or vice versa)
    if (!hit) {
      for (const f of files) {
        if (usedIds.has(f.fileId)) continue
        const fn = f.normalizedName
        const fnNoSp = fn.replace(/\s+/g, '')
        if (fn.includes(norm) || norm.includes(fn) ||
            fnNoSp.includes(normNoSp) || normNoSp.includes(fnNoSp)) {
          hit = f
          break
        }
      }
    }

    if (hit && !usedIds.has(hit.fileId)) {
      matched.set(sku, hit)
      usedIds.add(hit.fileId)
    }
  }

  return {
    matched,
    unmatched: skus.filter(s => !matched.has(s)),
    unmatchedFiles: files.filter(f => !usedIds.has(f.fileId)),
  }
}