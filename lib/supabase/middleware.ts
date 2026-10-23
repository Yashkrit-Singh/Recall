import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) { return request.cookies.get(name)?.value },
        set(name: string, value: string, options: Record<string, unknown>) {
          request.cookies.set({ name, value, ...(options as object) })
          response = NextResponse.next({ request })
          response.cookies.set({ name, value, ...(options as object) })
        },
        remove(name: string, options: Record<string, unknown>) {
          request.cookies.set({ name, value: '', ...(options as object) })
          response = NextResponse.next({ request })
          response.cookies.set({ name, value: '', ...(options as object) })
        },
      },
    },
  )
  await supabase.auth.getUser()
  return response
}
