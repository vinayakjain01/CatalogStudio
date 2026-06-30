/**
 * Clipdrop Background Removal Adapter (Stability AI)
 *
 * Fast, accurate, and affordable. ~$0.001 per image.
 * API docs: https://clipdrop.co/apis/docs/remove-background
 *
 * Set env var: CLIPDROP_API_KEY
 */

import type { BackgroundRemovalProvider } from './provider'

export class ClipdropBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly name = 'clipdrop'

  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    const apiKey = process.env.CLIPDROP_API_KEY
    if (!apiKey) throw new Error('CLIPDROP_API_KEY is not set')

    const form = new FormData()
    form.append('image_file',new Blob([new Uint8Array(imageBuffer)],{ type: 'image/png' }),'image.png')

    const res = await fetch('https://clipdrop-api.co/remove-background/v1', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Clipdrop API error ${res.status}: ${text}`)
    }

    return Buffer.from(await res.arrayBuffer())
  }
}