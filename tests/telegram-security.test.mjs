import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

test('Telegram pairing migration is additive, private, one-time, and cannot replace an existing link', async () => {
  const sql = await readFile(new URL('supabase/migrations/202610270001_telegram_video_bot.sql', root), 'utf8')
  assert.match(sql, /create table if not exists public\.telegram_link_codes/)
  assert.match(sql, /create table if not exists public\.telegram_account_links/)
  assert.match(sql, /alter table public\.telegram_link_codes enable row level security/)
  assert.match(sql, /alter table public\.telegram_account_links enable row level security/)
  assert.match(sql, /revoke all on public\.telegram_link_codes, public\.telegram_account_links from public, anon, authenticated/)
  assert.match(sql, /c\.consumed_at is null and c\.expires_at>now\(\)/)
  assert.match(sql, /where l\.telegram_user_id=target_telegram_user_id or l\.user_id=pairing\.user_id/)
  assert.match(sql, /grant execute on function public\.consume_telegram_link_code\(text,text\) to service_role/)
  assert.match(sql, /create or replace function public\.search_saved_items\(search_term text\)/)
  assert.match(sql, /security invoker set search_path=''/)
  assert.match(sql, /s\.transcript_segments::text/)
  assert.match(sql, /s\.ocr_frames::text/)
  assert.match(sql, /s\.visual_descriptions::text/)
  assert.match(sql, /s\.user_id=\(select auth\.uid\(\)\)/)
  assert.doesNotMatch(sql, /delete from public\.saved_items|drop table public\./i)
})

test('Telegram search mints a short-lived authenticated owner JWT and reuses existing search under RLS', async () => {
  const source = await readFile(new URL('lib/supabase/telegram-user.server.ts', root), 'utf8')
  assert.match(source, /SUPABASE_JWT_SECRET/)
  assert.match(source, /aud: 'authenticated', role: 'authenticated'/)
  assert.match(source, /sub: userId/)
  assert.match(source, /exp: now \+ 60/)
  assert.match(source, /searchSavedItems\(supabase, searchQuery/)
  assert.match(source, /provider !== 'embeddinggemma2'/)
})

test('polling adapter has bounded retries and rejects bot authorization from untrusted HTTP callers', async () => {
  const worker = await readFile(new URL('scripts/telegram-bot-worker.mjs', root), 'utf8')
  const route = await readFile(new URL('app/api/telegram/process-update/route.ts', root), 'utf8')
  assert.match(worker, /attempt <= 3/)
  assert.match(worker, /polling stopped with the update unacknowledged/)
  assert.match(route, /timingSafeEqual/)
  assert.match(route, /RECALL_TELEGRAM_WORKER_SECRET/)
})
