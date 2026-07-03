'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Upload, Link2, FileSpreadsheet, CheckCircle2, AlertCircle,
  Loader2, Download, ChevronRight, FolderOpen, Sparkles, XCircle,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'sheet' | 'columns' | 'drive' | 'importing' | 'done'

interface ColumnMapRow { rawColumn: string; detected: string | null; userOverride: string | null }

interface DriveFile {
  fileId: string; filename: string; normalizedName: string
  downloadUrl: string; driveViewUrl: string
}

interface DrivePreview {
  totalImages: number; matched: number; unmatched: number
  matchedSample: { sku: string; filename: string; previewUrl: string }[]
  unmatchedSkuSample: string[]
  files: DriveFile[]   // passed to map-images to skip re-scan
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CANONICAL_FIELDS = [
  { value: 'skip',               label: '— Skip this column —' },
  { value: 'sku',                label: '🔑 SKU / Product Code  ← needed for image matching' },
  { value: 'title',              label: 'Product Name / Title' },
  { value: 'price',              label: 'Price' },
  { value: 'compare_at_price',   label: 'Compare At Price' },
  { value: 'image_url',          label: 'Image URL (if in sheet)' },
  { value: 'vendor',             label: 'Vendor / Brand' },
  { value: 'product_type',       label: 'Product Type / Category' },
  { value: 'tags',               label: 'Tags' },
  { value: 'inventory_quantity', label: 'Inventory / Quantity' },
]

const LARGE_FILE_BYTES = 4 * 1024 * 1024  // 4 MB

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readJson(res: Response) {
  if (res.status === 413) return { error: 'File too large (>4MB). Use Google Sheets link instead.' }
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { error: text || 'Server error' } }
}

