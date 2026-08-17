'use client'

import { shopifyFetch } from '@/lib/shopify-token'
import { useRef, useState } from 'react'
import { useBuilderStore } from '@/stores/builder-store'
import { Button } from '@/components/ui/button'
import { Type, Image as ImageIcon, Square, Tag, Upload, BadgePlus, Sticker, Loader2 } from 'lucide-react'
import { TextLayer, ImageLayer, RectangleLayer, BadgeLayer, LogoLayer, OverlayLayer, StickerLayer } from '@/types/template'
import { toast } from 'sonner'

async function uploadFile(file: File, kind: 'overlay' | 'logo' | 'sticker'): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  form.append('kind', kind)
  const res = await shopifyFetch('/api/upload', { method: 'POST', body: form })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Upload failed')
  return data.url as string
}

export function ToolBar() {
  const { addLayer } = useBuilderStore()
  const overlayInput = useRef<HTMLInputElement>(null)
  const logoInput = useRef<HTMLInputElement>(null)
  const stickerInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<'overlay' | 'logo' | 'sticker' | null>(null)

  function addText() {
    addLayer({
      type: 'text', x: 10, y: 10, width: 80, height: 10, rotation: 0, opacity: 1,
      content: '{{title}}', fontSize: 48, fontFamily: 'Inter, sans-serif', fontWeight: 'bold',
      color: '#000000', backgroundColor: null, borderRadius: 0, paddingX: 8, paddingY: 4,
      textAlign: 'left',
    } as Omit<TextLayer, 'id' | 'zIndex'>)
  }

  function addImage() {
    addLayer({
      type: 'image', x: 10, y: 10, width: 80, height: 80, rotation: 0, opacity: 1,
      src: '{{product_image}}', objectFit: 'cover', borderRadius: 8,
    } as Omit<ImageLayer, 'id' | 'zIndex'>)
  }

  function addRectangle() {
    addLayer({
      type: 'rectangle', x: 10, y: 10, width: 40, height: 20, rotation: 0, opacity: 1,
      backgroundColor: '#000000', borderRadius: 8, borderWidth: 0, borderColor: '#000000',
    } as Omit<RectangleLayer, 'id' | 'zIndex'>)
  }

  function addBadge() {
    addLayer({
      type: 'badge', x: 60, y: 5, width: 30, height: 12, rotation: 0, opacity: 1,
      content: '{{discount_percentage}}% OFF', backgroundColor: '#ef4444', color: '#ffffff',
      fontSize: 32, fontWeight: 'bold', borderRadius: 8, shape: 'rectangle',
    } as Omit<BadgeLayer, 'id' | 'zIndex'>)
  }

  async function onOverlayPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading('overlay')
    try {
      const url = await uploadFile(file, 'overlay')
      // Default placement is "above" (frame over product). Full-canvas size.
      addLayer({
        type: 'overlay', x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1,
        src: url, objectFit: 'contain', placement: 'above',
      } as Omit<OverlayLayer, 'id' | 'zIndex'>)
      toast.success('Template design added')
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setUploading(null)
      if (overlayInput.current) overlayInput.current.value = ''
    }
  }

  async function onLogoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading('logo')
    try {
      const url = await uploadFile(file, 'logo')
      addLayer({
        type: 'logo', x: 70, y: 5, width: 22, height: 12, rotation: 0, opacity: 1,
        src: url, objectFit: 'contain', borderRadius: 0,
      } as Omit<LogoLayer, 'id' | 'zIndex'>)
      toast.success('Logo added')
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setUploading(null)
      if (logoInput.current) logoInput.current.value = ''
    }
  }

  async function onStickerPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading('sticker')
    try {
      const url = await uploadFile(file, 'sticker')
      addLayer({
        type: 'sticker', x: 8, y: 8, width: 18, height: 18, rotation: 0, opacity: 1,
        src: url, objectFit: 'contain', borderRadius: 0,
      } as Omit<StickerLayer, 'id' | 'zIndex'>)
      toast.success('Sticker added')
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setUploading(null)
      if (stickerInput.current) stickerInput.current.value = ''
    }
  }

  const tools = [
    { label: 'Text', icon: Type, action: addText },
    { label: 'Image', icon: ImageIcon, action: addImage },
    { label: 'Rectangle', icon: Square, action: addRectangle },
    { label: 'Badge', icon: Tag, action: addBadge },
  ]

  return (
    <div className="p-3 border-b space-y-3">
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Add layer</p>
        <div className="grid grid-cols-2 gap-1.5">
          {tools.map(({ label, icon: Icon, action }) => (
            <Button key={label} variant="outline" size="sm"
              className="h-9 flex flex-col gap-0.5 text-xs" onClick={action}>
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Upload</p>
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="outline" size="sm" className="h-9 flex flex-col gap-0.5 text-xs"
            disabled={uploading !== null} onClick={() => overlayInput.current?.click()}>
            {uploading === 'overlay' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Template
          </Button>
          <Button variant="outline" size="sm" className="h-9 flex flex-col gap-0.5 text-xs"
            disabled={uploading !== null} onClick={() => logoInput.current?.click()}>
            {uploading === 'logo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgePlus className="h-3.5 w-3.5" />}
            Logo
          </Button>
          <Button variant="outline" size="sm" className="h-9 flex flex-col gap-0.5 text-xs"
            disabled={uploading !== null} onClick={() => stickerInput.current?.click()}>
            {uploading === 'sticker' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sticker className="h-3.5 w-3.5" />}
            Sticker
          </Button>
        </div>
      </div>

      <input ref={overlayInput} type="file" accept="image/png,image/jpeg,image/webp"
        className="hidden" onChange={onOverlayPick} />
      <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp"
        className="hidden" onChange={onLogoPick} />
      <input ref={stickerInput} type="file" accept="image/png,image/jpeg,image/webp"
        className="hidden" onChange={onStickerPick} />
    </div>
  )
}