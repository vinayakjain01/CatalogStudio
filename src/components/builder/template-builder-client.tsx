'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useBuilderStore } from '@/stores/builder-store'
import { CanvasPreview } from './canvas-preview'
import { LayerPanel } from './layer-panel'
import { LayerProperties } from './layer-properties'
import { ToolBar } from './toolbar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save, ArrowLeft, Loader2 } from 'lucide-react'
import { CanvasData } from '@/types/template'
import Link from 'next/link'

interface Props {
  template?: { id: string; name: string; description: string | null; category_id: string | null; canvas_data: CanvasData }
  categories: { id: string; name: string }[]
}

export function TemplateBuilderClient({ template, categories }: Props) {
  const router = useRouter()
  const { canvasData, loadTemplate, isDirty, resetDirty } = useBuilderStore()
  const [name, setName] = useState(template?.name || 'Untitled template')
  const [categoryId, setCategoryId] = useState(template?.category_id || 'none')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (template?.canvas_data) {
      loadTemplate(template.canvas_data)
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

      // Generate thumbnail in background — don't block navigation
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
    <div className="flex flex-col h-[calc(100vh-0px)] -m-6">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-card flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/templates">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            className="h-8 w-56 font-medium"
          />
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No category</SelectItem>
              {categories.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {isDirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-2" />}
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Builder body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Layer panel + Add tools */}
        <div className="w-56 border-r flex flex-col bg-card overflow-hidden">
          <ToolBar />
          <LayerPanel />
        </div>

        {/* Center: Canvas */}
        <div className="flex-1 bg-muted/30 flex items-center justify-center overflow-auto p-8">
          <CanvasPreview />
        </div>

        {/* Right: Properties panel */}
        <div className="w-64 border-l bg-card overflow-y-auto">
          <LayerProperties />
        </div>
      </div>
    </div>
  )
}