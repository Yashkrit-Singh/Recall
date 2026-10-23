import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: Record<string, unknown>) {
          try { cookieStore.set({ name, value, ...(options as object) }) } catch { /* Server Components cannot write cookies. Middleware handles refresh. */ }
        },
        remove(name: string, options: Record<string, unknown>) {
          try { cookieStore.set({ name, value: '', ...(options as object) }) } catch { /* Server Components cannot write cookies. */ }
        },
      },
    },
  )
}
