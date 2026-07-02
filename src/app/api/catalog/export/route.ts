/**
 * GET /api/catalog/export?importId=...&format=xlsx|csv
 * Downloads the output line sheet with generated creatives appended.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/generation-queue'
import { generateOutputFile } from '@/lib/catalog-import/output-generator'

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
    .select('id, user_id')
    .eq('id', importId)
    .single()

  if (!importRecord || importRecord.user_id !== user.id) {
    return NextResponse.json({ error: 'Import not found' }, { status: 404 })
  }

  const admin = getAdminClient()

  try {
    const output = await generateOutputFile({ importId, format, supabase: admin })

    return new NextResponse(output.buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': output.mimeType,
        'Content-Disposition': `attachment; filename="${output.filename}"`,
        'Content-Length': String(output.buffer.length),
      },
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}