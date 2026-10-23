'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { createClient } from '@/lib/supabase/server'

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
  const title = String(formData.get('title') ?? '').trim()
  if (!validUrl(source_url) || !title) redirect('/saved?error=Add%20a%20valid%20link%20and%20title.')
  const item = { user_id: user.id, source_url, title, notes: String(formData.get('notes') ?? '').trim(), tags: cleanTags(formData.get('tags')) }
  const { data, error } = await supabase.from('saved_items').insert(item).select('id').single()
  if (error || !data) redirect('/saved?error=Could%20not%20save%20that%20item.')
  revalidatePath('/saved')
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
