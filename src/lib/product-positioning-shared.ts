/**
 * Client-safe pieces of Product Positioning ("Head Space" v2).
 *
 * src/lib/product-positioning.ts imports @napi-rs/canvas (a native Node
 * addon) for bounds detection, so it can never be imported from client
 * components (e.g. the live editor's canvas preview). This file holds the
 * pure-math pieces that both the server module and client components need,
 * with zero server-only dependencies.
 */

import type { ProductLayerSettings } from '@/types/template'

export interface HeadSpacePlacement {
  imgX: number
  imgY: number
  renderedW: number
  renderedH: number
  scale: number
}

/** Convert a pixel-space placement into a ProductLayerSettings percentage override (ai_product mode). */
export function placementToProductLayerSettings(
  placement: HeadSpacePlacement,
  canvasW: number,
  canvasH: number,
  base: ProductLayerSettings
): ProductLayerSettings {
  return {
    ...base,
    x:      (placement.imgX      / canvasW) * 100,
    y:      (placement.imgY      / canvasH) * 100,
    width:  (placement.renderedW / canvasW) * 100,
    height: (placement.renderedH / canvasH) * 100,
    // 'fill' tells drawProductLayer to use these exact pixel coordinates —
    // the placement math already chose the correct aspect-ratio-safe scale,
    // so no further contain/cover logic should be re-applied.
    objectFit: 'fill',
    padding: 0,
  }
}
