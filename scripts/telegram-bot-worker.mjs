import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import nextEnv from '@next/env'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
nextEnv.loadEnvConfig(projectRoot)

const token = process.env.TELEGRAM_BOT_TOKEN
const workerSecret = process.env.RECALL_TELEGRAM_WORKER_SECRET
const appUrl = (process.env.RECALL_TELEGRAM_APP_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const api = `https://api.telegram.org/bot${token}`
let offset = 0
let stopping = false

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true })

function safeMessage(error) {
  return (error instanceof Error ? error.message : 'Telegram worker error.')
    .replace(/https?:\/\/\S+/gi, '[service URL]')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, '[bot token]')
    .slice(0, 300)
}

async function telegram(method, body, timeoutMs = 35_000) {
  const response = await fetch(`${api}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.ok !== true) throw new Error(`Telegram API ${method} failed with HTTP ${response.status}.`)
  return result.result
}

async function processUpdate(update) {
  const response = await fetch(`${appUrl}/api/telegram/process-update`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-recall-telegram-worker-secret': workerSecret },
    body: JSON.stringify(update), redirect: 'error', signal: AbortSignal.timeout(65_000),
  })
  if (!response.ok) throw new Error(`Recall update handler returned HTTP ${response.status}.`)
}

async function main() {
  if (!token || !workerSecret) throw new Error('Set TELEGRAM_BOT_TOKEN and RECALL_TELEGRAM_WORKER_SECRET in .env.local.')
  const info = await telegram('getWebhookInfo', {}, 8_000)
  if (info?.url) throw new Error('A Telegram webhook is configured. Clear it in Telegram before using this polling worker.')
  console.info(`Recall Telegram video-search worker polling; local app=${new URL(appUrl).host}.`)
  while (!stopping) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000)
      for (const update of updates || []) {
        if (stopping) break
        let complete = false
        for (let attempt = 1; attempt <= 3 && !complete; attempt += 1) {
          try {
            await processUpdate(update)
            offset = Math.max(offset, update.update_id + 1)
            complete = true
          } catch (error) {
            console.error(`Telegram update ${update.update_id} failed (attempt ${attempt}/3): ${safeMessage(error)}`)
            if (attempt < 3) await sleep(attempt * 1000)
          }
        }
        if (!complete) {
          console.error('Telegram update delivery failed three times; polling stopped with the update unacknowledged.')
          process.exitCode = 1
          stopping = true
          break
        }
      }
    } catch (error) {
      if (stopping) break
      console.error(`Telegram polling error: ${safeMessage(error)}`)
      await sleep(3000)
    }
  }
  console.info('Recall Telegram worker stopped.')
}

main().catch(error => { console.error(safeMessage(error)); process.exitCode = 1 })
