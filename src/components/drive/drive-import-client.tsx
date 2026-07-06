'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  FolderOpen, Loader2, CheckCircle2, XCircle,
  ArrowRight, ImageIcon, Wand2, Download,
} from 'lucide-react'

type State = 'idle' | 'loading' | 'done' | 'error'

interface Product {
  id: string
  title: string
  sku: string
  imageUrl: string
}

interface ImportResult {
  storeId: string
  importId: string | null
  total: number
  imported: number
  failed: number
  message: string
  products: Product[]
  errors: { filename: string; reason: string }[]
  setup?: string[]
}

export function DriveImportClient() {
  const [folderUrl, setFolderUrl]   = useState('')
  const [state, setState]           = useState<State>('idle')
  const [errorMsg, setErrorMsg]     = useState<string | null>(null)
  const [setupSteps, setSetupSteps] = useState<string[] | null>(null)
  const [result, setResult]         = useState<ImportResult | null>(null)

  async function handleImport() {
    const url = folderUrl.trim()
    if (!url) { setErrorMsg('Paste a Google Drive folder link'); return }

    setState('loading')
    setErrorMsg(null)
    setSetupSteps(null)
    setResult(null)

    try {
      const res = await fetch('/api/drive/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderUrl: url }),
      })
      const data: ImportResult & { error?: string; setup?: string[] } = await res.json()

      if (!res.ok) {
        setErrorMsg(data.error ?? 'Import failed')
        if (data.setup) setSetupSteps(data.setup)
        setState('error')
        return
      }

      setResult(data)
      setState('done')
    } catch (err: any) {
      setErrorMsg(err.message ?? 'Network error')
      setState('error')
    }
  }

  function reset() {
    setState('idle'); setFolderUrl(''); setErrorMsg(null)
    setSetupSteps(null); setResult(null)
  }

  return (
    <div className="max-w-2xl space-y-5">

      {/* ── Input card ─────────────────────────────────────────────────── */}
      {(state === 'idle' || state === 'error') && (
        <Card>
          <CardContent className="p-6 space-y-5">
            {/* Big URL input */}
            <div className="space-y-2">
              <label className="text-sm font-semibold">Google Drive Folder Link</label>
              <div className="flex gap-2">
                <Input
                  className="font-mono text-sm h-11 flex-1"
                  placeholder="https://drive.google.com/drive/folders/..."
                  value={folderUrl}
                  onChange={e => { setFolderUrl(e.target.value); setErrorMsg(null) }}
                  onKeyDown={e => e.key === 'Enter' && handleImport()}
                  autoFocus
                />
                <Button
                  size="lg"
                  onClick={handleImport}
                  disabled={!folderUrl.trim()}
                  className="h-11 px-6"
                >
                  Import
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Folder must be shared as <strong>"Anyone with the link can view"</strong>
              </p>
            </div>

            {/* What happens preview */}
            <div className="rounded-lg bg-muted/40 p-4">
              <p className="text-xs font-medium text-muted-foreground mb-3">WHAT HAPPENS</p>
              <div className="space-y-2.5">
                {[
                  { icon: FolderOpen,    text: 'All images in your Drive folder are loaded' },
                  { icon: ImageIcon,     text: 'Each image is uploaded to Cloudinary automatically' },
                  { icon: Wand2,         text: 'Apply any template — AI background removal, generative fill, text overlays' },
                  { icon: Download,      text: 'Download results as Excel with generated image URLs' },
                ].map(({ icon: Icon, text }, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <span className="text-muted-foreground">{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Error */}
            {errorMsg && (
              <div className="rounded-md bg-destructive/5 border border-destructive/20 p-4">
                <div className="flex items-start gap-2.5">
                  <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <div className="space-y-2 text-sm">
                    <p className="text-destructive font-medium">{errorMsg}</p>
                    {setupSteps && (
                      <div className="text-muted-foreground text-xs space-y-1">
                        <p className="font-medium text-foreground">One-time setup (~2 minutes):</p>
                        {setupSteps.map((step, i) => (
                          <p key={i} className="flex gap-2">
                            <span className="text-primary font-mono">{i + 1}.</span>
                            {step}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Loading ─────────────────────────────────────────────────────── */}
      {state === 'loading' && (
        <Card>
          <CardContent className="p-10 flex flex-col items-center gap-4 text-center">
            <div className="relative">
              <FolderOpen className="h-12 w-12 text-primary/20" />
              <Loader2 className="h-5 w-5 text-primary animate-spin absolute -bottom-1 -right-1" />
            </div>
            <div>
              <p className="font-semibold text-lg">Loading images from Drive…</p>
              <p className="text-sm text-muted-foreground mt-1">
                Downloading and uploading to Cloudinary. This may take a minute for large folders.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Result ──────────────────────────────────────────────────────── */}
      {state === 'done' && result && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6 space-y-5">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-6 w-6 text-green-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-lg">Import complete</p>
                  <p className="text-muted-foreground text-sm">{result.message}</p>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                <StatBox label="Images found" value={result.total} />
                <StatBox label="Imported" value={result.imported} green />
                <StatBox label="Failed" value={result.failed} warn={result.failed > 0} />
              </div>

              {/* Image grid preview */}
              {result.products.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">IMPORTED IMAGES</p>
                  <div className="grid grid-cols-5 gap-2">
                    {result.products.slice(0, 15).map((p) => (
                      <div key={p.id} className="space-y-1">
                        <div className="aspect-square rounded-lg overflow-hidden bg-muted border">
                          <img
                            src={p.imageUrl}
                            alt={p.title}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src =
                                'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" fill="%23f3f4f6"/%3E%3C/svg%3E'
                            }}
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate leading-tight">{p.title}</p>
                      </div>
                    ))}
                    {result.products.length > 15 && (
                      <div className="aspect-square rounded-lg bg-muted/60 border flex items-center justify-center">
                        <p className="text-xs text-muted-foreground text-center">
                          +{result.products.length - 15}<br/>more
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Errors */}
              {result.failed > 0 && result.errors.length > 0 && (
                <div className="bg-amber-50 dark:bg-amber-950/20 rounded-md p-3 space-y-1 max-h-28 overflow-y-auto">
                  {result.errors.slice(0, 8).map((e, i) => (
                    <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
                      {e.filename}: {e.reason}
                    </p>
                  ))}
                </div>
              )}

              {/* Next steps */}
              <div className="bg-primary/5 rounded-lg p-4 space-y-3">
                <p className="text-sm font-semibold">Next steps</p>
                <div className="space-y-2">
                  <NextStep
                    n={1}
                    text="Go to Templates → create or pick a template"
                    href="/dashboard/templates"
                    label="Open Templates"
                  />
                  <NextStep
                    n={2}
                    text="Rules Engine → select your imported catalog → generate creatives"
                    href="/dashboard/rules"
                    label="Open Rules"
                  />
                  <NextStep
                    n={3}
                    text="Download results Excel with generated image URLs"
                    href={result.importId ? `/api/catalog/export?importId=${result.importId}&format=xlsx` : undefined}
                    label="Download Excel"
                    external
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" size="sm"
                  onClick={() => window.location.href = '/dashboard/products'}>
                  <ImageIcon className="h-3.5 w-3.5 mr-1.5" />
                  View all imported products
                </Button>
                <Button variant="ghost" size="sm" onClick={reset}>
                  Import another folder
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatBox({ label, value, green, warn }: {
  label: string; value: number; green?: boolean; warn?: boolean
}) {
  return (
    <div className="bg-muted/40 rounded-lg p-3 text-center">
      <p className={`text-2xl font-bold tabular-nums ${
        green ? 'text-green-600' : warn ? 'text-amber-600' : 'text-foreground'
      }`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  )
}

function NextStep({ n, text, href, label, external }: {
  n: number; text: string; href?: string; label: string; external?: boolean
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center font-semibold shrink-0">
        {n}
      </span>
      <span className="text-muted-foreground flex-1">{text}</span>
      {href && (
        <a
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer' : undefined}
          className="text-primary text-xs font-medium hover:underline flex items-center gap-0.5 shrink-0"
        >
          {label} <ArrowRight className="h-3 w-3" />
        </a>
      )}
    </div>
  )
}