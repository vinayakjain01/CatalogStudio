/**
 * FLUX.1 Kontext [max] (multi-image) Adapter via fal.ai
 *
 * Model: fal-ai/flux-pro/kontext/max/multi — the multi-image variant of Flux
 * Kontext, which accepts an `image_urls` array (reference ad + merchant
 * product photo) plus a text prompt and edits them into one output image.
 * Configurable via FAL_FLUX_KONTEXT_MODEL in case fal.ai versions the slug.
 *
 * Reuses FAL_API_KEY (already configured for background-removal's
 * fal-birefnet-provider.ts) — no new secret needed for this provider.
 *
 * Submit → poll → fetch shape is copied verbatim from
 * background-removal/fal-birefnet-provider.ts's fal.ai queue integration.
 * Poll cadence/timeout are configurable (IMAGE_EDIT_POLL_INTERVAL_MS /
 * IMAGE_EDIT_POLL_MAX_ATTEMPTS) with a higher ceiling than BiRefNet's 30
 * attempts, since image edits routinely take longer than background removal.
 */

import type { ImageEditInput, ImageEditingProvider, ImageEditResult } from './provider'

const DEFAULT_MODEL = 'fal-ai/flux-pro/kontext/max/multi'
const FAL_QUEUE_BASE = 'https://queue.fal.run'

function getAuthHeader(): string {
  const apiKey = process.env.FAL_API_KEY
  if (!apiKey) throw new Error('FAL_API_KEY is not set')
  return `Key ${apiKey}`
}

function getModel(): string {
  return process.env.FAL_FLUX_KONTEXT_MODEL || DEFAULT_MODEL
}

function getPollConfig() {
  return {
    intervalMs: parseInt(process.env.IMAGE_EDIT_POLL_INTERVAL_MS || '1500', 10),
    maxAttempts: parseInt(process.env.IMAGE_EDIT_POLL_MAX_ATTEMPTS || '40', 10),
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export class FluxKontextProvider implements ImageEditingProvider {
  readonly name = 'flux-kontext'

  async editImage(input: ImageEditInput): Promise<ImageEditResult> {
    const base = `${FAL_QUEUE_BASE}/${getModel()}`

    // 1. Submit the job to the queue.
    const submitRes = await fetch(base, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: input.systemPrompt,
        image_urls: [input.templateImageUrl, input.productImageUrl],
      }),
    })

    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => submitRes.statusText)
      throw new Error(`Flux Kontext submit error ${submitRes.status}: ${text.slice(0, 500)}`)
    }

    const submitData = await submitRes.json()
    const requestId = submitData.request_id
    const statusUrl = submitData.status_url
    const responseUrl = submitData.response_url

    if (!requestId || !statusUrl) {
      throw new Error(`Flux Kontext submit response missing request_id/status_url: ${JSON.stringify(submitData).slice(0, 300)}`)
    }

    // 2. Poll for completion.
    const { intervalMs, maxAttempts } = getPollConfig()

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(intervalMs)

      const statusRes = await fetch(statusUrl, {
        headers: { Authorization: getAuthHeader() },
      })
      if (!statusRes.ok) {
        const text = await statusRes.text().catch(() => statusRes.statusText)
        throw new Error(`Flux Kontext status check error ${statusRes.status}: ${text.slice(0, 500)}`)
      }

      const statusData = await statusRes.json()

      if (statusData.status === 'COMPLETED') {
        // 3. Fetch the actual result.
        const resultRes = await fetch(responseUrl || statusUrl.replace('/status', ''), {
          headers: { Authorization: getAuthHeader() },
        })
        if (!resultRes.ok) {
          const text = await resultRes.text().catch(() => resultRes.statusText)
          throw new Error(`Flux Kontext result fetch error ${resultRes.status}: ${text.slice(0, 500)}`)
        }

        const resultData = await resultRes.json()
        // Flux image models return a plural `images[]` array (supports
        // num_images); fall back to a singular `image` shape defensively in
        // case fal.ai's response schema differs for this specific model.
        const outputImageUrl: string | undefined =
          resultData.images?.[0]?.url || resultData.image?.url

        if (!outputImageUrl) {
          throw new Error(`Flux Kontext result missing images[0].url: ${JSON.stringify(resultData).slice(0, 300)}`)
        }

        const imgRes = await fetch(outputImageUrl)
        if (!imgRes.ok) throw new Error(`Failed to download Flux Kontext result image: ${imgRes.status}`)
        const mimeType = imgRes.headers.get('content-type') || 'image/jpeg'
        return {
          buffer: Buffer.from(await imgRes.arrayBuffer()),
          mimeType,
          providerRequestId: requestId,
        }
      }

      if (statusData.status === 'FAILED' || statusData.status === 'ERROR') {
        throw new Error(`Flux Kontext job failed: ${JSON.stringify(statusData).slice(0, 300)}`)
      }

      // status is IN_QUEUE or IN_PROGRESS — keep polling.
    }

    throw new Error(`Flux Kontext timed out after ${maxAttempts * intervalMs}ms`)
  }
}
