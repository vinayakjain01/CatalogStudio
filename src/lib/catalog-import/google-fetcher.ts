/**
 * Google Sheets + Google Drive Fetcher
 *
 * Converts Google Sheets sharing links and Drive file links into
 * downloadable CSV/Excel buffers without requiring OAuth credentials.
 *
 * This works for publicly shared files and "anyone with link" files.
 * For private files, users should download and upload directly.
 *
 * Supported URL formats:
 *  - https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=0
 *  - https://docs.google.com/spreadsheets/d/SHEET_ID/view
 *  - https://drive.google.com/file/d/FILE_ID/view
 *  - https://drive.google.com/open?id=FILE_ID
 */

export type FetchedFile = {
  buffer: Buffer
  filename: string
  mimeType: string
}

function extractGoogleSheetsId(url: string): string | null {
  const match = url.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  return match ? match[1] : null
}

function extractDriveFileId(url: string): string | null {
  const fileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/)
  if (fileMatch) return fileMatch[1]

  const openMatch = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/)
  if (openMatch) return openMatch[1]

  const ucMatch = url.match(/drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]+)/)
  if (ucMatch) return ucMatch[1]

  return null
}

/**
 * Fetch a Google Sheets file as CSV.
 * Works for publicly shared sheets (anyone with link can view).
 */
export async function fetchGoogleSheet(url: string): Promise<FetchedFile> {
  const sheetId = extractGoogleSheetsId(url)
  if (!sheetId) {
    throw new Error(`Invalid Google Sheets URL: ${url}`)
  }

  // Parse gid (tab ID) from URL if present
  const gidMatch = url.match(/[#&?]gid=(\d+)/)
  const gid = gidMatch ? gidMatch[1] : '0'

  // Google's export endpoint — works for publicly shared sheets
  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`

  const res = await fetch(exportUrl, {
    headers: { 'User-Agent': 'CatalogStudio/1.0' },
    redirect: 'follow',
  })

  if (!res.ok) {
    if (res.status === 403 || res.status === 401) {
      throw new Error(
        'Google Sheet is not publicly accessible. Please set sharing to "Anyone with the link can view" and try again.'
      )
    }
    throw new Error(`Failed to fetch Google Sheet: HTTP ${res.status}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())

  return {
    buffer,
    filename: `google-sheet-${sheetId}.csv`,
    mimeType: 'text/csv',
  }
}

/**
 * Fetch a Google Drive file (Excel or CSV).
 * Works for publicly shared files.
 */
export async function fetchGoogleDriveFile(url: string): Promise<FetchedFile> {
  const fileId = extractDriveFileId(url)
  if (!fileId) {
    throw new Error(`Invalid Google Drive URL: ${url}`)
  }

  // Try direct download URL
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`

  const res = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'CatalogStudio/1.0' },
    redirect: 'follow',
  })

  if (!res.ok) {
    if (res.status === 403 || res.status === 401) {
      throw new Error(
        'Google Drive file is not publicly accessible. Please set sharing to "Anyone with the link can view" and try again.'
      )
    }
    throw new Error(`Failed to fetch Google Drive file: HTTP ${res.status}`)
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await res.arrayBuffer())

  // Detect format from content-type
  let mimeType = contentType.split(';')[0].trim()
  let filename = `google-drive-${fileId}`

  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('xlsx')) {
    filename += '.xlsx'
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  } else if (mimeType.includes('csv') || mimeType.includes('text/plain')) {
    filename += '.csv'
    mimeType = 'text/csv'
  } else {
    // Try to detect from buffer magic bytes
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
      filename += '.xlsx'
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    } else {
      filename += '.csv'
      mimeType = 'text/csv'
    }
  }

  return { buffer, filename, mimeType }
}

/**
 * Auto-detect URL type and fetch accordingly.
 */
export async function fetchFromUrl(url: string): Promise<FetchedFile> {
  const trimmed = url.trim()

  if (trimmed.includes('docs.google.com/spreadsheets')) {
    return fetchGoogleSheet(trimmed)
  }

  if (trimmed.includes('drive.google.com')) {
    return fetchGoogleDriveFile(trimmed)
  }

  // Direct file URL
  const res = await fetch(trimmed, {
    headers: { 'User-Agent': 'CatalogStudio/1.0' },
    redirect: 'follow',
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch file from URL: HTTP ${res.status}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') || 'application/octet-stream'
  const urlPath = new URL(trimmed).pathname
  const filename = urlPath.split('/').pop() || 'import.xlsx'

  return { buffer, filename, mimeType: contentType }
}