import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'

export const ACTIVE_STORE_COOKIE = 'active_store_id'

export interface StoreLite {
  id: string
  shop_name: string | null
  shop_domain: string
}

/**
 * Resolve the active store for the current user, server-side.
 *
 * - Reads the active_store_id cookie.
 * - Verifies the cookie points to a store the user actually owns (prevents a
 *   tampered cookie from selecting someone else's store).
 * - Falls back to the user's first store if the cookie is missing/invalid.
 *
 * Returns the active store id plus the full list (for the switcher).
 */
export async function getActiveStore(): Promise<{
  activeStoreId: string | null
  stores: StoreLite[]
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { activeStoreId: null, stores: [] }

  const { data: stores } = await supabase
    .from('stores')
    .select('id, shop_name, shop_domain')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  const list = (stores || []) as StoreLite[]
  if (list.length === 0) return { activeStoreId: null, stores: [] }

  const cookieStore = await cookies()
  const cookieId = cookieStore.get(ACTIVE_STORE_COOKIE)?.value

  // Only honour the cookie if it's one of the user's own stores.
  const valid = cookieId && list.some(s => s.id === cookieId)
  const activeStoreId = valid ? cookieId! : list[0].id

  return { activeStoreId, stores: list }
}