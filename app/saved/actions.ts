'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin.server'

function cleanTags(value: FormDataEntryValue | null) {
  return String(value ?? '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20)
}
function validUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false }
}

export async function createItem(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const source_url = String(formData.get('source_url') ?? '').trim()
  if (!validUrl(source_url)) redirect('/saved?error=Add%20a%20valid%20link.')
  const item = { user_id: user.id, source_url, title: 'Saved Reel', notes: '', tags: [] as string[] }
  const itemId = randomUUID()
  const retrievalEnabled = process.env.RECALL_YTDLP_ENABLED === 'true'
  let retrievalQueueError = false
  if (retrievalEnabled) {
    try {
      const admin = createAdminClient()
      const { error } = await admin.rpc('create_saved_item_with_retrieval', {
        target_item_id: itemId,
        target_user_id: user.id,
        target_source_url: item.source_url,
        target_title: item.title,
        target_notes: item.notes,
        target_tags: item.tags,
        target_retrieval_enabled: true,
      })
      if (!error) {
        revalidatePath('/saved')
        return
      }
      retrievalQueueError = true
    } catch {
      retrievalQueueError = true
    }
  }
  // The URL save remains available if retrieval is disabled or its migration /
  // service configuration is not ready. In that case no retrieval job exists.
  let { data, error } = await supabase.from('saved_items').insert({
    ...item, id: itemId,
    metadata_generation_status: 'not_requested',
    metadata_title_user_edited: false,
    metadata_notes_user_edited: false,
    metadata_tags_user_edited: false,
  }).select('id').single()
  if (error?.code === '42703' || error?.code === 'PGRST204') {
    // Keep URL-only saving available while a developer is preparing the
    // additive metadata migration; no metadata job is claimed in that state.
    ;({ data, error } = await supabase.from('saved_items').insert({ ...item, id: itemId }).select('id').single())
  }
  if (error || !data) {
    // The RPC may have committed before a transient network error reached us.
    // Reuse the same generated UUID so fallback cannot create a duplicate.
    const { data: existing } = await supabase.from('saved_items').select('id').eq('id', itemId).eq('user_id', user.id).maybeSingle()
    if (!existing) redirect('/saved?error=Could%20not%20save%20that%20item.')
  }
  if (retrievalQueueError) redirect('/saved?notice=retrieval-not-queued')
  revalidatePath('/saved')
}

export async function retryFailedMediaRetrieval(itemId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, message: 'Sign in again to retry retrieval.' }
  const { data, error } = await supabase.rpc('retry_failed_media_retrieval', { target_item_id: itemId })
  if (error) return { ok: false, message: 'Could not retry retrieval. Check that migration 008 is applied and retrieval is enabled.' }
  revalidatePath('/saved')
  return data
    ? { ok: true, message: 'Retrieval queued again.' }
    : { ok: false, message: 'This item is not eligible for retrieval retry.' }
}

export async function updateItem(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const id = String(formData.get('id') ?? '')
  const source_url = String(formData.get('source_url') ?? '').trim()
  const title = String(formData.get('title') ?? '').trim()
  if (!id || !validUrl(source_url) || !title) redirect('/saved?error=Add%20a%20valid%20link%20and%20title.')
  const item = { source_url, title, notes: String(formData.get('notes') ?? '').trim(), tags: cleanTags(formData.get('tags')) }
  const { error } = await supabase.from('saved_items').update(item).eq('id', id).eq('user_id', user.id)
  if (error) redirect('/saved?error=Could%20not%20update%20that%20item.')
  revalidatePath('/saved')
}

export async function regenerateVideoMetadata(itemId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, message: 'Sign in again to regenerate metadata.' }
  const { data, error } = await supabase.rpc('enqueue_saved_item_metadata_generation', { target_item_id: itemId })
  if (error) return { ok: false, message: 'Could not queue metadata generation. Check the local Ollama setup and metadata migration.' }
  revalidatePath('/saved')
  return data
    ? { ok: true, message: 'Metadata generation queued. Your edited fields will be kept.' }
    : { ok: false, message: 'This video is not ready for metadata generation.' }
}

export async function deleteItem(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const id = String(formData.get('id') ?? '')
  const { data: existing } = await supabase.from('saved_items').select('media_storage_key').eq('id', id).eq('user_id', user.id).maybeSingle()
  const { error } = await supabase.from('saved_items').delete().eq('id', id).eq('user_id', user.id)
  if (error) redirect('/saved?error=Could%20not%20delete%20that%20item.')
  if (existing?.media_storage_key && /^[0-9a-f-]{36}\.(mp4|mov|webm)$/.test(existing.media_storage_key)) {
    await rm(path.join(path.resolve(process.env.RECALL_MEDIA_DIR || '.local-media'), existing.media_storage_key), { force: true }).catch(() => undefined)
  }
  revalidatePath('/saved')
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

export async function backfillMissingEmbeddings() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, message: 'Sign in again to continue.' }
  const { data: queued, error } = await supabase.rpc('enqueue_missing_saved_item_embeddings')
  if (error) return { ok: false, message: 'Could not queue older items for indexing. Run the durable embedding queue migration first.' }
  revalidatePath('/saved')
  const count = Number(queued ?? 0)
  return { ok: true, indexed: count, message: count ? `Queued ${count} existing item${count === 1 ? '' : 's'} for indexing.` : 'No unqueued saved items need backfilling.' }
}

export async function backfillMultimodalEmbeddings() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, indexed: 0, message: 'Sign in again to continue.' }
  const { data: queued, error } = await supabase.rpc('enqueue_existing_multimodal_items')
  if (error) return { ok: false, indexed: 0, message: 'Could not queue EmbeddingGemma items. Apply the EmbeddingGemma 2 migration in Supabase first.' }
  revalidatePath('/saved')
  const count = Number(queued ?? 0)
  return { ok: true, indexed: count, message: count ? `Queued ${count} EmbeddingGemma job${count === 1 ? '' : 's'} for your saved items.` : 'All eligible saved items are already indexed or queued.' }
}

export async function retryFailedEmbeddings() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, indexed: 0, message: 'Sign in again to continue.' }
  const { data: queued, error } = await supabase.rpc('retry_failed_saved_item_embeddings')
  if (error) return { ok: false, indexed: 0, message: 'Could not queue failed items for retry. Check the durable embedding queue migration.' }
  revalidatePath('/saved')
  const count = Number(queued ?? 0)
  return { ok: true, indexed: count, message: count ? `Queued ${count} failed item${count === 1 ? '' : 's'} for retry.` : 'No failed embeddings need retrying.' }
}
