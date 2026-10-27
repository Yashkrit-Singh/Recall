import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { processTelegramUpdate } from '@/lib/telegram-bot.server'

export const runtime = 'nodejs'

function validWorkerSecret(received: string | null) {
  const expected = process.env.RECALL_TELEGRAM_WORKER_SECRET
  if (!expected || !received) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!validWorkerSecret(request.headers.get('x-recall-telegram-worker-secret'))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const length = Number(request.headers.get('content-length') || 0)
  if (length > 64_000) return NextResponse.json({ error: 'Update is too large.' }, { status: 413 })
  let update: unknown
  try {
    const body = await request.text()
    if (body.length > 64_000) return NextResponse.json({ error: 'Update is too large.' }, { status: 413 })
    update = JSON.parse(body)
  } catch {
    return NextResponse.json({ error: 'Invalid Telegram update.' }, { status: 400 })
  }
  try {
    return NextResponse.json(await processTelegramUpdate(update as Parameters<typeof processTelegramUpdate>[0]), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'Could not process this Telegram update.' }, { status: 503 })
  }
}
