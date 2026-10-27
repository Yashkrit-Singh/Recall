import 'server-only'

import { createHash } from 'node:crypto'
import { createAdminClient } from './supabase/admin.server'
import { searchVideosAsTelegramUser } from './supabase/telegram-user.server'

type TelegramUpdate = {
  update_id?: number
  message?: {
    text?: string
    from?: { id?: number }
    chat?: { id?: number; type?: string }
  }
}

const requestTimes = new Map<string, number[]>()
const acceptedUpdateIds = new Map<number, number>()

function takeRateLimit(userId: string) {
  const now = Date.now()
  for (const [key, values] of Array.from(requestTimes.entries())) {
    const recent = values.filter((time: number) => now - time < 60_000)
    if (recent.length) requestTimes.set(key, recent)
    else requestTimes.delete(key)
  }
  if (requestTimes.size > 2000) requestTimes.clear()
  const recent = requestTimes.get(userId) || []
  if (recent.length >= 8) return false
  recent.push(now)
  requestTimes.set(userId, recent)
  return true
}

function hasProcessedUpdate(updateId: number | undefined) {
  if (!Number.isSafeInteger(updateId)) return true
  const now = Date.now()
  for (const [id, time] of Array.from(acceptedUpdateIds.entries())) if (now - time > 10 * 60_000) acceptedUpdateIds.delete(id)
  return acceptedUpdateIds.has(updateId!)
}

function markProcessedUpdate(updateId: number | undefined) {
  if (!Number.isSafeInteger(updateId)) return
  const now = Date.now()
  acceptedUpdateIds.set(updateId!, now)
}

async function sendTelegram(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('Telegram bot is not configured.')
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3800), link_preview_options: { is_disabled: false } }),
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}.`)
}

function cleanTitle(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Saved video'
}

async function handleLink(chatId: number, telegramUserId: string, code: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(code)) {
    await sendTelegram(chatId, 'That link code is invalid or expired. Create a new one from your signed-in Recall library.')
    return
  }
  const admin = createAdminClient()
  const codeHash = createHash('sha256').update(code).digest('hex')
  const { data, error } = await admin.rpc('consume_telegram_link_code', {
    target_code_hash: codeHash,
    target_telegram_user_id: telegramUserId,
  })
  if (error) throw new Error('Telegram link setup is unavailable. Check the database migration.')
  if (data === 'linked') await sendTelegram(chatId, 'Recall is connected. Describe a saved video whenever you want to find it.')
  else if (data === 'already_linked') await sendTelegram(chatId, 'This Telegram account or Recall account is already connected. Manage the connection from your Recall library.')
  else await sendTelegram(chatId, 'That link code is invalid or expired. Create a new one from your signed-in Recall library.')
}

export async function processTelegramUpdate(update: TelegramUpdate) {
  const message = update?.message
  const chatId = message?.chat?.id
  const telegramUserId = message?.from?.id
  const text = typeof message?.text === 'string' ? message.text.trim().slice(0, 500) : ''
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(telegramUserId) || !text) return { ignored: true }
  if (message?.chat?.type !== 'private' || chatId !== telegramUserId) return { ignored: true }
  if (hasProcessedUpdate(update.update_id)) return { duplicate: true }

  const startLink = text.match(/^\/start(?:@\w+)?\s+link_([A-Za-z0-9_-]{32,64})$/i)
  const directLink = text.match(/^\/link(?:@\w+)?\s+([A-Za-z0-9_-]{32,64})$/i)
  if (startLink || directLink) {
    await handleLink(chatId!, String(telegramUserId), (startLink || directLink)![1])
    markProcessedUpdate(update.update_id)
    return { linked: true }
  }
  if (/^\/(?:start|help)(?:@\w+)?$/i.test(text)) {
    await sendTelegram(chatId!, 'I find videos saved in your Recall account. Connect Telegram from your signed-in Recall library, then send a natural-language description of a video.')
    markProcessedUpdate(update.update_id)
    return { help: true }
  }

  const admin = createAdminClient()
  const { data: link, error: linkError } = await admin.from('telegram_account_links')
    .select('user_id').eq('telegram_user_id', String(telegramUserId)).maybeSingle()
  if (linkError) throw new Error('Telegram account links are unavailable. Check the migration.')
  if (!link?.user_id) {
    await sendTelegram(chatId!, 'Connect your Telegram account from your signed-in Recall library before searching private videos.')
    markProcessedUpdate(update.update_id)
    return { unlinked: true }
  }
  if (!takeRateLimit(String(telegramUserId))) {
    await sendTelegram(chatId!, 'Please wait a moment before searching again.')
    markProcessedUpdate(update.update_id)
    return { rateLimited: true }
  }

  try {
    const result = await searchVideosAsTelegramUser(link.user_id, text)
    if (!result.items.length) {
      await sendTelegram(chatId!, 'No strong match found in your saved videos. Try describing a distinctive object, action, place, or topic.')
      markProcessedUpdate(update.update_id)
      return { matches: 0 }
    }
    const lines = result.items.map(item => [
      `🎥 ${cleanTitle(item.title)}`,
      item.url,
      item.reason || '',
    ].filter(Boolean).join('\n'))
    await sendTelegram(chatId!, lines.join('\n\n'))
    markProcessedUpdate(update.update_id)
    return { matches: result.items.length }
  } catch (error) {
    console.error(`Telegram video search failed for linked account; kind=${error instanceof Error ? error.name : 'unknown'}.`)
    await sendTelegram(chatId!, 'Video search is temporarily unavailable. Please try again shortly.')
    markProcessedUpdate(update.update_id)
    return { failed: true }
  }
}
