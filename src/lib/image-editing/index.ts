/**
 * Image Editing Service (Template Adaptation)
 *
 * Central orchestration layer, mirroring background-removal/index.ts:
 *  1. Instantiate the configured provider (IMAGE_EDIT_PROVIDER env var)
 *  2. Call it; on failure, try each fallback in IMAGE_EDIT_FALLBACK_PROVIDERS in order
 *  3. Return the resulting image buffer + which provider actually produced it
 *
 * Unlike background-removal, there is no cache-check-then-generate step here:
 * every (job, product image) pair is a unique merchant request and a retry
 * must always call the provider fresh, so this module is orchestration-only.
 */

import type { ImageEditInput, ImageEditingProvider, ImageEditingProviderName, ImageEditResult } from './provider'
import { toDeliveryUrl } from '@/lib/cloudinary'

function instantiateProvider(name: ImageEditingProviderName): ImageEditingProvider {
  switch (name) {
    case 'openai': {
      const { OpenAIImageEditingProvider } = require('./openai-provider')
      return new OpenAIImageEditingProvider()
    }
    case 'flux-kontext': {
      const { FluxKontextProvider } = require('./flux-kontext-provider')
      return new FluxKontextProvider()
    }
    case 'gemini':
    default: {
      const { GeminiImageEditingProvider } = require('./gemini-provider')
      return new GeminiImageEditingProvider()
    }
  }
}

function getConfiguredProvider(): ImageEditingProvider {
  const name = (process.env.IMAGE_EDIT_PROVIDER || 'gemini') as ImageEditingProviderName
  return instantiateProvider(name)
}

/**
 * Ordered fallback chain. If IMAGE_EDIT_FALLBACK_PROVIDERS is set (comma
 * separated, e.g. "flux-kontext"), those providers are tried in order after
 * the primary fails — covers cases like "Gemini safety-filtered this pair"
 * or "OpenAI is rate-limited this hour" without failing the whole image.
 */
function getFallbackProviders(): ImageEditingProvider[] {
  const raw = process.env.IMAGE_EDIT_FALLBACK_PROVIDERS
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(name => instantiateProvider(name as ImageEditingProviderName))
}

/**
 * Bound the payload size sent to providers using Cloudinary's existing
 * delivery-transform helper — no new resizer needed. Reference ads and
 * merchant photos can be arbitrarily large uploads; providers only need a
 * web-resolution copy to produce a photorealistic edit.
 */
export function toEditInputUrl(url: string): string {
  return toDeliveryUrl(url, 'w_1536,c_limit')
}

export interface AdaptImageResult extends ImageEditResult {
  provider: string
}

/**
 * Run one Template Adaptation edit: template ad + product photo + prompt → buffer.
 * Tries the configured provider, then each fallback in order. Throws the last
 * error if every provider in the chain fails.
 */
export async function adaptProductImage(input: ImageEditInput): Promise<AdaptImageResult> {
  const primary = getConfiguredProvider()
  const fallbacks = getFallbackProviders()
  const chain = [primary, ...fallbacks]

  let lastError: Error | null = null

  for (const candidate of chain) {
    try {
      console.log(`[image-editing] Trying provider: ${candidate.name}`)
      const result = await candidate.editImage(input)
      return { ...result, provider: candidate.name }
    } catch (err: any) {
      lastError = err
      console.error(`[image-editing] Provider ${candidate.name} failed: ${err.message}`)
    }
  }

  throw lastError || new Error('All image-editing providers failed')
}

export type { ImageEditInput, ImageEditingProvider, ImageEditingProviderName, ImageEditResult } from './provider'
