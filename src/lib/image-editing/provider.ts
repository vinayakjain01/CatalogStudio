/**
 * Image Editing Provider Interface
 *
 * All providers accept two source images (a reference advertisement + a
 * merchant product photo) plus one prompt, and return a Buffer of the edited
 * advertisement. Swapping providers = swapping one env var
 * (IMAGE_EDIT_PROVIDER) — see index.ts.
 */

export interface ImageEditInput {
  /** The merchant-uploaded reference advertisement — defines everything except the model. */
  templateImageUrl: string
  /** The merchant's own product/model photo — sole source of the new identity + garment. */
  productImageUrl: string
  /** Output of prompt-builder.ts. Never pass raw user text here directly. */
  systemPrompt: string
  /** Overrides IMAGE_EDIT_TIMEOUT_MS for this call. */
  timeoutMs?: number
}

export interface ImageEditResult {
  buffer: Buffer
  mimeType: string
  /** Provider-side request/job id, stored for debugging support tickets. */
  providerRequestId?: string
}

export interface ImageEditingProvider {
  readonly name: string
  /**
   * Edit templateImageUrl by replacing its model with the identity + garment
   * from productImageUrl, per systemPrompt. Must return a photorealistic
   * raster image buffer. Throws on failure (safety refusal, timeout, API error).
   */
  editImage(input: ImageEditInput): Promise<ImageEditResult>
}

export type ImageEditingProviderName = 'gemini' | 'openai' | 'flux-kontext'
