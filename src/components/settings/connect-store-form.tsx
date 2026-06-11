'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ShoppingBag, ArrowRight } from 'lucide-react'

export function ConnectStoreForm() {
  const [shopDomain, setShopDomain] = useState('')
  const [error, setError] = useState('')

  function handleConnect() {
    setError('')

    let domain = shopDomain.trim()
      .replace('https://', '')
      .replace('http://', '')
      .replace(/\/$/, '')

    // Auto-append .myshopify.com if user typed just the subdomain
    if (!domain.includes('.')) {
      domain = `${domain}.myshopify.com`
    }

    const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/
    if (!shopRegex.test(domain)) {
      setError('Enter a valid Shopify domain, e.g. yourstore.myshopify.com')
      return
    }

    // Redirect to our install route — it handles the rest
    window.location.href = `/api/shopify/install?shop=${domain}`
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShoppingBag className="h-4 w-4" />
          Connect your Shopify store
        </CardTitle>
        <CardDescription>
          You'll be redirected to Shopify to approve access. No manual tokens needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="space-y-2">
          <Label htmlFor="shop">Shop domain</Label>
          <div className="flex gap-2">
            <Input
              id="shop"
              placeholder="yourstore.myshopify.com"
              value={shopDomain}
              onChange={e => setShopDomain(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleConnect()}
              className="flex-1"
            />
            <Button onClick={handleConnect} disabled={!shopDomain.trim()}>
              Connect
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Enter just the subdomain (e.g. <span className="font-mono">yourstore</span>) or the full domain
          </p>
        </div>
      </CardContent>
    </Card>
  )
}