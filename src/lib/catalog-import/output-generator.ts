/**
 * Output Line Sheet Generator
 *
 * After creatives are generated, this builds an output Excel/CSV file that
 * contains ALL original columns plus new generated creative columns.
 *
 * The customer gets back their complete line sheet with creative URLs appended.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateOutputExcel, generateOutputCSV } from './parser'

export interface OutputExportOptions {
  importId: string
  format: 'xlsx' | 'csv'
  supabase: SupabaseClient
}

export interface OutputExportResult {
  buffer: Buffer
  filename: string
  mimeType: string
  rowCount: number
}

/**
 * Generate an output file for a completed import.
 * Fetches all import rows + their generated creatives and builds the output.
 */
export async function generateOutputFile(
  options: OutputExportOptions
): Promise<OutputExportResult> {
  const { importId, format, supabase } = options

  // Load the import record
  const { data: importRecord } = await supabase
    .from('catalog_imports')
    .select('filename, store_id')
    .eq('id', importId)
    .single()

  if (!importRecord) {
    throw new Error('Import not found')
  }

  // Load all import rows with their linked products and generated creatives
  const { data: importRows } = await supabase
    .from('catalog_import_rows')
    .select(`
      row_index,
      raw_data,
      status,
      error_msg,
      product_id,
      products:product_id (
        id,
        title,
        generated_images (
          generated_url,
          status,
          updated_at,
          templates:template_id (name)
        )
      )
    `)
    .eq('import_id', importId)
    .order('row_index', { ascending: true })

  if (!importRows || importRows.length === 0) {
    throw new Error('No rows found for this import')
  }

  // Build the original rows array and appended columns
  const originalRows: Record<string, unknown>[] = []
  const appendColumns: Record<string, string>[] = []

  for (const row of importRows) {
    originalRows.push(row.raw_data as Record<string, unknown>)

    const product = row.products as any
    const creatives = product?.generated_images || []
    const latestCreative = creatives.sort(
      (a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )[0]

    appendColumns.push({
      'Creative Generated': latestCreative ? 'Yes' : 'No',
      'Generated Creative URL': latestCreative?.generated_url || '',
      'Creative Status': latestCreative?.status || row.status === 'failed' ? 'failed' : 'pending',
      'Template Used': latestCreative?.templates?.name || '',
      'Generated At': latestCreative?.updated_at
        ? new Date(latestCreative.updated_at).toISOString()
        : '',
      'Import Row Status': row.status,
      'Import Error': row.error_msg || '',
    })
  }

  const baseFilename = (importRecord.filename || 'catalog')
    .replace(/\.[^.]+$/, '') // remove extension
    .replace(/[^a-zA-Z0-9_-]/g, '_')

  if (format === 'csv') {
    const csv = generateOutputCSV(originalRows, appendColumns)
    return {
      buffer: Buffer.from(csv, 'utf-8'),
      filename: `${baseFilename}_with_creatives.csv`,
      mimeType: 'text/csv',
      rowCount: importRows.length,
    }
  }

  const buffer = generateOutputExcel(originalRows, appendColumns)
  return {
    buffer,
    filename: `${baseFilename}_with_creatives.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    rowCount: importRows.length,
  }
}