'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Upload, Link, FileSpreadsheet, CheckCircle2, XCircle,
  Loader2, Download, AlertCircle, ChevronRight,
} from 'lucide-react'

type Step = 'source' | 'upload' | 'preview' | 'importing' | 'done'

interface ColumnMapRow {
  rawColumn: string
  detected: string | null
  userOverride: string | null
}

const CANONICAL_FIELDS = [
  { value: 'skip', label: '— Skip this column —' },
  { value: 'sku', label: 'SKU / Product Code' },
  { value: 'title', label: 'Product Name / Title' },
  { value: 'description', label: 'Description' },
  { value: 'price', label: 'Price' },
  { value: 'compare_at_price', label: 'Compare At Price' },
  { value: 'image_url', label: 'Image URL' },
  { value: 'vendor', label: 'Vendor / Brand' },
  { value: 'product_type', label: 'Product Type / Category' },
  { value: 'tags', label: 'Tags' },
  { value: 'inventory_quantity', label: 'Inventory / Quantity' },
]

export function CatalogImportClient({
  existingCatalogs,
}: {
  existingCatalogs: { id: string; shop_name: string; created_at: string }[]
}) {
  const [step, setStep] = useState<Step>('source')
  const [sourceType, setSourceType] = useState<'file' | 'url'>('file')
  const [urlInput, setUrlInput] = useState('')
  const [catalogName, setCatalogName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [storeId, setStoreId] = useState<string | null>(null)
  const [importId, setImportId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Preview state
  const [preview, setPreview] = useState<{
    headers: string[]
    sampleRows: Record<string, unknown>[]
    totalRows: number
    detectedColumnMap: Record<string, string | null>
  } | null>(null)
  const [columnMap, setColumnMap] = useState<ColumnMapRow[]>([])

  // Import result
  const [importResult, setImportResult] = useState<{
    imported: number
    failed: number
    errors: { row: number; reason: string }[]
  } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handlePreview() {
    if (!catalogName.trim()) {
      setError('Please enter a catalog name')
      return
    }
    if (sourceType === 'file' && !selectedFile) {
      setError('Please select a file')
      return
    }
    if (sourceType === 'url' && !urlInput.trim()) {
      setError('Please enter a URL')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // 1. Create line-sheet store
      const storeRes = await fetch('/api/catalog/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: catalogName }),
      })
      const storeData = await storeRes.json()
      if (!storeRes.ok) throw new Error(storeData.error)
      setStoreId(storeData.storeId)

      // 2. Preview parse
      let previewRes: Response
      if (sourceType === 'file' && selectedFile) {
        const form = new FormData()
        form.append('file', selectedFile)
        form.append('store_id', storeData.storeId)
        previewRes = await fetch('/api/catalog/import?preview=true', {
          method: 'POST',
          body: form,
        })
      } else {
        previewRes = await fetch('/api/catalog/import?preview=true', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlInput.trim(), store_id: storeData.storeId }),
        })
      }

      const previewData = await previewRes.json()
      if (!previewRes.ok) throw new Error(previewData.error)

      setPreview(previewData)
      // Build column map rows from detected map
      setColumnMap(
        previewData.headers.map((h: string) => ({
          rawColumn: h,
          detected: previewData.detectedColumnMap[h] || null,
          userOverride: null,
        }))
      )
      setStep('preview')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleImport() {
    if (!storeId || !preview) return
    setLoading(true)
    setError(null)
    setStep('importing')

    // Build final column map from user overrides
    const finalMap: Record<string, string | null> = {}
    for (const row of columnMap) {
      const val = row.userOverride ?? row.detected
      finalMap[row.rawColumn] = val === 'skip' ? null : val
    }

    try {
      let res: Response
      if (sourceType === 'file' && selectedFile) {
        const form = new FormData()
        form.append('file', selectedFile)
        form.append('store_id', storeId)
        form.append('column_map', JSON.stringify(finalMap))
        res = await fetch('/api/catalog/import', { method: 'POST', body: form })
      } else {
        res = await fetch('/api/catalog/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlInput.trim(), store_id: storeId, column_map: finalMap }),
        })
      }

      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setImportId(data.importId)
      setImportResult({ imported: data.imported, failed: data.failed, errors: data.errors || [] })
      setStep('done')
    } catch (err: any) {
      setError(err.message)
      setStep('preview')
    } finally {
      setLoading(false)
    }
  }

  function downloadExport(format: 'xlsx' | 'csv') {
    if (!importId) return
    window.open(`/api/catalog/export?importId=${importId}&format=${format}`, '_blank')
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Existing catalogs */}
      {existingCatalogs.length > 0 && step === 'source' && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium mb-3">Previous imports</p>
            <div className="space-y-2">
              {existingCatalogs.slice(0, 5).map(c => (
                <div key={c.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/40">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{c.shop_name}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => window.open(`/dashboard/products?storeId=${c.id}`, '_self')}
                    >
                      View products
                    </Button>
                    <Button
                      variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => {
                        setStoreId(c.id)
                        setImportId(c.id)
                        setStep('done')
                      }}
                    >
                      <Download className="h-3 w-3 mr-1" />Export
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Source selection */}
      {(step === 'source' || step === 'upload') && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <p className="text-sm font-medium mb-2">Catalog name</p>
              <Input
                placeholder="e.g. Spring 2025 Collection"
                value={catalogName}
                onChange={e => setCatalogName(e.target.value)}
                className="max-w-sm"
              />
            </div>

            <div>
              <p className="text-sm font-medium mb-3">Import source</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setSourceType('file')}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    sourceType === 'file' ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <Upload className="h-5 w-5 mb-2 text-primary" />
                  <p className="text-sm font-medium">Upload file</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Excel (.xlsx, .xls) or CSV</p>
                </button>
                <button
                  onClick={() => setSourceType('url')}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    sourceType === 'url' ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <Link className="h-5 w-5 mb-2 text-primary" />
                  <p className="text-sm font-medium">Google Sheets / Drive</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Paste a sharing link</p>
                </button>
              </div>
            </div>

            {sourceType === 'file' && (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
                >
                  {selectedFile ? (
                    <div className="flex items-center justify-center gap-2">
                      <FileSpreadsheet className="h-5 w-5 text-primary" />
                      <span className="text-sm font-medium">{selectedFile.name}</span>
                      <span className="text-xs text-muted-foreground">
                        ({(selectedFile.size / 1024).toFixed(0)} KB)
                      </span>
                    </div>
                  ) : (
                    <>
                      <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-50" />
                      <p className="text-sm font-medium">Click to select file</p>
                      <p className="text-xs text-muted-foreground mt-1">.xlsx, .xls, or .csv</p>
                    </>
                  )}
                </div>
              </div>
            )}

            {sourceType === 'url' && (
              <div>
                <Input
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  Make sure the file is shared as "Anyone with the link can view"
                </p>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <Button onClick={handlePreview} disabled={loading} className="w-full sm:w-auto">
              {loading
                ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Parsing file…</>
                : <>Preview & map columns <ChevronRight className="h-4 w-4 ml-1" /></>
              }
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step: Column mapping preview */}
      {step === 'preview' && preview && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium">Column mapping</p>
                <Badge variant="outline">{preview.totalRows} rows detected</Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Review how your columns are mapped. Green = auto-detected. You can override any mapping.
              </p>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {columnMap.map((row, i) => (
                  <div key={row.rawColumn} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono truncate text-foreground">{row.rawColumn}</p>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="w-52 shrink-0">
                      <Select
                        value={row.userOverride ?? row.detected ?? 'skip'}
                        onValueChange={val => {
                          setColumnMap(prev => prev.map((r, idx) =>
                            idx === i ? { ...r, userOverride: val === row.detected ? null : val } : r
                          ))
                        }}
                      >
                        <SelectTrigger className={`h-7 text-xs ${
                          (row.userOverride ?? row.detected) && (row.userOverride ?? row.detected) !== 'skip'
                            ? 'border-green-500/50 bg-green-500/5 text-green-700 dark:text-green-400'
                            : ''
                        }`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CANONICAL_FIELDS.map(f => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Sample data preview */}
          {preview.sampleRows.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-medium mb-2 text-muted-foreground">SAMPLE DATA (first 3 rows)</p>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="border-b">
                        {preview.headers.slice(0, 6).map(h => (
                          <th key={h} className="pb-1.5 pr-4 text-left font-medium text-muted-foreground">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sampleRows.map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          {preview.headers.slice(0, 6).map(h => (
                            <td key={h} className="py-1.5 pr-4 text-muted-foreground truncate max-w-32">
                              {String(row[h] || '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep('source')}>
              Back
            </Button>
            <Button onClick={handleImport} disabled={loading}>
              {loading
                ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Importing…</>
                : <>Import {preview.totalRows} products</>
              }
            </Button>
          </div>
        </div>
      )}

      {/* Step: Importing progress */}
      {step === 'importing' && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="font-medium">Importing products…</p>
            <p className="text-sm text-muted-foreground text-center">
              Downloading images and creating product records. This may take a minute for large catalogs.
            </p>
            <Progress value={undefined} className="w-full h-1.5 animate-pulse" />
          </CardContent>
        </Card>
      )}

      {/* Step: Done */}
      {step === 'done' && importResult && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-3">
              {importResult.failed === 0 ? (
                <CheckCircle2 className="h-6 w-6 text-green-500 shrink-0" />
              ) : (
                <AlertCircle className="h-6 w-6 text-amber-500 shrink-0" />
              )}
              <div>
                <p className="font-medium">Import complete</p>
                <p className="text-sm text-muted-foreground">
                  {importResult.imported} products imported successfully
                  {importResult.failed > 0 ? `, ${importResult.failed} failed` : ''}
                </p>
              </div>
            </div>

            {importResult.errors.length > 0 && (
              <div className="bg-destructive/5 rounded-lg p-3 space-y-1 max-h-40 overflow-y-auto">
                {importResult.errors.slice(0, 10).map((e, i) => (
                  <p key={i} className="text-xs text-destructive">
                    Row {e.row}: {e.reason}
                  </p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.href = `/dashboard/products`}
              >
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
                View products
              </Button>
              {importId && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadExport('xlsx')}
                  >
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    Download Excel with creatives
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadExport('csv')}
                  >
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    Download CSV
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStep('source')
                  setSelectedFile(null)
                  setUrlInput('')
                  setCatalogName('')
                  setPreview(null)
                  setImportResult(null)
                  setImportId(null)
                  setStoreId(null)
                  setError(null)
                }}
              >
                Import another
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}