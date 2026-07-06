/**
 * GET /api/catalog/export?importId=...&format=xlsx|csv
 *
 * Downloads an Excel/CSV file containing all products from a Drive import,
 * with the generated creative URLs appended as extra columns.
 *
 * Self-contained — no dependency on catalog-import lib files.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import * as XLSX from 'xlsx'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const importId = request.nextUrl.searchParams.get('importId')
  const format   = (request.nextUrl.searchParams.get('format') || 'xlsx') as 'xlsx' | 'csv'

  if (!importId) return NextResponse.json({ error: 'importId required' }, { status: 400 })

  // Verify ownership
  const { data: importRecord } = await supabase
    .from('catalog_imports')
    .select('id, user_id, filename')
    .eq('id', importId)
    .single()

  if (!importRecord || importRecord.user_id !== user.id) {
    return NextResponse.json({ error: 'Import not found' }, { status: 404 })
  }

  const admin = getAdminClient()

  // Load products with their generated images
  const { data: products } = await admin
    .from('products')
    .select(`
      id, title, sku, price, product_type, image_url,
      generated_images(generated_url, status, updated_at, templates:template_id(name))
    `)
    .eq('import_id', importId)
    .order('title', { ascending: true })

  if (!products?.length) {
    return NextResponse.json({ error: 'No products found for this import' }, { status: 404 })
  }

  // Build rows
  const rows = (products as any[]).map(p => {
    const creatives = p.generated_images || []
    const latest = creatives.sort((a: any, b: any) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )[0]

    return {
      'Name': p.title || '',
      'SKU': p.sku || '',
      'Price': p.price || 0,
      'Category': p.product_type || '',
      'Original Image URL': p.image_url || '',
      'Generated Creative URL': latest?.generated_url || '',
      'Template Used': latest?.templates?.name || '',
      'Generation Status': latest?.status || 'pending',
      'Generated At': latest?.updated_at ? new Date(latest.updated_at).toISOString() : '',
    }
  })

  const baseFilename = (importRecord.filename || 'catalog')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 50)

  if (format === 'csv') {
    const ws = XLSX.utils.json_to_sheet(rows)
    const csv = XLSX.utils.sheet_to_csv(ws)
    const buf = Buffer.from(csv, 'utf-8')
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${baseFilename}_with_creatives.csv"`,
        'Content-Length': String(buf.length),
      },
    })
  }

  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Products & Creatives')
  const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))

  return new NextResponse(buf as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${baseFilename}_with_creatives.xlsx"`,
      'Content-Length': String(buf.length),
    },
  })
}