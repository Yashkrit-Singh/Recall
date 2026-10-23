import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to check indexing status.' }, { status: 401 })

  const { count, error } = await supabase.from('saved_items')
    .select('id', { count: 'exact', head: true })
    .in('embedding_status', ['pending', 'processing'])
  if (error) {
    return NextResponse.json({ error: 'Indexing status is unavailable. Run the durable embedding queue migration.' }, { status: 503 })
  }
  const { count: mediaCount } = await supabase.from('saved_items')
    .select('id', { count: 'exact', head: true })
    .in('media_status', ['pending', 'processing'])
  return NextResponse.json({ activeCount: (count ?? 0) + (mediaCount ?? 0) })
}
