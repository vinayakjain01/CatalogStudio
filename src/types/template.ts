export type LayerType = 'text' | 'image' | 'rectangle' | 'badge' | 'logo' | 'overlay' | 'sticker'

export interface BaseLayer {
  id: string
  type: LayerType
  x: number       // 0–100 (percentage of canvas width)
  y: number       // 0–100 (percentage of canvas height)
  width: number   // 0–100
  height: number  // 0–100
  rotation: number
  opacity: number // 0–1
  zIndex: number
}

export interface TextLayer extends BaseLayer {
  type: 'text'
  content: string          // Can include {{variables}}
  fontSize: number         // px at 1000px canvas
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  color: string
  backgroundColor: string | null
  borderRadius: number
  paddingX: number
  paddingY: number
  textAlign: 'left' | 'center' | 'right'
}

export interface ImageLayer extends BaseLayer {
  type: 'image'
  src: string             // '{{product_image}}' or a static URL
  objectFit: 'cover' | 'contain' | 'fill' | 'ai_extend'
  borderRadius: number
}

export interface RectangleLayer extends BaseLayer {
  type: 'rectangle'
  backgroundColor: string
  borderRadius: number
  borderWidth: number
  borderColor: string
}

export interface BadgeLayer extends BaseLayer {
  type: 'badge'
  content: string          // e.g. '{{discount_percentage}}% OFF'
  backgroundColor: string
  color: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  borderRadius: number
  shape: 'rectangle' | 'circle'
}

export interface LogoLayer extends BaseLayer {
  type: 'logo'
  src: string             // uploaded logo URL
  objectFit: 'contain' | 'cover'
  borderRadius: number
}

// A pre-built design uploaded as PNG/JPG. `placement` decides whether it sits
// above the product (a transparent frame/design) or below it (a background).
// Rendering respects this via zIndex at composite time, but we keep the flag
// explicit so the UI and resolver can reason about it.
export interface OverlayLayer extends BaseLayer {
  type: 'overlay'
  src: string             // uploaded design URL (Cloudinary)
  objectFit: 'cover' | 'contain' | 'fill'
  placement: 'above' | 'below'  // above = frame over product, below = background
}

// A small decorative PNG (e.g. "NEW", a ribbon, sparkles) placed on top.
// Renders identically to a logo; separated for clearer UX + defaults.
export interface StickerLayer extends BaseLayer {
  type: 'sticker'
  src: string
  objectFit: 'contain' | 'cover'
  borderRadius: number
}

export type Layer =
  | TextLayer
  | ImageLayer
  | RectangleLayer
  | BadgeLayer
  | LogoLayer
  | OverlayLayer
  | StickerLayer

