import { createHash, randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin.server'

export const runtime = 'nodejs'

async function signedInUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET() {
  const user = await signedInUser()
  if (!user) return NextResponse.json({ error: 'Sign in to manage your Telegram connection.' }, { status: 401 })
  try {
    const admin = createAdminClient()
    const { data, error } = await admin.from('telegram_account_links').select('user_id').eq('user_id', user.id).maybeSingle()
    if (error) throw error
    return NextResponse.json({ linked: Boolean(data) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Telegram linking is not set up yet. Apply the Telegram migration and configure server credentials.' }, { status: 503 })
  }
}

export async function POST() {
  const user = await signedInUser()
  if (!user) return NextResponse.json({ error: 'Sign in to connect Telegram.' }, { status: 401 })
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '').trim()
  if (!username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    return NextResponse.json({ error: 'Set TELEGRAM_BOT_USERNAME on the server before creating a link.' }, { status: 503 })
  }
  try {
    const admin = createAdminClient()
    const { data: existing, error: lookupError } = await admin.from('telegram_account_links').select('user_id').eq('user_id', user.id).maybeSingle()
    if (lookupError) throw lookupError
    if (existing) return NextResponse.json({ error: 'A Telegram account is already connected. Disconnect it before linking another.' }, { status: 409 })

    const { error: revokeError } = await admin.from('telegram_link_codes').update({ consumed_at: new Date().toISOString() })
      .eq('user_id', user.id).is('consumed_at', null)
    if (revokeError) throw revokeError
    const code = randomBytes(32).toString('base64url')
    const codeHash = createHash('sha256').update(code).digest('hex')
    const { error } = await admin.from('telegram_link_codes').insert({
      code_hash: codeHash,
      user_id: user.id,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    if (error) throw error
    return NextResponse.json({ code, expiresInSeconds: 600, botUrl: `https://t.me/${username}?start=link_${code}` }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Could not create a Telegram link code. Check the migration and server configuration.' }, { status: 503 })
  }
}

export async function DELETE() {
  const user = await signedInUser()
  if (!user) return NextResponse.json({ error: 'Sign in to disconnect Telegram.' }, { status: 401 })
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('telegram_account_links').delete().eq('user_id', user.id)
    if (error) throw error
    await admin.from('telegram_link_codes').update({ consumed_at: new Date().toISOString() }).eq('user_id', user.id).is('consumed_at', null)
    return NextResponse.json({ linked: false })
  } catch {
    return NextResponse.json({ error: 'Could not disconnect Telegram.' }, { status: 503 })
  }
}
