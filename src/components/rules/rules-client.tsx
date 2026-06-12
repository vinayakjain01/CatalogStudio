'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Trash2, Plus, Zap, ArrowRight } from 'lucide-react'

const RULE_TYPES = [
  { value: 'tag', label: 'Tag' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'product_type', label: 'Product Type' },
  { value: 'discount', label: 'Discount %' },
  { value: 'default', label: 'Default (all products)' },
]

const OPERATORS: Record<string, { value: string; label: string }[]> = {
  tag: [{ value: 'equals', label: 'equals' }, { value: 'contains', label: 'contains' }],
  vendor: [{ value: 'equals', label: 'equals' }, { value: 'contains', label: 'contains' }],
  product_type: [{ value: 'equals', label: 'equals' }, { value: 'contains', label: 'contains' }],
  discount: [
    { value: 'greater_than', label: 'greater than' },
    { value: 'less_than', label: 'less than' },
    { value: 'equals', label: 'equals' },
  ],
  default: [{ value: 'equals', label: 'matches all' }],
}

interface Rule {
  id: string
  rule_type: string
  rule_operator: string
  rule_value: string
  priority: number
  is_active: boolean
  templates: { id: string; name: string }
}

interface Props {
  stores: { id: string; shop_name: string; shop_domain: string }[]
  templates: { id: string; name: string }[]
}

export function RulesClient({ stores, templates }: Props) {
  const [selectedStore, setSelectedStore] = useState(stores[0]?.id || '')
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(false)

  // New rule form
  const [ruleType, setRuleType] = useState('tag')
  const [operator, setOperator] = useState('equals')
  const [ruleValue, setRuleValue] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [priority, setPriority] = useState(0)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (selectedStore) fetchRules()
  }, [selectedStore])

  async function fetchRules() {
    setLoading(true)
    const res = await fetch(`/api/rules?storeId=${selectedStore}`)
    const data = await res.json()
    setRules(data.rules || [])
    setLoading(false)
  }

  async function handleAdd() {
    if (!templateId || !selectedStore) return
    setAdding(true)

    const res = await fetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: selectedStore,
        template_id: templateId,
        rule_type: ruleType,
        rule_operator: operator,
        rule_value: ruleType === 'default' ? 'all' : ruleValue,
        priority,
      }),
    })
    const data = await res.json()
    if (res.ok) {
      setRules(prev => [data.rule, ...prev])
      setRuleValue('')
      setTemplateId('')
    }
    setAdding(false)
  }

  async function handleDelete(ruleId: string) {
    await fetch(`/api/rules/${ruleId}`, { method: 'DELETE' })
    setRules(prev => prev.filter(r => r.id !== ruleId))
  }

  if (stores.length === 0) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        <p>No stores connected. Go to Settings first.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Store selector */}
      {stores.length > 1 && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Store:</span>
          <Select value={selectedStore} onValueChange={setSelectedStore}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stores.map(s => (
                <SelectItem key={s.id} value={s.id}>{s.shop_name || s.shop_domain}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Add rule form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add rule
          </CardTitle>
          <CardDescription>
            Rules are evaluated in priority order (highest first). First match wins.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground font-medium">IF</span>
            <Select value={ruleType} onValueChange={v => { setRuleType(v); setOperator(OPERATORS[v][0].value) }}>
              <SelectTrigger className="w-40 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_TYPES.map(r => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={operator} onValueChange={setOperator}>
              <SelectTrigger className="w-36 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(OPERATORS[ruleType] || []).map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {ruleType !== 'default' && (
              <Input
                value={ruleValue}
                onChange={e => setRuleValue(e.target.value)}
                placeholder={ruleType === 'discount' ? 'e.g. 30' : 'e.g. Saree'}
                className="w-32 h-8 text-sm"
              />
            )}

            <span className="text-muted-foreground font-medium">→ APPLY</span>

            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger className="w-48 h-8">
                <SelectValue placeholder="Select template…" />
              </SelectTrigger>
              <SelectContent>
                {templates.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-1">
              <span className="text-muted-foreground text-xs">Priority:</span>
              <Input
                type="number"
                value={priority}
                onChange={e => setPriority(parseInt(e.target.value) || 0)}
                className="w-16 h-8 text-xs"
              />
            </div>
          </div>

          <Button
            size="sm"
            onClick={handleAdd}
            disabled={adding || !templateId || (ruleType !== 'default' && !ruleValue)}
          >
            {adding ? 'Adding…' : 'Add rule'}
          </Button>
        </CardContent>
      </Card>

      {/* Rules list */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Active rules ({rules.length})
        </h2>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!loading && rules.length === 0 && (
          <div className="text-center py-10 text-muted-foreground border-2 border-dashed rounded-lg">
            <Zap className="h-7 w-7 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No rules yet. Add one above.</p>
          </div>
        )}

        {rules.map(rule => (
          <div
            key={rule.id}
            className="flex items-center justify-between p-3 rounded-lg border bg-card"
          >
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <Badge variant="outline" className="text-xs">P{rule.priority}</Badge>
              <span className="text-muted-foreground">IF</span>
              <span className="font-medium">{RULE_TYPES.find(r => r.value === rule.rule_type)?.label}</span>
              <span className="text-muted-foreground">{rule.rule_operator.replace('_', ' ')}</span>
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{rule.rule_value}</code>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium text-primary">{rule.templates?.name}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive flex-shrink-0"
              onClick={() => handleDelete(rule.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}