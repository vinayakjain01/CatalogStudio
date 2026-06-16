import { create } from 'zustand'
import { Layer, CanvasData, AspectRatio, ASPECT_RATIOS, BackgroundSettings, DEFAULT_BACKGROUND_SETTINGS } from '@/types/template'
import { nanoid } from 'nanoid'

// Shape of a preview product for live preview in the builder
export interface PreviewProduct {
  title: string
  price: number
  compare_at_price: number | null
  vendor: string | null
  product_type: string | null
  imageUrl: string | null
}

interface BuilderStore {
  canvasData: CanvasData
  selectedLayerId: string | null
  isDirty: boolean

  // NEW
  previewProduct: PreviewProduct | null
  setPreviewProduct: (product: PreviewProduct | null) => void

  setBackgroundColor: (color: string) => void
  setBackgroundImage: (url: string | null) => void
  setAspectRatio: (ratio: AspectRatio) => void
  setCanvasSize: (width: number, height: number) => void
  setBackgroundSettings: (settings: Partial<BackgroundSettings>) => void

  addLayer: (layer: Omit<Layer, 'id' | 'zIndex'>) => void
  updateLayer: (id: string, updates: Partial<Layer>) => void
  deleteLayer: (id: string) => void
  duplicateLayer: (id: string) => void
  moveLayerUp: (id: string) => void
  moveLayerDown: (id: string) => void
  selectLayer: (id: string | null) => void
  reorderLayers: (layers: Layer[]) => void

  loadTemplate: (canvasData: CanvasData) => void
  resetDirty: () => void
}

const defaultCanvas: CanvasData = {
  width: 1080,
  height: 1080,
  aspectRatio: '1:1',
  backgroundColor: '#ffffff',
  backgroundImageUrl: null,
  layers: [],
}

export const useBuilderStore = create<BuilderStore>((set, get) => ({
  canvasData: defaultCanvas,
  selectedLayerId: null,
  isDirty: false,

  // NEW
  previewProduct: null,
  setPreviewProduct: (product) => set({ previewProduct: product }),

  setBackgroundColor: (color) =>
    set(s => ({ canvasData: { ...s.canvasData, backgroundColor: color }, isDirty: true })),

  setBackgroundImage: (url) =>
    set(s => ({ canvasData: { ...s.canvasData, backgroundImageUrl: url }, isDirty: true })),

  setBackgroundSettings: (settings) =>
    set(s => ({
      canvasData: {
        ...s.canvasData,
        backgroundSettings: {
          ...(s.canvasData.backgroundSettings ?? DEFAULT_BACKGROUND_SETTINGS),
          ...settings,
        },
      },
      isDirty: true,
    })),

  setAspectRatio: (ratio) => {
    // 'custom' keeps the current pixel size; user edits it via setCanvasSize.
    if (ratio === 'custom') {
      set(s => ({
        canvasData: { ...s.canvasData, aspectRatio: 'custom' },
        isDirty: true,
      }))
      return
    }
    const preset = ASPECT_RATIOS.find(r => r.value === ratio)
    if (!preset) return
    set(s => ({
      canvasData: {
        ...s.canvasData,
        aspectRatio: ratio,
        width: preset.width,
        height: preset.height,
      },
      isDirty: true,
    }))
  },

  setCanvasSize: (width, height) => {
    // Clamp to sane bounds (Meta/IG creatives top out around 2048).
    const w = Math.max(200, Math.min(4000, Math.round(width) || 1080))
    const h = Math.max(200, Math.min(4000, Math.round(height) || 1080))
    set(s => ({
      canvasData: { ...s.canvasData, aspectRatio: 'custom', width: w, height: h },
      isDirty: true,
    }))
  },

  addLayer: (layer) => {
    const layers = get().canvasData.layers
    const newLayer = { ...layer, id: nanoid(), zIndex: layers.length } as Layer
    set(s => ({
      canvasData: { ...s.canvasData, layers: [...s.canvasData.layers, newLayer] },
      selectedLayerId: newLayer.id,
      isDirty: true,
    }))
  },

  updateLayer: (id, updates) =>
    set(s => ({
      canvasData: {
        ...s.canvasData,
        layers: s.canvasData.layers.map(l =>
          l.id === id ? ({ ...l, ...updates } as Layer) : l
        ),
      },
      isDirty: true,
    })),

  deleteLayer: (id) =>
    set(s => ({
      canvasData: {
        ...s.canvasData,
        layers: s.canvasData.layers.filter(l => l.id !== id),
      },
      selectedLayerId: s.selectedLayerId === id ? null : s.selectedLayerId,
      isDirty: true,
    })),

  duplicateLayer: (id) => {
    const layer = get().canvasData.layers.find(l => l.id === id)
    if (!layer) return
    const newLayer = { ...layer, id: nanoid(), x: layer.x + 2, y: layer.y + 2 }
    set(s => ({
      canvasData: { ...s.canvasData, layers: [...s.canvasData.layers, newLayer] },
      selectedLayerId: newLayer.id,
      isDirty: true,
    }))
  },

  moveLayerUp: (id) => {
    const layers = [...get().canvasData.layers]
    const idx = layers.findIndex(l => l.id === id)
    if (idx < layers.length - 1) {
      ;[layers[idx], layers[idx + 1]] = [layers[idx + 1], layers[idx]]
      set(s => ({ canvasData: { ...s.canvasData, layers }, isDirty: true }))
    }
  },

  moveLayerDown: (id) => {
    const layers = [...get().canvasData.layers]
    const idx = layers.findIndex(l => l.id === id)
    if (idx > 0) {
      ;[layers[idx], layers[idx - 1]] = [layers[idx - 1], layers[idx]]
      set(s => ({ canvasData: { ...s.canvasData, layers }, isDirty: true }))
    }
  },

  selectLayer: (id) => set({ selectedLayerId: id }),

  reorderLayers: (layers) =>
    set(s => ({ canvasData: { ...s.canvasData, layers }, isDirty: true })),

  loadTemplate: (canvasData) => {
  // Guarantee width/height always exist
  if (!canvasData.width) canvasData = { ...canvasData, width: 1080 }
  if (!canvasData.height) canvasData = { ...canvasData, height: 1080 }

  // Backfill aspectRatio for older templates
  if (!canvasData.aspectRatio) {
    const ratio = canvasData.height / canvasData.width
    let aspectRatio: AspectRatio = '1:1'
    if (ratio > 1.7) aspectRatio = '9:16'
    else if (ratio > 1.1) aspectRatio = '4:5'
    else if (ratio < 0.6) aspectRatio = '16:9'
    else if (ratio < 0.8) aspectRatio = '1.91:1'
    canvasData = { ...canvasData, aspectRatio }
  }

  set({ canvasData, selectedLayerId: null, isDirty: false })
},

  resetDirty: () => set({ isDirty: false }),
}))