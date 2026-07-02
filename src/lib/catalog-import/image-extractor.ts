/**
 * Embedded Image Extractor (XLSX)
 *
 * Line sheets often have product photos pasted or "inserted in cell"
 * directly into a spreadsheet, rather than linked via a URL column.
 * Google Sheets does not expose a stable source URL for these (confirmed
 * by Google: https://support.google.com/docs/thread/23809445) — the only
 * way to recover them is to read the actual image bytes out of an XLSX
 * export, where they live as real files under xl/media/ with position
 * metadata saying which cell they're anchored to.
 *
 * This module reads those images and maps each one to a 0-based index into
 * ParsedSheet.rows (row 0 = the first row after the header), so the
 * importer can fall back to an embedded image when a row has no image URL.
 */

import ExcelJS from 'exceljs'

export interface ExtractedImage {
  rowIndex: number
  buffer: Buffer
  extension: string
}

export async function extractEmbeddedImages(
  buffer: Buffer,
  preferredSheetName?: string
): Promise<ExtractedImage[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as any)

  // Match the same sheet parseLineSheet() picked, so row indices line up.
  // Fall back to the first worksheet that actually has images.
  let worksheet = preferredSheetName
    ? workbook.getWorksheet(preferredSheetName)
    : undefined

  if (!worksheet) {
    worksheet = workbook.worksheets.find(ws => ws.getImages().length > 0)
      ?? workbook.worksheets[0]
  }

  if (!worksheet) return []

  const results: ExtractedImage[] = []

  for (const img of worksheet.getImages()) {
    const media = workbook.model.media.find((m: any) => m.index === img.imageId) as any
    if (!media || !media.buffer) continue

    // tl.nativeRow is 0-based (the anchor cell's row). Sheet row 0 is the
    // header, so data row index = nativeRow - 1.
    const dataRowIndex = img.range.tl.nativeRow - 1
    if (dataRowIndex < 0) continue // anchored on/above the header — skip

    const imgBuffer = Buffer.isBuffer(media.buffer)
      ? media.buffer
      : Buffer.from(media.buffer)

    results.push({
      rowIndex: dataRowIndex,
      buffer: imgBuffer,
      extension: media.extension || 'png',
    })
  }

  return results
}

/**
 * Build a quick lookup: data row index -> its embedded image (first match wins
 * if a row somehow has more than one image anchored to it).
 */
export function toRowImageMap(
  images: ExtractedImage[]
): Map<number, ExtractedImage> {
  const map = new Map<number, ExtractedImage>()
  for (const img of images) {
    if (!map.has(img.rowIndex)) map.set(img.rowIndex, img)
  }
  return map
}