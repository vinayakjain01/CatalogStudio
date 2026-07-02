/**
 * Line Sheet Parser — Excel (XLSX/XLS) and CSV
 *
 * Parses an uploaded file buffer into an array of raw row objects.
 * Handles:
 *  - .xlsx / .xls (SheetJS/xlsx)
 *  - .csv (SheetJS can also parse these)
 *
 * Returns the first non-empty sheet's data as an array of objects
 * keyed by the header row.
 */

import * as XLSX from 'xlsx'

export interface ParsedSheet {
  headers: string[]
  rows: Record<string, unknown>[]
  sheetName: string
}

/**
 * Parse a file buffer (Excel or CSV) into structured row data.
 * @param buffer - The raw file bytes
 * @param mimeType - Optional MIME hint for format detection
 */
export function parseLineSheet(
  buffer: Buffer,
  mimeType?: string
): ParsedSheet {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,       // parse date cells as JS Date
    cellNF: false,         // no format strings
    cellHTML: false,       // no HTML rendering
  })

  // Use the first non-empty sheet
  const sheetName = workbook.SheetNames.find(name => {
    const sheet = workbook.Sheets[name]
    return sheet && Object.keys(sheet).length > 1 // more than just !ref
  }) ?? workbook.SheetNames[0]

  const sheet = workbook.Sheets[sheetName]
  if (!sheet) {
    throw new Error('No data found in the uploaded file')
  }

  // Convert to array of objects — header: false means row[0] is the header
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,   // gives us arrays, we'll build objects manually
    defval: '',  // empty cells become ''
    blankrows: false,
  }) as unknown[][]

  if (rawRows.length < 2) {
    throw new Error('File has no data rows (only a header or empty)')
  }

  // First row = headers. Normalize: trim whitespace, convert nulls to empty string
  const headers = (rawRows[0] as unknown[]).map(h =>
    h !== null && h !== undefined ? String(h).trim() : ''
  ).filter(Boolean)

  if (headers.length === 0) {
    throw new Error('No column headers found in the first row')
  }

  // Remaining rows → objects
  const rows: Record<string, unknown>[] = []
  for (let i = 1; i < rawRows.length; i++) {
    const rowArray = rawRows[i] as unknown[]
    const rowObj: Record<string, unknown> = {}
    let hasAnyValue = false

    for (let j = 0; j < headers.length; j++) {
      const val = rowArray[j]
      const strVal = val !== null && val !== undefined ? String(val).trim() : ''
      rowObj[headers[j]] = strVal
      if (strVal !== '') hasAnyValue = true
    }

    if (hasAnyValue) {
      rows.push(rowObj)
    }
    // Skip completely blank rows
  }

  if (rows.length === 0) {
    throw new Error('No data rows found after the header row')
  }

  return { headers, rows, sheetName }
}

/**
 * Generate an output Excel file from original rows + new columns.
 * Preserves ALL original columns exactly, appends generated creative columns.
 */
export function generateOutputExcel(
  originalRows: Record<string, unknown>[],
  appendColumns: Record<string, string>[]  // array of { col_name: value } per row
): Buffer {
  if (originalRows.length === 0) {
    throw new Error('No rows to export')
  }

  // Build merged rows
  const mergedRows = originalRows.map((orig, i) => ({
    ...orig,
    ...(appendColumns[i] || {}),
  }))

  const worksheet = XLSX.utils.json_to_sheet(mergedRows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Products')

  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
}

/**
 * Generate a CSV string from rows.
 */
export function generateOutputCSV(
  originalRows: Record<string, unknown>[],
  appendColumns: Record<string, string>[]
): string {
  const mergedRows = originalRows.map((orig, i) => ({
    ...orig,
    ...(appendColumns[i] || {}),
  }))

  const worksheet = XLSX.utils.json_to_sheet(mergedRows)
  return XLSX.utils.sheet_to_csv(worksheet)
}