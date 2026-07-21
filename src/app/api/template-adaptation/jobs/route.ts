import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUser } from '@/lib/supabase/get-user'
import { createAdaptationJob, getAdminClient } from '@/lib/adaptation-queue'
import { rateLimit, rateLimitHeaders } from '@/lib/rate-limit'
import type { PlatformContext } from '@/types/template-adaptation'

const ADAPTATION_MAX_IMAGES_PER_JOB = parseInt(process.env.ADAPTATION_MAX_IMAGES_PER_JOB || '10', 10)
const ADAPTATION_RATE_LIMIT_PER_STORE = parseInt(process.env.ADAPTATION_RATE_LIMIT_PER_STORE || '10', 10)
const ADAPTATION_RATE_WINDOW_SECS = parseInt(process.env.ADAPTATION_RATE_WINDOW_SECS || '3600', 10)
const ADAPTATION_MAX_PENDING_IMAGES_PER_STORE = parseInt(process.env.ADAPTATION_MAX_PENDING_IMAGES_PER_STORE || '50', 10)

const VALID_PLATFORM_CONTEXTS: PlatformContext[] = ['shopify_pdp', 'meta_feed_ad', 'instagram_post', 'generic']

// GET /api/template-adaptation/jobs?storeId=xxx — history grid for the active store.
export async function GET(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const storeId = request.nextUrl.searchParams.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })

  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  const admin = getAdminClient()
  const { data: jobs, error } = await admin
    .from('adaptation_jobs')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ jobs: jobs || [] })
}

// POST /api/template-adaptation/jobs
//   { storeId, referenceImageUrl, referenceCloudinaryId?, platformContext?,
//     merchantNotes?, productImages: [{ url, cloudinaryId? }] }
export async function POST(request: NextRequest) {
  const [user, body] = await Promise.all([getUser(), request.json()])
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const {
    storeId, referenceImageUrl, referenceCloudinaryId, platformContext, merchantNotes, productImages,
  } = body || {}

  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 })
  if (!referenceImageUrl) return NextResponse.json({ error: 'referenceImageUrl required' }, { status: 400 })
  if (!Array.isArray(productImages) || productImages.length === 0) {
    return NextResponse.json({ error: 'At least one product image is required' }, { status: 400 })
  }
  if (productImages.length > ADAPTATION_MAX_IMAGES_PER_JOB) {
    return NextResponse.json(
      { error: `Maximum ${ADAPTATION_MAX_IMAGES_PER_JOB} product images per job` },
      { status: 400 }
    )
  }
  if (platformContext && !VALID_PLATFORM_CONTEXTS.includes(platformContext)) {
    return NextResponse.json({ error: 'Invalid platformContext' }, { status: 400 })
  }
  for (const img of productImages) {
    if (!img?.url || typeof img.url !== 'string') {
      return NextResponse.json({ error: 'Each product image requires a url' }, { status: 400 })
    }
  }

  // ── Verify store ownership ────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: store } = await supabase
    .from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single()
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })

  // ── Rate limit: max N adaptation jobs per store per hour ───────────────────
  const rl = await rateLimit(`adaptation:${storeId}`, ADAPTATION_RATE_LIMIT_PER_STORE, ADAPTATION_RATE_WINDOW_SECS)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many Template Adaptation jobs for this store. Try again in ${rl.resetIn}s.` },
      { status: 429, headers: rateLimitHeaders(rl) }
    )
  }

  const admin = getAdminClient()

  // ── Queue depth cap: reject if store already has too many pending images ──
  const { count: pendingCount } = await admin
    .from('adaptation_images')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .in('status', ['pending', 'generating'])

  if ((pendingCount ?? 0) + productImages.length > ADAPTATION_MAX_PENDING_IMAGES_PER_STORE) {
    return NextResponse.json(
      {
        error: `Queue limit reached. This store already has ${pendingCount} images pending. ` +
               `Wait for them to finish before submitting more.`,
        pendingCount,
      },
      { status: 429 }
    )
  }

  const basePriority = (pendingCount ?? 0) + 1

  try {
    const { jobId, imageIds } = await createAdaptationJob(
      {
        storeId,
        userId: user.id,
        referenceImageUrl,
        referenceCloudinaryId: referenceCloudinaryId ?? null,
        platformContext: platformContext || 'generic',
        merchantNotes,
        productImages: productImages.map((img: any) => ({ url: img.url, cloudinaryId: img.cloudinaryId ?? null })),
        basePriority,
      },
      admin
    )

    return NextResponse.json(
      { jobId, imageIds, enqueued: imageIds.length },
      { headers: rateLimitHeaders(rl) }
    )
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to create adaptation job' }, { status: 500 })
  }
}
