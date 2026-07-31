/**
 * Shared rules for classifying files picked out of a local folder.
 *
 * Deliberately dependency-free so the SAME predicates run in the browser
 * (scanning the directory the user picked) and on the server (validating what
 * actually arrived). If these ever diverge, the client silently offers files
 * the API will reject — so keep every rule here, not in either caller.
 */

/** Extensions we import. AVIF included — Cloudinary stores it natively. */
export const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const

/** MIME types the browser reports for the extensions above. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const

/**
 * Browser request-body ceiling we upload against.
 *
 * Vercel caps serverless function request bodies at ~4.5 MB, so anything larger
 * is downscaled client-side before it is ever POSTed. The server keeps its own
 * 9.8 MB Cloudinary ladder as a second line of defence (see image-storage.ts).
 */
export const CLIENT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024

/** Accept attribute for the directory picker. */
export const IMAGE_ACCEPT_ATTRIBUTE = SUPPORTED_IMAGE_MIME_TYPES.join(',')

/** Lowercase extension without the dot, or '' when there is none. */
export function fileExtension(name: string): string {
  const match = /\.([^./\\]+)$/.exec(name)
  return match ? match[1].toLowerCase() : ''
}

/** Final path segment, tolerating both POSIX and Windows separators. */
export function baseName(path: string): string {
  const segments = path.split(/[/\\]/)
  return segments[segments.length - 1] || path
}

/** Strip a single trailing extension: "red-dress.v2.jpg" → "red-dress.v2". */
export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

/**
 * OS bookkeeping that appears inside almost every real folder and must never
 * become a product. Matches on ANY path segment, because a nested
 * `shirts/.DS_Store` is just as unwanted as a top-level one.
 */
export function isSystemOrHiddenPath(relativePath: string): boolean {
  const segments = relativePath.split(/[/\\]/).filter(Boolean)

  return segments.some(segment => {
    if (segment.startsWith('.')) return true                 // .DS_Store, .git, dotfolders
    if (segment.startsWith('~$')) return true                // Office lock files
    const lower = segment.toLowerCase()
    return (
      lower === '__macosx' ||
      lower === 'thumbs.db' ||
      lower === 'desktop.ini' ||
      lower === 'ehthumbs.db' ||
      lower === 'node_modules'
    )
  })
}

/**
 * Is this a product image we should import?
 *
 * Extension is the primary signal and MIME the secondary one: folder uploads on
 * Linux and older Windows builds frequently report an empty `File.type`, so a
 * MIME-only check would drop valid images. When a MIME type IS present and
 * clearly says non-image (application/pdf, video/mp4), we reject regardless of
 * how the file is named.
 */
export function isSupportedImageFile(name: string, mimeType?: string): boolean {
  const ext = fileExtension(name)
  const extOk = (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)

  if (!mimeType) return extOk

  const mime = mimeType.toLowerCase()
  if (mime && !mime.startsWith('image/')) return false
  if ((SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return true

  return extOk
}

/**
 * Turn a filename into a product title/SKU: drop the extension, collapse the
 * separator soup real catalog exports contain, and trim.
 *
 * "  RED-DRESS_front__01.jpg " → "RED-DRESS front 01"
 */
export function toProductName(fileName: string): string {
  return stripExtension(baseName(fileName))
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Assign a unique SKU to every file in one import batch.
 *
 * Nested folders routinely repeat basenames (`shirts/01.jpg`, `pants/01.jpg`).
 * `products` is uniquely keyed on (store_id, sku) and the import upserts on that
 * key — so without disambiguation the second file would silently OVERWRITE the
 * first and the user would lose an image with no error. Resolution order:
 *   1. bare filename
 *   2. parent folder prefixed  ("shirts 01")
 *   3. numeric suffix          ("01 2")
 */
export function buildUniqueNames(
  files: { relativePath: string; name: string }[]
): string[] {
  const taken = new Set<string>()

  return files.map(file => {
    const base = toProductName(file.name) || 'image'

    const candidates = [base]

    const segments = file.relativePath.split(/[/\\]/).filter(Boolean)
    const parent = segments.length > 1 ? segments[segments.length - 2] : ''
    if (parent) {
      candidates.push(`${toProductName(parent)} ${base}`.replace(/\s+/g, ' ').trim())
    }

    for (const candidate of candidates) {
      const key = candidate.toLowerCase()
      if (!taken.has(key)) {
        taken.add(key)
        return candidate
      }
    }

    let counter = 2
    while (taken.has(`${base} ${counter}`.toLowerCase())) counter++
    const unique = `${base} ${counter}`
    taken.add(unique.toLowerCase())
    return unique
  })
}

/** Human-readable byte size for the preview grid. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
