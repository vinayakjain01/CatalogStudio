'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LayoutDashboard, ShoppingBag, Layers, Zap, ImageIcon, Settings, LogOut, Wand2, Megaphone, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StoreSwitcher } from '@/components/dashboard/store-switcher'

interface StoreLite {
  id: string
  shop_name: string | null
  shop_domain: string
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/products', label: 'Products', icon: ShoppingBag },
  { href: '/dashboard/templates', label: 'Templates', icon: Layers },
  { href: '/dashboard/rules', label: 'Rules Engine', icon: Zap },
  { href: '/dashboard/creatives', label: 'Creatives', icon: ImageIcon },
  { href: '/dashboard/drive', label: 'Drive Import', icon: FolderOpen },
  { href: '/dashboard/meta', label: 'Meta', icon: Megaphone },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
]

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
      <div className="p-3 border-t">
        <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  )
}