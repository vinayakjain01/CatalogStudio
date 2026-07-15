import { cache } from 'react'
import { createClient } from './server'
import type { User } from '@supabase/supabase-js'

/**
 * Get the current Supabase user, DEDUPLICATED within a single server render.
 *
 * React's `cache()` memoises the result for the duration of one request. No
 * matter how many times getUser() is called across layout.tsx, page.tsx, and
 * utility functions like getActiveStore(), only ONE Supabase auth round-trip
 * is made per request.
 *
 * Before: every page made 3-5 sequential getUser() calls (~100ms each).
 * After:  one call, all callers share the result.
 */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
})