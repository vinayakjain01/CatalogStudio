/**
 * @module active-store
 *
 * Resolves which connected Shopify store is "active" for the current user's
 * session, server-side — backed by a cookie plus a Supabase lookup.
 *
 * RESPONSIBILITIES:
 *   - ACTIVE_STORE_COOKIE — cookie name that pins the chosen store id.
 *   - StoreLite — minimal store shape returned to callers.
 *   - getActiveStore — resolves the active store id (validated cookie, else
 *     first store) plus the user's full list of stores.
 *
 * DEPENDENCIES: getUser() (React-cached Supabase auth lookup), so this file
 * never triggers a second auth call when layout.tsx/page.tsx already did.
 */
import { cookies } from 'next/headers'
import { getUser } from './supabase/get-user'
import { createClient } from './supabase/server'

export const ACTIVE_STORE_COOKIE = 'active_store_id'

export interface StoreLite {
  id: string
  shop_name: string | null
  shop_domain: string
  /**
   * Public feed token. Safe to expose to the browser by design — it authorises
   * only the read-only Meta feed endpoint and carries no account access, which
   * is the whole reason it is separate from the auth session.
   */
  feed_token: string | null
}

/**
 * Resolve the active store for the current user, server-side.
 *
 * PERFORMANCE: Uses the React-cached getUser() so this never makes a second
 * Supabase auth call when layout.tsx or the page has already called getUser().
 * Only the stores query is new work here.
 */
export async function getActiveStore(): Promise<{
  activeStoreId: string | null
  stores: StoreLite[]
}> {
  // React cache ensures this is free if the layout/page already called getUser()
  const user = await getUser()
  if (!user) return { activeStoreId: null, stores: [] }

  const supabase = await createClient()
  const { data: stores } = await supabase
    .from('stores')
    .select('id, shop_name, shop_domain, feed_token')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  const list = (stores || []) as StoreLite[]
  if (list.length === 0) return { activeStoreId: null, stores: [] }

  const cookieStore = await cookies()
  const cookieId = cookieStore.get(ACTIVE_STORE_COOKIE)?.value

  const valid = cookieId && list.some(s => s.id === cookieId)
  const activeStoreId = valid ? cookieId! : list[0].id

  return { activeStoreId, stores: list }
}