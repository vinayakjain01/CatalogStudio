/**
 * Template Adaptation — Type Definitions
 *
 * FILE: src/types/template-adaptation.ts
 *
 * Shared between:
 *  - src/lib/adaptation-queue.ts                          (server — job/image orchestration)
 *  - src/app/api/template-adaptation/**                   (API routes — serialise to JSON)
 *  - src/components/template-adaptation/*                 (client — render status/progress)
 */

export type PlatformContext = 'shopify_pdp' | 'meta_feed_ad' | 'instagram_post' | 'generic'

export type AdaptationJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'

export type AdaptationImageStatus =
  | 'pending'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AdaptationJob {
  id: string
  store_id: string
  user_id: string
  reference_image_url: string
  reference_cloudinary_id: string | null
  platform_context: PlatformContext
  merchant_notes: string | null
  status: AdaptationJobStatus
  total_images: number
  completed_count: number
  failed_count: number
  created_at: string
  updated_at: string
}

export interface AdaptationImage {
  id: string
  job_id: string
  store_id: string
  position: number
  product_image_url: string
  product_image_cloudinary_id: string | null
  status: AdaptationImageStatus
  output_url: string | null
  output_cloudinary_id: string | null
  provider: string | null
  prompt_version: string | null
  generation_ms: number | null
  attempts: number
  max_attempts: number
  error: string | null
  locked_at: string | null
  approved: boolean
  created_at: string
  updated_at: string
}

export interface AdaptationJobWithImages extends AdaptationJob {
  adaptation_images: AdaptationImage[]
}
