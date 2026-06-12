import { create } from 'zustand'
import { Layer, CanvasData, TextLayer, ImageLayer, RectangleLayer, BadgeLayer } from '@/types/template'
import { nanoid } from 'nanoid'

// Install nanoid: npm install nanoid

interface BuilderStore {
  canvasData: CanvasData
  selectedLayerId: string | null
  isDirty: boolean

  // Canvas actions
  setBackgroundColor: (color: string) => void
  setBackgroundImage: (url: string | null) => void

  // Layer actions
  addLayer: (layer: Omit<Layer, 'id' | 'zIndex'>) => void
  updateLayer: (id: string, updates: Partial<Layer>) => void
  deleteLayer: (id: string) => void
  duplicateLayer: (id: string) => void
  moveLayerUp: (id: string) => void
  moveLayerDown: (id: string) => void
  selectLayer: (id: string | null) => void
  reorderLayers: (layers: Layer[]) => void

  // Template actions
  loadTemplate: (canvasData: CanvasData) => void
  resetDirty: () => void
}

const defaultCanvas: CanvasData = {
  width: 1000,
  height: 1000,
  backgroundColor: '#ffffff',
  backgroundImageUrl: null,
  layers: [],
}

export const useBuilderStore = create<BuilderStore>((set, get) => ({
  canvasData: defaultCanvas,
  selectedLayerId: null,
  isDirty: false,

  setBackgroundColor: (color) =>
    set(s => ({
      canvasData: { ...s.canvasData, backgroundColor: color },
      isDirty: true,
    })),

  setBackgroundImage: (url) =>
    set(s => ({
      canvasData: { ...s.canvasData, backgroundImageUrl: url },
      isDirty: true,
    })),

  addLayer: (layer) => {
    const layers = get().canvasData.layers
    const newLayer = {
      ...layer,
      id: nanoid(),
      zIndex: layers.length,
    } as Layer
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
      canvasData: {
        ...s.canvasData,
        layers: [...s.canvasData.layers, newLayer],
      },
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

  loadTemplate: (canvasData) =>
    set({ canvasData, selectedLayerId: null, isDirty: false }),

  resetDirty: () => set({ isDirty: false }),
}))