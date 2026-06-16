import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Sidebar } from '@/components/dashboard/sidebar'
import { getActiveStore } from '@/lib/active-store'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { activeStoreId, stores } = await getActiveStore()

  return (
    <div className="flex h-screen bg-background">
      <Sidebar stores={stores} activeStoreId={activeStoreId} />
      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  )
}