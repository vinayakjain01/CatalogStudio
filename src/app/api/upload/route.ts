import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { uploadBuffer } from '@/lib/cloudinary'
import { nanoid } from 'nanoid'

// Accepts a multipart/form-data upload with field `file`.
// Optional `kind` (overlay | logo) only affects the public_id prefix.
// Returns { url } — the optimised delivery URL to store in the layer.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const form = await request.formData()
  const file = form.get('file')
  const kind = (form.get('kind') as string) || 'asset'

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'file required' }, { status: 400 })
  }

  // Validate: PNG / JPG / WEBP only, max 10MB.
  const allowed = ['image/png', 'image/jpeg', 'image/webp']
  if (!allowed.includes(file.type)) {
    return NextResponse.json(
      { error: 'Only PNG, JPG, or WEBP files are allowed' },
      { status: 400 }
    )
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'File must be under 10MB' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const publicId = `${kind}_${user.id}_${nanoid(8)}`

  try {
    const { deliveredUrl } = await uploadBuffer(buffer, publicId)
    return NextResponse.json({ url: deliveredUrl })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 })
  }
}