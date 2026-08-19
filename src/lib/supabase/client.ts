/**
 * @module client
 *
 * Supabase client factory for browser/client-component code.
 *
 * RESPONSIBILITIES:
 *   - createClient — a Supabase client authenticated via the browser's cookies/local storage (anon key, RLS-scoped)
 */

import { createBrowserClient } from '@supabase/ssr'

/** Create a Supabase client for use in client components (anon key, browser session). */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}