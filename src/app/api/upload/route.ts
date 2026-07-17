import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { uploadBuffer } from '@/lib/cloudinary'
import { nanoid } from 'nanoid'
import { createCanvas, loadImage } from '@napi-rs/canvas'

// Accepts a multipart/form-data upload with field `file`.
// Optional `kind` (overlay | logo) only affects the public_id prefix.
// Returns { url } — the optimised delivery URL to store in the layer.

const MAX_BYTES = 9.98 * 1024 * 1024   // 9.98 MB hard ceiling
const TARGET_BYTES = 9.8  * 1024 * 1024  // aim for a little headroom

/**
 * Smart compression: if the image fits under MAX_BYTES upload it as-is.
 * If it's over, re-encode as JPEG at the highest quality that still fits.
 *
 * Quality ladder: 97 → 95 → 93 → 90 → 87 → 85 → 80 → 75
 * Last resort: scale dimensions to 75% then try quality 90.
 */
async function smartCompress(
  buf: Buffer
): Promise<{ buffer: Buffer; compressed: boolean; originalMb: number; finalMb: number }> {
  const originalMb = buf.length / (1024 * 1024)
  if (buf.length <= MAX_BYTES) {
    return { buffer: buf, compressed: false, originalMb, finalMb: originalMb }
  }

  const img = await loadImage(buf)

  // Try progressively lower JPEG quality
  for (const q of [97, 95, 93, 90, 87, 85, 80, 75]) {
    const canvas = createCanvas(img.width, img.height)
    canvas.getContext('2d').drawImage(img, 0, 0)
    const out = (canvas as any).toBuffer('image/jpeg', { quality: q })
    if (out.length <= TARGET_BYTES) {
      return { buffer: out, compressed: true, originalMb, finalMb: out.length / (1024 * 1024) }
    }
  }

  // Last resort: resize to 75% of original dimensions
  const w = Math.round(img.width  * 0.75)
  const h = Math.round(img.height * 0.75)
  const canvas = createCanvas(w, h)
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  const out = (canvas as any).toBuffer('image/jpeg', { quality: 90 })
  return { buffer: out, compressed: true, originalMb, finalMb: out.length / (1024 * 1024) }
}

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

  const allowed = ['image/png', 'image/jpeg', 'image/webp']
  if (!allowed.includes(file.type)) {
    return NextResponse.json(
      { error: 'Only PNG, JPG, or WEBP files are allowed' },
      { status: 400 }
    )
  }

  const raw = Buffer.from(await file.arrayBuffer())
  const { buffer, compressed, originalMb, finalMb } = await smartCompress(raw)

  const publicId = `${kind}_${user.id}_${nanoid(8)}`

  try {
    const { deliveredUrl } = await uploadBuffer(buffer, publicId)
    return NextResponse.json({
      url: deliveredUrl,
      compressed,
      originalMb: +originalMb.toFixed(2),
      finalMb:    +finalMb.toFixed(2),
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 })
  }
}