async function uploadToCloudinary(file: File, storeId: string): Promise<string> {
  const sigRes = await fetch('/api/catalog/upload-signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeId, filename: file.name }),
  })
  const sig = await readJson(sigRes)
  if (!sigRes.ok) throw new Error(sig.error)

  const form = new FormData()
  form.append('file', file)
  form.append('api_key', sig.apiKey)
  form.append('timestamp', String(sig.timestamp))
  form.append('public_id', sig.publicId)
  form.append('signature', sig.signature)

  const up = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/raw/upload`, {
    method: 'POST', body: form,
  })
  const d = await up.json().catch(() => null)
  if (!up.ok || !d?.secure_url) throw new Error(d?.error?.message || 'Upload failed')
  return d.secure_url
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CatalogImportClient({ existingCatalogs }: {
  existingCatalogs: { id: string; shop_name: string; created_at: string }[]
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  const [step, setStep]               = useState<Step>('sheet')
  const [catalogName, setCatalogName] = useState('')
  const [sourceType, setSourceType]   = useState<'file' | 'url'>('file')
  const [selectedFile, setFile]       = useState<File | null>(null)
  const [urlInput, setUrl]            = useState('')
  const [storeId, setStoreId]         = useState<string | null>(null)
  const [importId, setImportId]       = useState<string | null>(null)
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)
  const [loadingMsg, setMsg]          = useState('')

  const [preview, setPreview]         = useState<{ headers: string[]; sampleRows: Record<string,unknown>[]; totalRows: number; detectedColumnMap: Record<string,string|null> } | null>(null)
  const [colMap, setColMap]           = useState<ColumnMapRow[]>([])

  const [folderUrl, setFolderUrl]     = useState('')
  const [drivePreview, setDrivePreview] = useState<DrivePreview | null>(null)

  const [result, setResult]           = useState<{ imported: number; matched: number; skipped: number; errors: { sku?: string; reason: string }[] } | null>(null)

  // ── 1. Parse line sheet ──────────────────────────────────────────────────
  async function handleParseSheet() {
    if (!catalogName.trim()) { setError('Enter a catalog name'); return }
    if (sourceType === 'file' && !selectedFile) { setError('Select a file'); return }
    if (sourceType === 'url' && !urlInput.trim()) { setError('Enter a URL'); return }

    setLoading(true); setError(null); setMsg('Creating catalog…')

    try {
      // Create line-sheet store
      const sRes = await fetch('/api/catalog/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: catalogName }),
      })
      const sData = await readJson(sRes)
      if (!sRes.ok) throw new Error(sData.error)
      setStoreId(sData.storeId)

      // Preview parse
      setMsg('Reading line sheet…')
      let pRes: Response
      if (sourceType === 'file' && selectedFile) {
        let body: BodyInit
        let headers: Record<string, string> = {}
        if (selectedFile.size >= LARGE_FILE_BYTES) {
          setMsg('File large — uploading to storage first…')
          const url = await uploadToCloudinary(selectedFile, sData.storeId)
          body = JSON.stringify({ url, store_id: sData.storeId })
          headers = { 'Content-Type': 'application/json' }
        } else {
          const form = new FormData()
          form.append('file', selectedFile)
          form.append('store_id', sData.storeId)
          body = form
        }
        pRes = await fetch('/api/catalog/import?preview=true', { method: 'POST', body, headers: headers as any })
      } else {
        pRes = await fetch('/api/catalog/import?preview=true', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlInput.trim(), store_id: sData.storeId }),
        })
      }

      const pData = await readJson(pRes)
      if (!pRes.ok) throw new Error(pData.error)

      setPreview(pData)
      setColMap(pData.headers.map((h: string) => ({
        rawColumn: h,
        detected: pData.detectedColumnMap[h] || null,
        userOverride: null,
      })))
      setStep('columns')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false); setMsg('') }
  }

  // ── 2. Import products from sheet ────────────────────────────────────────
  async function handleImportProducts() {
    if (!storeId || !preview) return
    setLoading(true); setError(null)
    setMsg(`Importing ${preview.totalRows} products…`)

    const finalMap: Record<string, string | null> = {}
    for (const row of colMap) {
      const val = row.userOverride ?? row.detected
      finalMap[row.rawColumn] = val === 'skip' ? null : val
    }

    try {
      let res: Response
      if (sourceType === 'file' && selectedFile) {
        if (selectedFile.size >= LARGE_FILE_BYTES) {
          setMsg('Uploading file…')
          const url = await uploadToCloudinary(selectedFile, storeId)
          res = await fetch('/api/catalog/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, store_id: storeId, column_map: finalMap }),
          })
        } else {
          const form = new FormData()
          form.append('file', selectedFile)
          form.append('store_id', storeId)
          form.append('column_map', JSON.stringify(finalMap))
          res = await fetch('/api/catalog/import', { method: 'POST', body: form })
        }
      } else {
        res = await fetch('/api/catalog/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlInput.trim(), store_id: storeId, column_map: finalMap }),
        })
      }

      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error)

      setImportId(data.importId)
      setStep('drive')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false); setMsg('') }
  }

  // ── 3. Scan Drive folder + preview matches ───────────────────────────────
  async function handleScanFolder() {
    if (!folderUrl.trim()) { setError('Enter a Google Drive folder link'); return }
    if (!storeId || !importId) return
    setLoading(true); setError(null); setMsg('Scanning Google Drive folder…')
    setDrivePreview(null)

    try {
      // Get SKUs of imported products
      const skuRes = await fetch(`/api/catalog/products?storeId=${storeId}&importId=${importId}`)
      const skuData = skuRes.ok ? await skuRes.json() : { products: [] }
      const skus: string[] = (skuData.products || []).map((p: any) => p.sku).filter(Boolean)

      const folderRes = await fetch('/api/catalog/drive-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderUrl: folderUrl.trim(), skus }),
      })
      const folderData = await readJson(folderRes)
      if (!folderRes.ok) throw new Error(folderData.error)

      setDrivePreview({
        totalImages: folderData.totalImages,
        matched: folderData.matched,
        unmatched: folderData.unmatched,
        matchedSample: folderData.matchedSample || [],
        unmatchedSkuSample: folderData.unmatchedSkuSample || [],
        files: folderData.files || [],
      })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false); setMsg('') }
  }

  // ── 4. Download + upload images ──────────────────────────────────────────
  async function handleMapImages() {
    if (!storeId || !importId || !drivePreview) return
    setLoading(true); setError(null)
    setStep('importing')
    setMsg(`Downloading ${drivePreview.matched} images from Drive and uploading to Cloudinary…`)

    try {
      const res = await fetch('/api/catalog/map-images', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          importId, storeId,
          files: drivePreview.files,  // reuse already-scanned list, no double-fetch
        }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error)

      setResult({
        imported: data.total || 0,
        matched: data.matched || 0,
        skipped: data.skipped || 0,
        errors: data.errors || [],
      })
      setStep('done')
    } catch (e: any) {
      setError(e.message)
      setStep('drive')
    }
    finally { setLoading(false); setMsg('') }
  }

  function skipImages() {
    setResult({ imported: preview?.totalRows || 0, matched: 0, skipped: preview?.totalRows || 0, errors: [] })
    setStep('done')
  }

  function reset() {
    setStep('sheet'); setFile(null); setUrl(''); setCatalogName('')
    setPreview(null); setColMap([]); setResult(null); setImportId(null); setStoreId(null)
    setError(null); setDrivePreview(null); setFolderUrl('')
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl space-y-5">

      {/* Previous imports */}
      {existingCatalogs.length > 0 && step === 'sheet' && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium mb-3">Previous imports</p>
            <div className="space-y-2">
              {existingCatalogs.slice(0, 5).map(c => (
                <div key={c.id} className="flex items-center justify-between p-2.5 rounded-md bg-muted/40">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{c.shop_name}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => window.location.href = '/dashboard/products'}>
                      View products
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      onClick={() => window.open(`/api/catalog/export?importId=${c.id}&format=xlsx`, '_blank')}>
                      <Download className="h-3 w-3 mr-1" />Export
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── STEP 1: Sheet upload ──────────────────────────────────────────── */}
      {step === 'sheet' && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div className="space-y-1.5">
              <p className="text-sm font-semibold">Catalog name</p>
              <Input placeholder="e.g. GND Summer 2025"
                value={catalogName} onChange={e => setCatalogName(e.target.value)} />
            </div>

            <div>
              <p className="text-sm font-semibold mb-2.5">Line sheet source</p>
              <div className="grid grid-cols-2 gap-2.5">
                {(['file', 'url'] as const).map(t => (
                  <button key={t} onClick={() => setSourceType(t)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${sourceType === t ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'}`}>
                    {t === 'file'
                      ? <><Upload className="h-4 w-4 mb-2 text-primary" /><p className="text-xs font-semibold">Upload file</p><p className="text-xs text-muted-foreground">.xlsx, .xls, .csv</p></>
                      : <><Link2 className="h-4 w-4 mb-2 text-primary" /><p className="text-xs font-semibold">Google Sheets</p><p className="text-xs text-muted-foreground">Paste sharing link</p></>}
                  </button>
                ))}
              </div>
            </div>

            {sourceType === 'file' && (
              <>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                  onChange={e => setFile(e.target.files?.[0] || null)} />
                <div onClick={() => fileRef.current?.click()}
                  className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/40 transition-colors">
                  {selectedFile
                    ? <div className="flex items-center justify-center gap-2">
                        <FileSpreadsheet className="h-5 w-5 text-primary" />
                        <span className="text-sm font-medium">{selectedFile.name}</span>
                        <span className="text-xs text-muted-foreground">({(selectedFile.size/1024).toFixed(0)} KB)</span>
                      </div>
                    : <><Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-40" />
                        <p className="text-sm">Click to select file</p><p className="text-xs text-muted-foreground mt-0.5">.xlsx, .xls, or .csv</p></>}
                </div>
              </>
            )}

            {sourceType === 'url' && (
              <div>
                <Input placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={urlInput} onChange={e => setUrl(e.target.value)} />
                <p className="text-xs text-muted-foreground mt-1">Share as "Anyone with the link can view"</p>
              </div>
            )}

            {error && <Err msg={error} />}
            <Button onClick={handleParseSheet} disabled={loading} className="w-full">
              {loading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{loadingMsg}</>
                       : <>Read line sheet <ChevronRight className="h-4 w-4 ml-1.5" /></>}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── STEP 2: Column mapping ────────────────────────────────────────── */}
      {step === 'columns' && preview && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold">Map columns</p>
                <Badge variant="outline">{preview.totalRows} products</Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Make sure <strong>SKU / Product Code</strong> is mapped — it's used to match images from Google Drive.
              </p>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {colMap.map((row, i) => (
                  <div key={row.rawColumn} className="flex items-center gap-2.5">
                    <p className="flex-1 text-xs font-mono truncate text-muted-foreground">{row.rawColumn}</p>
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <div className="w-56 shrink-0">
                      <Select
                        value={row.userOverride ?? row.detected ?? 'skip'}
                        onValueChange={v => setColMap(prev => prev.map((r,idx) =>
                          idx === i ? { ...r, userOverride: v === r.detected ? null : v } : r))}
                      >
                        <SelectTrigger className={`h-7 text-xs ${
                          (row.userOverride ?? row.detected) && (row.userOverride ?? row.detected) !== 'skip'
                            ? 'border-green-500/60 bg-green-500/5 text-green-700 dark:text-green-400' : ''}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CANONICAL_FIELDS.map(f => (
                            <SelectItem key={f.value} value={f.value} className="text-xs">{f.label}</SelectItem>
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
              <CardContent className="p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">SAMPLE (first 3 rows)</p>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead><tr className="border-b">
                      {preview.headers.slice(0,4).map(h => (
                        <th key={h} className="pb-1.5 pr-4 text-left font-medium text-muted-foreground max-w-24 truncate">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {preview.sampleRows.map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          {preview.headers.slice(0,4).map(h => (
                            <td key={h} className="py-1.5 pr-4 text-muted-foreground max-w-24 truncate">{String(row[h] || '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {error && <Err msg={error} />}
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => { setStep('sheet'); setError(null) }}>Back</Button>
            <Button onClick={handleImportProducts} disabled={loading}>
              {loading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{loadingMsg}</>
                       : `Import ${preview.totalRows} products →`}
            </Button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Google Drive folder ───────────────────────────────────── */}
      {step === 'drive' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <FolderOpen className="h-4.5 w-4.5 text-primary" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Link product images from Google Drive</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Paste your Drive folder link. Images should be named after SKU codes —
                    e.g. <code className="bg-muted px-1 py-0.5 rounded">GND-1043.jpg</code> matches SKU <code className="bg-muted px-1 py-0.5 rounded">GND/1043</code>.
                  </p>
                </div>
              </div>

              <div>
                <Input
                  placeholder="https://drive.google.com/drive/folders/..."
                  value={folderUrl}
                  onChange={e => { setFolderUrl(e.target.value); setDrivePreview(null); setError(null) }}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Folder must be shared as "Anyone with the link can view"
                </p>
              </div>

              {/* Drive scan results */}
              {drivePreview && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                  <div className="flex items-center gap-4 text-sm flex-wrap">
                    <span className="text-muted-foreground">{drivePreview.totalImages} images in folder</span>
                    <span className="flex items-center gap-1 text-green-600 font-medium">
                      <CheckCircle2 className="h-3.5 w-3.5" />{drivePreview.matched} matched
                    </span>
                    {drivePreview.unmatched > 0 && (
                      <span className="flex items-center gap-1 text-amber-600">
                        <AlertCircle className="h-3.5 w-3.5" />{drivePreview.unmatched} unmatched SKUs
                      </span>
                    )}
                  </div>

                  {drivePreview.matchedSample.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">Matched pairs (preview):</p>
                      <div className="space-y-1.5">
                        {drivePreview.matchedSample.slice(0,5).map((m, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                            <code className="bg-muted px-1.5 rounded text-muted-foreground">{m.sku}</code>
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            <span className="text-foreground font-medium">{m.filename}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {drivePreview.unmatchedSkuSample.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Unmatched SKUs (no image found):</p>
                      <div className="flex flex-wrap gap-1.5">
                        {drivePreview.unmatchedSkuSample.slice(0,6).map((s, i) => (
                          <code key={i} className="bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded text-xs border border-amber-200 dark:border-amber-800">{s}</code>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {error && <Err msg={error} />}

              <div className="flex gap-2.5 flex-wrap">
                {!drivePreview ? (
                  <Button onClick={handleScanFolder} disabled={loading || !folderUrl.trim()}>
                    {loading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{loadingMsg}</>
                             : <><FolderOpen className="h-4 w-4 mr-1.5" />Scan folder &amp; preview matches</>}
                  </Button>
                ) : drivePreview.matched > 0 ? (
                  <Button onClick={handleMapImages} disabled={loading}>
                    <Sparkles className="h-4 w-4 mr-1.5" />
                    Import {drivePreview.matched} images
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => setDrivePreview(null)}>Try a different folder</Button>
                )}
                {drivePreview && (
                  <Button variant="outline" onClick={() => { setDrivePreview(null); setFolderUrl('') }}>
                    Rescan
                  </Button>
                )}
                <Button variant="ghost" onClick={skipImages} className="text-muted-foreground">
                  Skip — add images later
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Importing ─────────────────────────────────────────────────────── */}
      {step === 'importing' && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center gap-4 text-center">
            <Loader2 className="h-9 w-9 animate-spin text-primary" />
            <div>
              <p className="font-semibold">Importing images…</p>
              <p className="text-sm text-muted-foreground mt-1">{loadingMsg}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Done ─────────────────────────────────────────────────────────── */}
      {step === 'done' && result && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Import complete</p>
                <p className="text-sm text-muted-foreground">
                  {result.imported} products imported
                  {result.matched > 0 && ` · ${result.matched} images matched & uploaded`}
                  {result.skipped > 0 && ` · ${result.skipped} products without image`}
                </p>
              </div>
            </div>

            {result.errors.filter(e => !e.reason.includes('No matching image')).length > 0 && (
              <div className="bg-destructive/5 rounded-md p-3 max-h-32 overflow-y-auto space-y-1">
                {result.errors.filter(e => !e.reason.includes('No matching image')).slice(0,10).map((e,i) => (
                  <p key={i} className="text-xs text-destructive">
                    {e.sku ? `SKU ${e.sku}: ` : ''}{e.reason}
                  </p>
                ))}
              </div>
            )}

            <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-md text-xs text-blue-700 dark:text-blue-300">
              <strong>Next step:</strong> Go to Templates → create a template → Rules Engine → select "📁 Entire Line Sheet Import" → pick this catalog → Generate.
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm"
                onClick={() => window.location.href = '/dashboard/products'}>
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />View products
              </Button>
              {importId && (
                <>
                  <Button variant="outline" size="sm"
                    onClick={() => window.open(`/api/catalog/export?importId=${importId}&format=xlsx`, '_blank')}>
                    <Download className="h-3.5 w-3.5 mr-1.5" />Download Excel
                  </Button>
                  <Button variant="outline" size="sm"
                    onClick={() => window.open(`/api/catalog/export?importId=${importId}&format=csv`, '_blank')}>
                    <Download className="h-3.5 w-3.5 mr-1.5" />Download CSV
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" onClick={reset}>Import another</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Err({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded-md p-2.5">
      <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{msg}</span>
    </div>
  )
}