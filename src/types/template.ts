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
  objectFit: 'cover' | 'contain' | 'fill'
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
  { label: '1:1 Square',      value: '1:1',    width: 1000, height: 1000 },
  { label: '4:5 Portrait',    value: '4:5',    width: 1000, height: 1250 },
  { label: '9:16 Story',      value: '9:16',   width: 1000, height: 1778 },
  { label: '16:9 Landscape',  value: '16:9',   width: 1000, height: 563  },
  { label: '1.91:1 Facebook', value: '1.91:1', width: 1000, height: 524  },
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
  aspectRatio: AspectRatio   // NEW
  backgroundColor: string
  backgroundImageUrl: string | null
  layers: Layer[]
  // Smart background — optional; absent = backward-compat solid fill
  backgroundSettings?: BackgroundSettings
}