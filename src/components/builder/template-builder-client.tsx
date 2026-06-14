'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useBuilderStore } from '@/stores/builder-store'
import { CanvasPreview } from './canvas-preview'
import { LayerPanel } from './layer-panel'
import { LayerProperties } from './layer-properties'
import { ToolBar } from './toolbar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save, ArrowLeft, Loader2 } from 'lucide-react'
import { CanvasData, AspectRatio, ASPECT_RATIOS } from '@/types/template'
import Link from 'next/link'

interface Props {
  template?: {
    id: string
    name: string
    description: string | null
    category_id: string | null
    canvas_data: CanvasData
  }
  categories: { id: string; name: string }[]
}

export function TemplateBuilderClient({ template, categories }: Props) {
  const router = useRouter()
  const { canvasData, loadTemplate, isDirty, resetDirty, setAspectRatio } = useBuilderStore()
  const [name, setName] = useState(template?.name || 'Untitled template')
  const [categoryId, setCategoryId] = useState(template?.category_id || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (template?.canvas_data) {
      loadTemplate(template.canvas_data)
    } else {
      // New template — seed with base product image layer
      loadTemplate({
        width: 1000,
        height: 1000,
        aspectRatio: '1:1',
        backgroundColor: '#ffffff',
        backgroundImageUrl: null,
        layers: [
          {
            id: 'base-product-image',
            type: 'image',
            x: 0, y: 0, width: 100, height: 100,
            rotation: 0, opacity: 1, zIndex: 0,
            src: '{{product_image}}',
            objectFit: 'cover',
            borderRadius: 0,
          } as any,
        ],
      })
    }
  }, [template])

  async function handleSave() {
    setSaving(true)
    setError('')

    const payload = {
      name,
      category_id: categoryId || null,
      canvas_data: canvasData,
    }

    const url = template ? `/api/templates/${template.id}` : '/api/templates'
    const method = template ? 'PUT' : 'POST'

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Save failed')
    } else {
      resetDirty()
      const templateId = template?.id || data.template.id
      fetch(`/api/templates/${templateId}/thumbnail`, { method: 'POST' }).catch(() => {})
      if (!template) {
        router.push(`/dashboard/templates/${templateId}/edit`)
      } else {
        router.refresh()
      }
    }
    setSaving(false)
  }

  return (
    <div className="flex flex-col h-screen -m-6">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-card flex-shrink-0 gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Link href="/dashboard/templates">
            <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          {/* Template name */}
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            className="h-8 w-44 font-medium text-sm"
          />

          {/* Aspect ratio selector */}
          <Select
            value={canvasData.aspectRatio || '1:1'}
            onValueChange={v => setAspectRatio(v as AspectRatio)}
          >
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASPECT_RATIOS.map(r => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Category */}
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">No category</SelectItem>
              {categories.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {isDirty && <span className="text-xs text-muted-foreground">Unsaved</span>}
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving
              ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Saving…</>
              : <><Save className="h-3.5 w-3.5 mr-1.5" />Save</>
            }
          </Button>
        </div>
      </div>

      {/* Builder body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel */}
        <div className="w-56 border-r flex flex-col bg-card overflow-hidden flex-shrink-0">
          <ToolBar />
          <LayerPanel />
        </div>

        {/* Center canvas — scrollable so tall canvases don't overflow */}
        <div className="flex-1 bg-muted/30 flex items-center justify-center overflow-auto p-8">
          <CanvasPreview />
        </div>

        {/* Right panel */}
        <div className="w-64 border-l bg-card overflow-y-auto flex-shrink-0">
          <LayerProperties />
        </div>
      </div>
    </div>
  )
}