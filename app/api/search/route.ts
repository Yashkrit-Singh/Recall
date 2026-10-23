import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { searchSavedItems } from '@/lib/saved-search.server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to search your library.' }, { status: 401 })

  let body: { query?: unknown }
  try { body = await request.json() as { query?: unknown } } catch {
    return NextResponse.json({ error: 'Enter a search phrase and try again.' }, { status: 400 })
  }
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 300) : ''
  if (!query) return NextResponse.json({ error: 'Enter a search phrase and try again.' }, { status: 400 })

  try {
    return NextResponse.json(await searchSavedItems(supabase, query))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Search failed. Try again.' }, { status: 500 })
  }
}
