/**
 * Gemini 2.5 Flash Image Adapter (default Template Adaptation provider)
 *
 * REST endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * Auth: header `x-goog-api-key` (NOT a Bearer token, NOT a query param).
 *
 * Multi-image edit request shape uses snake_case field names on the raw REST
 * API — `inline_data` / `mime_type` — not the camelCase `inlineData` used by
 * Google's JS/Python SDK wrappers. We call the REST API directly (same
 * approach as fal-birefnet-provider.ts calling fal.ai's raw REST API), so the
 * request body below must use snake_case.
 *
 * Set env var: GEMINI_API_KEY (from Google AI Studio → API keys).
 * Model is configurable via GEMINI_IMAGE_EDIT_MODEL (default gemini-2.5-flash-image)
 * since Google periodically renames/versions image models.
 */

import type { ImageEditInput, ImageEditingProvider, ImageEditResult } from './provider'

const DEFAULT_MODEL = 'gemini-2.5-flash-image'

function getApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  return apiKey
}

function getModel(): string {
  return process.env.GEMINI_IMAGE_EDIT_MODEL || DEFAULT_MODEL
}

async function fetchAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download image for Gemini edit: ${res.status} ${url.slice(0, 80)}`)
  const mimeType = res.headers.get('content-type') || 'image/jpeg'
  const buffer = Buffer.from(await res.arrayBuffer())
  return { data: buffer.toString('base64'), mimeType }
}

export class GeminiImageEditingProvider implements ImageEditingProvider {
  readonly name = 'gemini'

  async editImage(input: ImageEditInput): Promise<ImageEditResult> {
    const apiKey = getApiKey()
    const model = getModel()
    const timeoutMs = input.timeoutMs ?? parseInt(process.env.IMAGE_EDIT_TIMEOUT_MS || '45000', 10)

    const [reference, product] = await Promise.all([
      fetchAsBase64(input.templateImageUrl),
      fetchAsBase64(input.productImageUrl),
    ])

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: input.systemPrompt },
                  { inline_data: { mime_type: reference.mimeType, data: reference.data } },
                  { inline_data: { mime_type: product.mimeType, data: product.data } },
                ],
              },
            ],
          }),
        }
      )
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Gemini image edit error ${res.status}: ${text.slice(0, 500)}`)
    }

    const json = await res.json()
    const parts: any[] = json?.candidates?.[0]?.content?.parts ?? []
    const imagePart = parts.find(p => p.inline_data?.data)

    if (!imagePart) {
      // Most common cause: safety-filter refusal, or the model responded
      // with text only. Surface the text (if any) so failures are debuggable.
      const textPart = parts.find(p => typeof p.text === 'string')?.text
      const finishReason = json?.candidates?.[0]?.finishReason
      throw new Error(
        `Gemini returned no image part (finishReason=${finishReason ?? 'unknown'})` +
        (textPart ? `: ${String(textPart).slice(0, 300)}` : '')
      )
    }

    return {
      buffer: Buffer.from(imagePart.inline_data.data, 'base64'),
      mimeType: imagePart.inline_data.mime_type || 'image/png',
    }
  }
}
