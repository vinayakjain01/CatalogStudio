/**
 * Background Removal Provider Interface
 *
 * All providers accept a Buffer (image bytes) and return a Buffer (transparent PNG).
 * Swapping providers = swapping one import in background-removal/index.ts.
 */

export interface BackgroundRemovalProvider {
  readonly name: string
  /**
   * Remove the background from imageBuffer.
   * Must return a PNG buffer with transparency.
   * Throws on failure.
   */
  removeBackground(imageBuffer: Buffer, sourceUrl?: string): Promise<Buffer>
}

export type ProviderName = 'cloudinary' | 'clipdrop' | 'removebg' | 'photoroom' | 'fal-birefnet'