/**
 * POST /api/catalog/upload-signature
 *
 * Line sheets with embedded product photos routinely exceed Vercel's
 * ~4.5MB serverless function request-body limit (Vercel rejects the
 * request before our /api/catalog/import route even runs — see
 * https://vercel.com/docs/errors/FUNCTION_PAYLOAD_TOO_LARGE).
 *
 * The fix is to have the browser upload the raw file directly to
 * Cloudinary (bypassing our server entirely for the big transfer), then
 * send just the resulting URL to /api/catalog/import — the same code
 * path already used for Google Sheets / Drive links.
 *
 * This route only hands out a short-lived signed upload credential; it
 * never touches the file itself. Requires the caller to own the target
 * store, same as /api/catalog/import.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { storeId, filename } = await request.json()
  if (!storeId || !filename) {
    return NextResponse.json({ error: 'storeId and filename are required' }, { status: 400 })
  }

  // Verify the store belongs to this user before handing out an upload credential
  const { data: store } = await supabase
    .from('stores')
    .select('id')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single()

  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const { v2: cloudinary } = await import('cloudinary')
  cloudinary.config({
    cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  })

  const timestamp = Math.round(Date.now() / 1000)

  // resource_type: raw uploads don't get an extension appended automatically —
  // it must already be present in public_id, or parseLineSheet/extractEmbeddedImages
  // downstream won't be able to tell xlsx from csv from the URL.
  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_')
  const publicId = `catalog-imports/${storeId}/sheets/${timestamp}-${safeName}`

  const paramsToSign = { timestamp, public_id: publicId }
  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET!
  )

  return NextResponse.json({
    timestamp,
    publicId,
    signature,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  })
}