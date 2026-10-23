import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to retry processing.' }, { status: 401 })
  const { id } = await params
  const { data, error } = await supabase.rpc('retry_failed_video_processing', { target_item_id: id })
  if (error || !data) return NextResponse.json({ error: 'Could not queue this video for retry.' }, { status: 409 })
  return NextResponse.json({ status: 'pending' })
}
