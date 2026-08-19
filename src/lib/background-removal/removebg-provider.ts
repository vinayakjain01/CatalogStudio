/**
 * @module removebg-provider
 *
 * remove.bg Adapter
 *
 * RESPONSIBILITIES:
 *   - RemoveBgProvider — BackgroundRemovalProvider implementation backed by the remove.bg API, always requesting full resolution output
 *
 * Generally the highest quality background removal available for fashion,
 * apparel, jewelry, and hair edges — consistently outperforms Clipdrop and
 * Cloudinary AI on complex fabric and embroidery detail in practice.
 *
 * Free tier: 50 images/month (preview quality). Paid: ~$0.07–0.20/image
 * depending on volume, full resolution.
 *
 * API docs: https://www.remove.bg/api
 * Get a key: https://www.remove.bg/api#api-key (sign up free)
 *
 * Set env var: REMOVEBG_API_KEY
 */

import type { BackgroundRemovalProvider } from './provider'

export class RemoveBgProvider implements BackgroundRemovalProvider {
  readonly name = 'removebg'

  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    const apiKey = process.env.REMOVEBG_API_KEY
    if (!apiKey) throw new Error('REMOVEBG_API_KEY is not set')

    const form = new FormData()
    form.append('image_file', new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' }), 'image.png')
    // Always request FULL resolution — this is the most important quality setting.
    // 'auto' gives preview quality on free tier (625px max).
    // 'full' ensures the original resolution is preserved end-to-end.
    // Requires a paid remove.bg plan (worth it for fashion/luxury brands).
    form.append('size', 'full')

    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form,
    })

    if (!res.ok) {
      let detail = res.statusText
      try {
        const json = await res.json()
        detail = json.errors?.[0]?.title || JSON.stringify(json)
      } catch {
        detail = await res.text().catch(() => res.statusText)
      }
      throw new Error(`remove.bg API error ${res.status}: ${detail}`)
    }

    return Buffer.from(await res.arrayBuffer())
  }
}