import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin.server'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to retry processing.' }, { status: 401 })
  const { id } = await params
  // A ready video can also be reprocessed after pipeline improvements. Resolve
  // its current media reference using the signed-in owner before using service role.
  const admin = createAdminClient()
  const { data: item, error: itemError } = await admin.from('saved_items')
    .select('id,user_id,media_version,media_storage_key,media_status')
    .eq('id', id).eq('user_id', user.id).maybeSingle()
  if (itemError || !item?.media_storage_key) return NextResponse.json({ error: 'Could not find an uploaded video you own.' }, { status: 404 })

  // Keep the database's existing authenticated recovery RPC for failed jobs.
  if (item.media_status === 'failed') {
    const { data, error } = await supabase.rpc('retry_failed_video_processing', { target_item_id: id })
    if (!error && data) return NextResponse.json({ status: 'pending' })
  }

  const { data: active, error: activeError } = await admin.from('video_processing_jobs')
    .select('id').eq('item_id', item.id).eq('media_version', item.media_version)
    .in('status', ['queued', 'processing']).limit(1).maybeSingle()
  if (activeError) return NextResponse.json({ error: 'Could not check the video queue.' }, { status: 500 })
  if (active) return NextResponse.json({ status: 'pending' })

  if (item.media_status === 'pending' || item.media_status === 'processing') {
    return NextResponse.json({ error: 'Video status indicates work is active, but no active job is visible. Try again shortly.' }, { status: 409 })
  }

  const { error: queueError } = await admin.from('video_processing_jobs').insert({
    item_id: item.id, user_id: item.user_id, media_version: item.media_version,
    storage_key: item.media_storage_key,
  })
  if (queueError && queueError.code !== '23505') return NextResponse.json({ error: 'Could not queue this video for reprocessing.' }, { status: 500 })
  const { error: updateError } = await admin.from('saved_items').update({ media_status: 'pending', media_error: null })
    .eq('id', item.id).eq('user_id', user.id).eq('media_version', item.media_version)
  if (updateError) return NextResponse.json({ error: 'Video was queued but its status could not be refreshed.' }, { status: 500 })
  return NextResponse.json({ status: 'pending' })
}
