/**
 * OpenAI gpt-image-1 Adapter
 *
 * REST endpoint: POST https://api.openai.com/v1/images/edits
 * Auth: `Authorization: Bearer OPENAI_API_KEY`
 * Body: multipart/form-data with repeated `image[]` fields (gpt-image-1's
 * edits endpoint accepts up to 16 reference images in one call) plus `model`
 * and `prompt`. Response is always base64 (`data[0].b64_json`) for
 * gpt-image-1 — no separate result-URL fetch step needed, unlike fal.ai.
 *
 * Set env var: OPENAI_API_KEY.
 * Model is configurable via OPENAI_IMAGE_EDIT_MODEL (default gpt-image-1).
 */

import type { ImageEditInput, ImageEditingProvider, ImageEditResult } from './provider'

const DEFAULT_MODEL = 'gpt-image-1'

function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  return apiKey
}

function getModel(): string {
  return process.env.OPENAI_IMAGE_EDIT_MODEL || DEFAULT_MODEL
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download image for OpenAI edit: ${res.status} ${url.slice(0, 80)}`)
  const mimeType = res.headers.get('content-type') || 'image/jpeg'
  const buffer = Buffer.from(await res.arrayBuffer())
  return new Blob([buffer], { type: mimeType })
}

export class OpenAIImageEditingProvider implements ImageEditingProvider {
  readonly name = 'openai'

  async editImage(input: ImageEditInput): Promise<ImageEditResult> {
    const apiKey = getApiKey()
    const model = getModel()
    const timeoutMs = input.timeoutMs ?? parseInt(process.env.IMAGE_EDIT_TIMEOUT_MS || '45000', 10)

    const [referenceBlob, productBlob] = await Promise.all([
      fetchAsBlob(input.templateImageUrl),
      fetchAsBlob(input.productImageUrl),
    ])

    const form = new FormData()
    form.append('model', model)
    form.append('prompt', input.systemPrompt)
    // Reference ad first, merchant product second — order matches the prompt's
    // "Image 1 = reference, Image 2 = merchant product" framing.
    form.append('image[]', referenceBlob, 'reference.png')
    form.append('image[]', productBlob, 'product.png')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    try {
      res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`OpenAI image edit error ${res.status}: ${text.slice(0, 500)}`)
    }

    const json = await res.json()
    const b64 = json?.data?.[0]?.b64_json
    if (!b64) {
      throw new Error(`OpenAI image edit response missing data[0].b64_json: ${JSON.stringify(json).slice(0, 300)}`)
    }

    return {
      buffer: Buffer.from(b64, 'base64'),
      mimeType: 'image/png',
    }
  }
}
