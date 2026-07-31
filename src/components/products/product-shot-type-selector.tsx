'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SHOT_TYPES, type ShotType } from '@/types/template'

const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  full_body: 'Full Body',
  half_body: 'Half Body',
  close_up: 'Close-up',
  detail: 'Detail',
  flat_lay: 'Flat Lay',
  accessory: 'Accessory',
}

const AUTO_VALUE = 'auto'

/**
 * Manual per-product shot-type override for Product Positioning — the
 * safety valve for when the free heuristic classifier (based on bounding-box
 * signals) misdetects a product's shot type. See src/lib/product-positioning.ts.
 */
export function ProductShotTypeSelector({
  productId,
  initialValue,
}: {
  productId: string
  initialValue: ShotType | null
}) {
  const [value, setValue] = useState<string>(initialValue ?? AUTO_VALUE)
  const [saving, setSaving] = useState(false)
  const router = useRouter()

  async function handleChange(next: string) {
    setValue(next)
    setSaving(true)
    const res = await fetch(`/api/products/${productId}/shot-type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotTypeOverride: next === AUTO_VALUE ? null : next }),
    })
    setSaving(false)
    if (res.ok) router.refresh()
  }

  return (
    <div className="flex items-center gap-2">
      {/* Label is dropped on narrower viewports so this control can share a row
          with the Generate button without overflowing it. The trigger still
          reads "Auto-detect"/the chosen type, so nothing becomes ambiguous. */}
      <span className="hidden whitespace-nowrap text-xs text-muted-foreground lg:inline">Shot type</span>
      <Select value={value} onValueChange={handleChange} disabled={saving}>
        <SelectTrigger className="h-8 w-32 text-xs lg:w-36" aria-label="Shot type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_VALUE}>Auto-detect</SelectItem>
          {SHOT_TYPES.map(type => (
            <SelectItem key={type} value={type}>{SHOT_TYPE_LABELS[type]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
