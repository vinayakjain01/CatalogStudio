/**
 * @module server
 *
 * Supabase client factory for server-side code (Server Components, Route
 * Handlers, Server Actions) that reads/writes auth via Next.js's request
 * cookie store.
 *
 * RESPONSIBILITIES:
 *   - createClient — a Supabase client wired to the current request's cookies (anon key, RLS-scoped)
 */

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Create a Supabase client for server-side use, backed by the current
 * request's cookie store. Cookie writes are wrapped in try/catch since a
 * Server Component can't set cookies — only Route Handlers/Server Actions can;
 * middleware refreshing the session is what actually persists them in that case.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, {
                ...options,
                sameSite: 'none',
                secure: true,
                partitioned: true,
                path: '/',
              })
            )
          } catch {}
        },
      },
    }
  )
}