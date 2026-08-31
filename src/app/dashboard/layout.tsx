import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/get-user'
import { getActiveStore } from '@/lib/active-store'
import { Sidebar } from '@/components/dashboard/sidebar'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Both resolve with a single Supabase auth call thanks to React cache.
  // getActiveStore() calls getUser() internally — the result is shared,
  // so no duplicate network request is made.
  const [user, { activeStoreId, stores }] = await Promise.all([
    getUser(),
    getActiveStore(),
  ])

  if (!user) redirect('/login')

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#F5F3FB', overflow: 'hidden' }}>
      <Sidebar stores={stores} activeStoreId={activeStoreId} />
      <main style={{ flex: 1, overflowY: 'auto', padding: '22px 26px' }}>
        {children}
      </main>
    </div>
  )
}