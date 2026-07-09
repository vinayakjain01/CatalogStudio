/**
 * fal.ai BiRefNet v2 Adapter
 *
 * Bilateral Reference Framework — state-of-the-art high-resolution dichotomous
 * image segmentation. Excellent on fine detail: hair, sheer/embroidered fabric,
 * jewelry edges — generally the best quality of all providers in this codebase
 * for fashion/apparel product photos.
 *
 * Model: https://fal.ai/models/fal-ai/birefnet/v2
 *
 * IMPORTANT — fal.ai's queue API takes an `image_url`, not a raw file upload.
 * Since our pipeline already has the source product image at a public URL
 * (Shopify CDN), we pass that URL directly instead of re-uploading the bytes
 * we already downloaded. This is faster and avoids a redundant upload step.
 *
 * fal.ai uses an async queue: submit → poll status → fetch result.
 * Typical completion time: 2-6 seconds for a single image.
 *
 * Set env var: FAL_API_KEY (format: "key_id:key_secret", from fal.ai dashboard
 * → Settings → API Keys)
 */

import type { BackgroundRemovalProvider } from './provider'

const FAL_BASE = 'https://queue.fal.run/fal-ai/birefnet/v2'
const POLL_INTERVAL_MS = 1000
const POLL_MAX_ATTEMPTS = 30 // 30s max wait

function getAuthHeader(): string {
  const apiKey = process.env.FAL_API_KEY
  if (!apiKey) throw new Error('FAL_API_KEY is not set')
  return `Key ${apiKey}`
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export class FalBirefnetProvider implements BackgroundRemovalProvider {
  readonly name = 'fal-birefnet'

  /**
   * sourceUrl is required for this provider — fal.ai's queue API takes a
   * public image URL, not a file upload. If sourceUrl is missing, this
   * throws immediately so the fallback chain (if configured) can take over.
   */
  async removeBackground(imageBuffer: Buffer, sourceUrl?: string): Promise<Buffer> {
    if (!sourceUrl) {
      throw new Error('fal.ai BiRefNet requires sourceUrl — pass the public image URL')
    }

    // 1. Submit the job to the queue
    const submitRes = await fetch(FAL_BASE, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: sourceUrl,
      }),
    })

    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => submitRes.statusText)
      throw new Error(`fal.ai submit error ${submitRes.status}: ${text}`)
    }

    const submitData = await submitRes.json()
    const requestId = submitData.request_id
    const statusUrl = submitData.status_url
    const responseUrl = submitData.response_url

    if (!requestId || !statusUrl) {
      throw new Error(`fal.ai submit response missing request_id/status_url: ${JSON.stringify(submitData)}`)
    }

    // 2. Poll for completion
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS)

      const statusRes = await fetch(statusUrl, {
        headers: { 'Authorization': getAuthHeader() },
      })
      if (!statusRes.ok) {
        const text = await statusRes.text().catch(() => statusRes.statusText)
        throw new Error(`fal.ai status check error ${statusRes.status}: ${text}`)
      }

      const statusData = await statusRes.json()

      if (statusData.status === 'COMPLETED') {
        // 3. Fetch the actual result
        const resultRes = await fetch(responseUrl || statusUrl.replace('/status', ''), {
          headers: { 'Authorization': getAuthHeader() },
        })
        if (!resultRes.ok) {
          const text = await resultRes.text().catch(() => resultRes.statusText)
          throw new Error(`fal.ai result fetch error ${resultRes.status}: ${text}`)
        }

        const resultData = await resultRes.json()
        const outputImageUrl = resultData.image?.url

        if (!outputImageUrl) {
          throw new Error(`fal.ai result missing image.url: ${JSON.stringify(resultData)}`)
        }

        // Download the transparent PNG result
        const imgRes = await fetch(outputImageUrl)
        if (!imgRes.ok) throw new Error(`Failed to download fal.ai result image: ${imgRes.status}`)
        return Buffer.from(await imgRes.arrayBuffer())
      }

      if (statusData.status === 'FAILED' || statusData.status === 'ERROR') {
        throw new Error(`fal.ai job failed: ${JSON.stringify(statusData)}`)
      }

      // status is IN_QUEUE or IN_PROGRESS — keep polling
    }

    throw new Error('fal.ai BiRefNet timed out after 30s')
  }
}