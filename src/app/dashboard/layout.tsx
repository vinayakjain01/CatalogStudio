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
    <div className="flex h-screen bg-background">
      <Sidebar stores={stores} activeStoreId={activeStoreId} />
      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  )
}