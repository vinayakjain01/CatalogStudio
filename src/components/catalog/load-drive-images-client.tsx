'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  FolderOpen, Loader2, CheckCircle2, AlertCircle,
  ImageIcon, XCircle, ExternalLink,
} from 'lucide-react'

interface Store {
  id: string
  shop_name: string
  display_name: string | null
  source: string
}

type State = 'idle' | 'loading' | 'done' | 'error'

export function LoadDriveImagesClient({ stores }: { stores: Store[] }) {
  const [folderUrl, setFolderUrl] = useState('')
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '')
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    totalImages: number
    matched: number
    uploaded: number
    failed: number
    message: string
    preview: { filename: string; sku: string; cloudinaryUrl: string }[]
    errors: { filename: string; reason: string }[]
  } | null>(null)

  async function handleLoad() {
    if (!folderUrl.trim()) { setError('Paste a Google Drive folder link'); return }
    if (!storeId) { setError('Select a catalog'); return }

    setState('loading')
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/catalog/load-drive-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, folderUrl: folderUrl.trim() }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to load images')
        setState('error')
        return
      }

      setResult(data)
      setState('done')
    } catch (err: any) {
      setError(err.message || 'Network error')
      setState('error')
    }
  }

  const storeName = (s: Store) => s.display_name || s.shop_name

  return (
    <div className="max-w-xl space-y-5">
      <Card>
        <CardContent className="p-6 space-y-5">
          {/* Store selector */}
          <div className="space-y-1.5">
            <p className="text-sm font-semibold">Catalog / Store</p>
            <Select value={storeId} onValueChange={setStoreId}>
              <SelectTrigger>
                <SelectValue placeholder="Select catalog" />
              </SelectTrigger>
              <SelectContent>
                {stores.map(s => (
                  <SelectItem key={s.id} value={s.id}>
                    {storeName(s)}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      ({s.source === 'line_sheet' ? 'Line Sheet' : 'Shopify'})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Drive folder URL */}
          <div className="space-y-1.5">
            <p className="text-sm font-semibold">Google Drive Folder Link</p>
            <Input
              placeholder="https://drive.google.com/drive/folders/..."
              value={folderUrl}
              onChange={e => { setFolderUrl(e.target.value); setError(null) }}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Folder must be shared as <strong>"Anyone with the link can view"</strong>.
              All images (.jpg, .png, .webp) will be loaded automatically.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2.5 rounded-md bg-destructive/5 border border-destructive/20 p-3">
              <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-sm text-destructive space-y-1">
                <p>{error}</p>
                {error.includes('GOOGLE_DRIVE_API_KEY') && (
                  <div className="mt-2 text-xs space-y-1 text-muted-foreground">
                    <p className="font-medium text-foreground">Setup steps (~2 min):</p>
                    <ol className="list-decimal list-inside space-y-0.5">
                      <li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="underline text-primary" rel="noreferrer">console.cloud.google.com</a></li>
                      <li>APIs & Services → Library → Enable "Google Drive API"</li>
                      <li>Credentials → Create Credentials → API Key</li>
                      <li>Add <code className="bg-muted px-1 rounded">GOOGLE_DRIVE_API_KEY=your_key</code> to Vercel env vars</li>
                      <li>Redeploy</li>
                    </ol>
                  </div>
                )}
              </div>
            </div>
          )}

          <Button
            onClick={handleLoad}
            disabled={state === 'loading' || !folderUrl.trim() || !storeId}
            className="w-full"
            size="lg"
          >
            {state === 'loading'
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Loading images from Drive…</>
              : <><FolderOpen className="h-4 w-4 mr-2" />Load All Images</>
            }
          </Button>
        </CardContent>
      </Card>

      {/* Result */}
      {state === 'done' && result && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-green-500 shrink-0" />
              <div>
                <p className="font-semibold">Images loaded</p>
                <p className="text-sm text-muted-foreground">{result.message}</p>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Found in Drive" value={result.totalImages} />
              <Stat label="Uploaded" value={result.uploaded} color="green" />
              <Stat label="Matched to products" value={result.matched} color="green" />
            </div>

            {/* Preview */}
            {result.preview.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">SAMPLE MATCHES</p>
                <div className="space-y-2">
                  {result.preview.map((p, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs">
                      <img
                        src={p.cloudinaryUrl}
                        alt={p.filename}
                        className="w-10 h-10 rounded object-cover border"
                        onError={(e) => { (e.target as HTMLImageElement).style.display='none' }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{p.filename}</p>
                        <p className="text-muted-foreground">→ SKU {p.sku}</p>
                      </div>
                      <a
                        href={p.cloudinaryUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline shrink-0"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Errors */}
            {result.failed > 0 && result.errors.length > 0 && (
              <div>
                <p className="text-xs font-medium text-amber-600 mb-1.5">
                  {result.failed} image{result.failed !== 1 ? 's' : ''} failed
                </p>
                <div className="bg-amber-50 dark:bg-amber-950/30 rounded-md p-2.5 space-y-1 max-h-28 overflow-y-auto">
                  {result.errors.slice(0, 8).map((e, i) => (
                    <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
                      {e.filename}: {e.reason}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.href = '/dashboard/products'}
              >
                <ImageIcon className="h-3.5 w-3.5 mr-1.5" />
                View products with images
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setState('idle'); setResult(null); setFolderUrl('') }}
              >
                Load another folder
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: 'green' }) {
  return (
    <div className="bg-muted/40 rounded-lg p-3 text-center">
      <p className={`text-2xl font-bold ${color === 'green' ? 'text-green-600' : 'text-foreground'}`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}