export interface Template {
  id: string
  user_id: string
  category_id: string | null
  name: string
  description: string | null
  canvas_data: CanvasData
  thumbnail_url: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface TemplateCategory {
  id: string
  user_id: string
  name: string
  created_at: string
}

// Dynamic variable keys
export const DYNAMIC_VARIABLES = [
  { key: '{{title}}',               label: 'Product Title' },
  { key: '{{price}}',               label: 'Price (₹)' },
  { key: '{{compare_price}}',       label: 'Compare Price (₹)' },
  { key: '{{discount_percentage}}', label: 'Discount %' },
  { key: '{{vendor}}',              label: 'Vendor' },
  { key: '{{product_type}}',        label: 'Product Type' },
  { key: '{{product_image}}',       label: 'Product Image' },
]

export function resolveVariables(
  content: string,
  product: {
    title: string
    price: number
    compare_at_price: number | null
    vendor: string | null
    product_type: string | null
  }
): string {
  const discount =
    product.compare_at_price && product.compare_at_price > product.price
      ? Math.round(((product.compare_at_price - product.price) / product.compare_at_price) * 100)
      : 0

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(n)

  return content
    .replace(/{{title}}/g, product.title)
    .replace(/{{price}}/g, fmt(product.price))
    .replace(/{{compare_price}}/g, product.compare_at_price ? fmt(product.compare_at_price) : '')
    .replace(/{{discount_percentage}}/g, discount.toString())
    .replace(/{{vendor}}/g, product.vendor || '')
    .replace(/{{product_type}}/g, product.product_type || '')
}

export type AspectRatio = '1:1' | '4:5' | '9:16' | '16:9' | '1.91:1' | 'custom'

export const ASPECT_RATIOS: { label: string; value: AspectRatio; width: number; height: number }[] = [
  { label: '1:1 Square (1080×1080)', value: '1:1',    width: 1080, height: 1080 },
  { label: '4:5 Portrait',           value: '4:5',    width: 1080, height: 1350 },
  { label: '9:16 Story',             value: '9:16',   width: 1080, height: 1920 },
  { label: '16:9 Landscape',         value: '16:9',   width: 1920, height: 1080 },
  { label: '1.91:1 Facebook',        value: '1.91:1', width: 1200, height: 628  },
]

// ─── Smart Background ────────────────────────────────────────────────────────
// All fields are optional so existing saved templates stay backward-compatible.
// The compositor and canvas-preview both fall back to 'solid' when absent.

export type BackgroundMode =
  | 'solid'        // plain backgroundColor (existing default)
  | 'smart'        // color-analysis + blur-extend (AI-feel, all client/server canvas)
  | 'blur-extend'  // blurred + zoomed copy of the image behind it (Instagram style)
  | 'gradient'     // 2-stop gradient derived from image OR user-chosen colors
  | 'transparent'  // alpha-0 fill (for PNG exports)
  | 'original'     // opt-in: the ORIGINAL photo's own background, with only the
                    // product region AI-inpainted (Cloudinary Generative Remove).
                    // Only has an effect in ai_product mode with a successful
                    // cutout — falls back to 'solid' otherwise (enforced in
                    // serverRenderBackground, not here).

export interface GradientStop {
  color: string   // hex
  position: number // 0–100
}

export interface BackgroundSettings {
  mode: BackgroundMode
  // blur-extend / smart
  blurStrength: number    // 0–40, default 20
  blendStrength: number   // 0–1, default 0.85
  // gradient
  gradientAngle: number   // degrees, default 135
  gradientStops: GradientStop[]
  // whether to auto-derive gradient/smart colors from the image
  autoColors: boolean
}

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  mode: 'solid',
  blurStrength: 20,
  blendStrength: 0.85,
  gradientAngle: 135,
  gradientStops: [
    { color: '#f0f0f0', position: 0 },
    { color: '#d0d0d0', position: 100 },
  ],
  autoColors: true,
}

export interface CanvasData {
  width: number
  height: number
  aspectRatio: AspectRatio
  backgroundColor: string
  backgroundImageUrl: string | null
  layers: Layer[]
  backgroundSettings?: BackgroundSettings
  templateMode?: TemplateMode
  productLayerSettings?: ProductLayerSettings
  productPositioningSettings?: ProductPositioningSettings
}

// ─── AI Product Mode ─────────────────────────────────────────────────────────
// When templateMode = 'ai_product', background removal runs on the product image.
// The transparent product is placed as an independent floating layer.
//
// templateMode = 'product_zoom': no background removal, no cutout. The
// original photo (background + model + product) is treated as a single,
// unmodified image that is only ever zoomed/panned as one rigid unit to hit
// the configured Head Space / Bottom Space — see compositor.ts's
// `product_zoom` branch and product-positioning.ts (reused as-is).

export type TemplateMode = 'standard' | 'ai_product' | 'product_zoom'

