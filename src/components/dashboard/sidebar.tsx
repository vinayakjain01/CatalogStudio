'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { LayoutDashboard, ShoppingBag, Layers, Zap, ImageIcon, Settings, LogOut, Wand2, Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StoreSwitcher } from '@/components/dashboard/store-switcher'

interface StoreLite {
  id: string
  shop_name: string | null
  shop_domain: string
  feed_token: string | null
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/products', label: 'Products', icon: ShoppingBag },
  { href: '/dashboard/templates', label: 'Templates', icon: Layers },
  { href: '/dashboard/rules', label: 'Rules Engine', icon: Zap },
  { href: '/dashboard/creatives', label: 'Creatives', icon: ImageIcon },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
]

/**
 * The store's Meta feed URL, pinned above Sign out so it is reachable from
 * every screen — this replaces the old Meta section, which existed mainly to
 * display this one string.
 *
 * Built client-side from the active store rather than fetched: the token is
 * already in props and the URL is pure string assembly, so a round trip would
 * buy nothing.
 */
function FeedUrlFooter({ store }: { store: StoreLite | null }) {
  const [copied, setCopied] = useState(false)

  if (!store?.feed_token) return null

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const feedUrl = `${origin}/api/feed/${store.id}?token=${store.feed_token}&format=csv`

  async function copy() {
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="border-t p-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Your feed URL</p>
      <div className="flex items-center gap-1.5">
        <code
          className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground"
          title={feedUrl}
        >
          /api/feed/{store.id.slice(0, 8)}…
        </code>
        <Button
          size="icon-sm"
          variant="outline"
          onClick={copy}
          title="Copy feed URL"
          aria-label="Copy feed URL"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export function Sidebar({
  stores = [],
  activeStoreId = null,
}: {
  stores?: StoreLite[]
  activeStoreId?: string | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="w-60 border-r flex flex-col bg-card">
      <div className="p-5 border-b">
        <div className="flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-primary" />
          <span className="font-semibold text-base">Catalog Studio</span>
        </div>
      </div>
      <div className="border-b">
        <StoreSwitcher stores={stores} activeStoreId={activeStoreId} />
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href}>
            <div className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
              pathname === href
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}>
              <Icon className="h-4 w-4" />
              {label}
            </div>
          </Link>
        ))}
      </nav>
      <FeedUrlFooter store={stores.find(s => s.id === activeStoreId) ?? null} />

      <div className="p-3 border-t">
        <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  )
}