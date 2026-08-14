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

/** When a badge is drawn. Evaluated per variant at generation time. */
export type BadgeCondition = 'always' | 'if_sold_out' | 'if_on_sale'

/** Pre-styled badge looks offered in the editor. */
export type BadgePreset = 'sale' | 'new' | 'sold_out' | 'trending' | 'bestseller' | 'custom'

export interface BadgeLayer extends BaseLayer {
  type: 'badge'
  content: string          // e.g. '{discount_percent}'
  backgroundColor: string
  color: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  borderRadius: number
  shape: 'rectangle' | 'circle'
  /** Defaults to 'always' when absent, so pre-v2 badges keep rendering. */
  condition?: BadgeCondition
  preset?: BadgePreset
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

/**
 * Everything a template's dynamic fields can be resolved against.
 *
 * Variant fields are optional so a product-level render still works; when a
 * variant is supplied its price/sku win, because in v2 a creative is generated
 * per variant and must show that variant's own numbers.
 */
export interface TemplateFieldContext {
  title: string
  price: number
  compare_at_price: number | null
  vendor: string | null
  product_type: string | null
  sku?: string | null
  variant_title?: string | null
  inventory_quantity?: number | null
  option1?: string | null
  option2?: string | null
  option3?: string | null
  currency?: string
}

/** Tokens offered by the editor's field picker. */
export const TEMPLATE_FIELDS = [
  '{product_title}', '{variant_title}', '{price}', '{compare_at_price}',
  '{discount_percent}', '{vendor}', '{sku}', '{inventory_qty}',
  '{option1}', '{option2}', '{option3}',
] as const

/**
 * Substitute dynamic fields in a text/badge layer's content.
 *
 * Accepts both the v2 single-brace tokens ({product_title}) and the legacy
 * double-brace ones ({{title}}). Longer names are replaced before shorter ones
 * so {compare_at_price} cannot be partially eaten by the {price} rule.
 *
 * An unknown token is left verbatim rather than blanked — a visible
 * "{prodcut_title}" in a preview tells the author they typo'd, whereas an empty
 * string looks like missing data and gets debugged against the catalog instead.
 */
export function resolveTemplateFields(
  content: string,
  ctx: TemplateFieldContext
): string {
  if (!content) return ''

  const price = Number(ctx.price ?? 0)
  const compareAt = ctx.compare_at_price == null ? null : Number(ctx.compare_at_price)
  const onSale = compareAt !== null && compareAt > price
  const discount = onSale ? Math.round(((compareAt - price) / compareAt) * 100) : 0

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: ctx.currency || 'INR',
      maximumFractionDigits: 0,
    }).format(n)

  const variantTitle = ctx.variant_title && ctx.variant_title !== 'Default Title'
    ? ctx.variant_title
    : ''

  const values: Record<string, string> = {
    product_title:     ctx.title ?? '',
    variant_title:     variantTitle,
    price:             fmt(price),
    compare_at_price:  compareAt !== null ? fmt(compareAt) : '',
    discount_percent:  onSale ? `${discount}% OFF` : '',
    vendor:            ctx.vendor ?? '',
    product_type:      ctx.product_type ?? '',
    sku:               ctx.sku ?? '',
    inventory_qty:     ctx.inventory_quantity == null ? '' : String(ctx.inventory_quantity),
    option1:           ctx.option1 ?? '',
    option2:           ctx.option2 ?? '',
    option3:           ctx.option3 ?? '',
    // Legacy aliases — same values under the pre-v2 names.
    title:             ctx.title ?? '',
    compare_price:     compareAt !== null ? fmt(compareAt) : '',
    discount_percentage: String(discount),
  }

  let out = content
  for (const key of Object.keys(values).sort((a, b) => b.length - a.length)) {
    out = out
      .replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), values[key])
      .replace(new RegExp(`\\{${key}\\}`, 'g'), values[key])
  }
  return out
}

/** @deprecated Use resolveTemplateFields — kept so existing call sites compile. */
export function resolveVariables(
  content: string,
  product: TemplateFieldContext
): string {
  return resolveTemplateFields(content, product)
}

/**
 * Should a conditional badge render for this variant?
 *
 * Lets one template carry a SOLD OUT and a SALE badge and show the right one
 * per variant, instead of needing a separate template per state.
 */
export function badgeConditionMet(
  condition: BadgeCondition | undefined,
  ctx: { is_sold_out?: boolean | null; price?: number | null; compare_at_price?: number | null }
): boolean {
  if (!condition || condition === 'always') return true

  if (condition === 'if_sold_out') return Boolean(ctx.is_sold_out)

  if (condition === 'if_on_sale') {
    const price = Number(ctx.price ?? 0)
    const compareAt = ctx.compare_at_price == null ? null : Number(ctx.compare_at_price)
    return compareAt !== null && compareAt > price
  }

  return true
}

export type AspectRatio = '1:1' | '4:5' | '9:16' | '16:9' | '1.91:1' | '2:3' | 'custom'

export const ASPECT_RATIOS: { label: string; value: AspectRatio; width: number; height: number }[] = [
  { label: '1:1 Square (1080×1080)', value: '1:1',    width: 1080, height: 1080 },
  { label: '4:5 Portrait',           value: '4:5',    width: 1080, height: 1350 },
  { label: '2:3 Portrait (1200×1800)', value: '2:3',  width: 1200, height: 1800 },
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
  scaleMode: 'fit' | 'smart_fit' | 'fill'   // default 'smart_fit' — 'fill' = always zoom to satisfy both guides, cropping background from the sides if needed (never leaves a gap)
  maxUpscale: number               // default 1.5 — never zoom more than this far beyond plain "contain"
  applyToShotTypes: ShotType[]     // default ['full_body', 'half_body']
  showGuide: boolean               // default true — editor-only static guide overlay toggle
  aiExtend?: boolean               // default true — extend exposed canvas areas with AI when enabled
}

export const DEFAULT_PRODUCT_POSITIONING_SETTINGS: ProductPositioningSettings = {
  enabled: false,
  headSpacePx: 120,
  leftMarginPx: 0,    // 0 default in Zoom Mode — product fills edge-to-edge
  rightMarginPx: 0,   // 0 default in Zoom Mode
  bottomMarginPx: 0,  // 0 default in Zoom Mode
  autoCenterHorizontally: true,
  scaleMode: 'smart_fit',
  maxUpscale: 1.5,
  applyToShotTypes: ['full_body', 'half_body'],
  showGuide: true,
}