export interface ProductLayerSettings {
  // Position (percentage of canvas)
  x: number           // default 10
  y: number           // default 10
  width: number       // default 80
  height: number      // default 80
  // Transform
  rotation: number    // degrees, default 0
  opacity: number     // 0-1, default 1
  // Fit
  objectFit: 'contain' | 'cover' | 'fill'  // default 'contain'
  // Effects
  shadow: boolean
  shadowColor: string     // default 'rgba(0,0,0,0.3)'
  shadowBlur: number      // px, default 20
  shadowOffsetX: number   // px, default 0
  shadowOffsetY: number   // px, default 10
  glow: boolean
  glowColor: string       // default 'rgba(255,255,255,0.6)'
  glowBlur: number        // px, default 15
  // Layer order (zIndex relative to other layers)
  zIndex: number          // default 5
  // Padding inside bounding box
  padding: number         // %, default 0
  // Manual (Canva-style) transforms — all optional so pre-existing saved
  // templates (which lack them) read as falsy = identity, fully backward
  // compatible. flip mirrors the cutout; locked disables canvas manipulation.
  flipH?: boolean         // default false
  flipV?: boolean         // default false
  locked?: boolean        // default false
}

/**
 * Sentinel selection id for the implicit product layer (ai_product mode). It's
 * NOT an entry in canvasData.layers, so this id intentionally never matches
 * canvasData.layers.find(...) — consumers that look up a real layer get
 * undefined (and handle it), while selection/toolbar logic can still key off it.
 */
export const PRODUCT_LAYER_ID = '__product__'

export const DEFAULT_PRODUCT_LAYER_SETTINGS: ProductLayerSettings = {
  x: 10,
  y: 5,
  width: 80,
  height: 80,
  rotation: 0,
  opacity: 1,
  objectFit: 'contain',
  shadow: true,
  shadowColor: 'rgba(0,0,0,0.25)',
  shadowBlur: 24,
  shadowOffsetX: 0,
  shadowOffsetY: 12,
  glow: false,
  glowColor: 'rgba(255,255,255,0.5)',
  glowBlur: 15,
  zIndex: 5,
  padding: 4,
  flipH: false,
  flipV: false,
  locked: false,
}

// ─── Product Positioning ("Head Space") ──────────────────────────────────────
// Aligns the product's visible bounding box to a consistent head position
// across all products rendered through a template. Classification (heuristic,
// no AI call) gates WHICH images this applies to — see src/lib/product-positioning.ts.
// All fields optional on CanvasData; absence or enabled:false is a byte-identical
// no-op with the pre-existing rendering path.

export type ShotType =
  | 'full_body'   // head-space applies
  | 'half_body'   // head-space applies
  | 'close_up'    // bypassed — renders exactly as today
  | 'detail'      // bypassed
  | 'flat_lay'    // bypassed
  | 'accessory'   // bypassed

export const SHOT_TYPES: ShotType[] = ['full_body', 'half_body', 'close_up', 'detail', 'flat_lay', 'accessory']

export interface ProductPositioningSettings {
  enabled: boolean                 // default false — master no-op switch
  headSpacePx: number              // default 120 — distance from canvas top to head
  leftMarginPx: number             // default 40
  rightMarginPx: number            // default 40
  bottomMarginPx: number           // default 40
  autoCenterHorizontally: boolean  // default true
  scaleMode: 'fit' | 'smart_fit'   // default 'smart_fit' — move first, scale only if required
  maxUpscale: number               // default 1.5 — never zoom more than this far beyond plain "contain"
  applyToShotTypes: ShotType[]     // default ['full_body', 'half_body']
  showGuide: boolean               // default true — editor-only static guide overlay toggle
}

export const DEFAULT_PRODUCT_POSITIONING_SETTINGS: ProductPositioningSettings = {
  enabled: false,
  headSpacePx: 120,
  leftMarginPx: 40,
  rightMarginPx: 40,
  bottomMarginPx: 40,
  autoCenterHorizontally: true,
  scaleMode: 'smart_fit',
  maxUpscale: 1.5,
  applyToShotTypes: ['full_body', 'half_body'],
  showGuide: true,
}