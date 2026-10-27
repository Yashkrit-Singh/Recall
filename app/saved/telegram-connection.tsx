'use client'

import { useEffect, useState } from 'react'

type LinkResponse = { linked?: boolean; code?: string; botUrl?: string; expiresInSeconds?: number; error?: string }

export function TelegramConnection({ enabled, botUsername }: { enabled: boolean; botUsername: string }) {
  const [linked, setLinked] = useState(false)
  const [code, setCode] = useState('')
  const [botUrl, setBotUrl] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(enabled)

  async function refresh() {
    const response = await fetch('/api/telegram/link-code', { cache: 'no-store' })
    const payload = await response.json() as LinkResponse
    if (!response.ok) throw new Error(payload.error || 'Could not check Telegram connection.')
    setLinked(Boolean(payload.linked))
    if (payload.linked) { setCode(''); setBotUrl(''); setMessage('Telegram is connected to this Recall account.') }
  }

  useEffect(() => {
    if (!enabled) return
    let mounted = true
    void refresh().catch(caught => { if (mounted) setError(caught instanceof Error ? caught.message : 'Could not check Telegram connection.') }).finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [enabled])

  async function connect() {
    setBusy(true); setError(''); setMessage(''); setCode(''); setBotUrl('')
    try {
      const response = await fetch('/api/telegram/link-code', { method: 'POST' })
      const payload = await response.json() as LinkResponse
      if (!response.ok) throw new Error(payload.error || 'Could not create a link code.')
      setCode(payload.code || '')
      setBotUrl(payload.botUrl || '')
      setMessage('A secure one-time code is ready. It expires in 10 minutes.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not create a link code.') }
    finally { setBusy(false) }
  }

  async function copyCommand() {
    try { await navigator.clipboard.writeText(`/start link_${code}`); setMessage('Telegram command copied. Paste it into the bot chat.') }
    catch { setError('Could not access the clipboard. You can select and copy the command above.') }
  }

  async function disconnect() {
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/telegram/link-code', { method: 'DELETE' })
      const payload = await response.json() as LinkResponse
      if (!response.ok) throw new Error(payload.error || 'Could not disconnect Telegram.')
      setLinked(false); setCode(''); setBotUrl(''); setMessage('Telegram has been disconnected.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not disconnect Telegram.') }
    finally { setBusy(false) }
  }

  if (!enabled) return <section className="rounded-2xl border border-[#e9e6e1] bg-white p-5" aria-label="Telegram video search bot"><p className="text-sm font-semibold">Find videos in Telegram</p><p className="mt-2 text-sm leading-6 text-[#77747e]">Telegram linking is not configured for this installation yet.</p></section>

  return <section className="rounded-2xl border border-[#e8e4f3] bg-white p-5 shadow-[0_8px_24px_rgba(37,32,62,.035)]" aria-label="Telegram video search bot">
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#efedfa] text-lg text-[#6252bd]" aria-hidden="true">➤</span><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[.1em] text-[#7568bb]">Your video-finding bot</p><h2 className="mt-1 text-base font-semibold tracking-tight">Find videos in Telegram</h2></div></div>
    <p className="mt-3 text-sm leading-6 text-[#77747e]">Describe the video you remember. Recall searches your private library and sends back the strongest matches.</p>
    {loading ? <p role="status" className="mt-4 rounded-xl bg-[#f7f6f4] px-3 py-3 text-sm text-[#77747e]">Checking your connection…</p> : linked ? <div className="mt-4 rounded-xl border border-[#dcecdf] bg-[#f5faf5] p-3.5"><div className="flex items-center justify-between gap-3"><p role="status" className="flex items-center gap-2 text-sm font-semibold text-[#3d754e]"><span className="h-2 w-2 rounded-full bg-[#4c9a71]" />Connected</p><span className="text-xs text-[#77747e]">@{botUsername}</span></div><a href={`https://t.me/${botUsername}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-sm font-semibold text-[#5948b4] hover:underline">Open Recall bot ↗</a><div className="mt-3 border-t border-[#e2eee3] pt-3"><button type="button" disabled={busy} onClick={() => void disconnect()} className="text-xs font-medium text-[#77747e] underline disabled:opacity-50">{busy ? 'Working…' : 'Disconnect Telegram'}</button></div></div> : <div className="mt-4">
      {!code ? <button type="button" onClick={() => void connect()} disabled={busy} className="inline-flex w-full items-center justify-center rounded-xl bg-[#29243e] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#403961] disabled:opacity-55">{busy ? 'Creating secure link…' : 'Connect Telegram'}</button> : <div className="rounded-xl border border-[#e9e6f2] bg-[#faf9fd] p-3.5"><p className="text-xs font-semibold text-[#504b5e]">1. Open @{botUsername} in Telegram</p><a href={botUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-sm font-semibold text-[#5948b4] hover:underline">Open Telegram bot ↗</a><p className="mt-4 text-xs font-semibold text-[#504b5e]">2. Send this one-time command</p><code className="mt-2 block break-all rounded-lg bg-white px-3 py-2.5 text-xs text-[#484455]">/start link_{code}</code><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void copyCommand()} className="rounded-lg border border-[#e4e0ef] bg-white px-3 py-2 text-xs font-semibold text-[#5c4eaa] hover:bg-[#f5f3fb]">Copy command</button><button type="button" disabled={busy} onClick={() => void connect()} className="rounded-lg px-3 py-2 text-xs font-medium text-[#77747e] hover:bg-white disabled:opacity-50">Generate new code</button></div><p className="mt-3 text-xs leading-5 text-[#898692]">This code expires in 10 minutes. Generating a new code invalidates this one.</p><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await refresh() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not check connection.') } finally { setBusy(false) } }} className="mt-3 text-xs font-semibold text-[#5948b4] underline disabled:opacity-50">{busy ? 'Checking…' : 'I sent the command · Check connection'}</button></div>}
    </div>}
    {message && <p role="status" className="mt-3 text-xs leading-5 text-[#6b6874]">{message}</p>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-[#fff3f1] px-3 py-2 text-xs leading-5 text-[#9b4e48]">{error}</p>}
  </section>
}
