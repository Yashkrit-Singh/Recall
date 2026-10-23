'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { SavedItem } from './page'
import { backfillMissingEmbeddings, createItem, deleteItem, retryFailedEmbeddings, updateItem } from './actions'

function ItemForm({ item, onCancel }: { item?: SavedItem; onCancel?: () => void }) {
  return <form action={item ? updateItem : createItem} className="space-y-3">
    {item && <input type="hidden" name="id" value={item.id} />}
    <label className="block text-xs font-semibold text-[#73776f]">LINK<input required type="url" name="source_url" defaultValue={item?.source_url} placeholder="https://..." className="mt-1.5 w-full rounded-xl border border-[#e1e2db] bg-white px-3.5 py-3 text-sm text-[#252a24] outline-none focus:border-[#617453]" /></label>
    <label className="block text-xs font-semibold text-[#73776f]">TITLE<input required name="title" defaultValue={item?.title} placeholder="What do you want to remember?" className="mt-1.5 w-full rounded-xl border border-[#e1e2db] bg-white px-3.5 py-3 text-sm text-[#252a24] outline-none focus:border-[#617453]" /></label>
    <label className="block text-xs font-semibold text-[#73776f]">NOTES<textarea name="notes" defaultValue={item?.notes} rows={3} placeholder="Add a thought or useful detail…" className="mt-1.5 w-full resize-y rounded-xl border border-[#e1e2db] bg-white px-3.5 py-3 text-sm font-normal text-[#252a24] outline-none focus:border-[#617453]" /></label>
    <label className="block text-xs font-semibold text-[#73776f]">TAGS <span className="font-normal normal-case">(comma separated)</span><input name="tags" defaultValue={item?.tags.join(', ')} placeholder="design, recipe, read later" className="mt-1.5 w-full rounded-xl border border-[#e1e2db] bg-white px-3.5 py-3 text-sm font-normal text-[#252a24] outline-none focus:border-[#617453]" /></label>
    <div className="flex gap-2 pt-1"><button className="rounded-xl bg-[#263426] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#384b38]">{item ? 'Save changes' : 'Save to Recall'}</button>{onCancel && <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2.5 text-sm text-[#6f746c] hover:bg-[#eeeee9]">Cancel</button>}</div>
  </form>
}

function VideoUpload() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const router = useRouter()
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('Uploading and validating video…')
    try {
      const response = await fetch('/api/videos/upload', { method: 'POST', body: new FormData(event.currentTarget) })
      const result = await response.json() as { error?: string; id?: string }
      if (!response.ok) throw new Error(result.error || 'Upload failed.')
      setMessage('Video saved. Local processing is queued.')
      event.currentTarget.reset(); router.refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Upload failed.') }
    finally { setBusy(false) }
  }
  return <form action="/api/videos/upload" method="post" encType="multipart/form-data" onSubmit={upload} className="space-y-3 rounded-xl border border-[#e7e5de] bg-white p-4">
    <label className="block text-xs font-semibold text-[#73776f]">VIDEO FILE<input required name="video" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" className="mt-1.5 block w-full text-sm" /></label>
    <label className="block text-xs font-semibold text-[#73776f]">TITLE<input name="title" maxLength={180} placeholder="Optional title" className="mt-1.5 w-full rounded-xl border border-[#e1e2db] px-3 py-2.5 text-sm" /></label>
    <label className="block text-xs font-semibold text-[#73776f]">DESCRIPTION<textarea name="description" maxLength={8000} rows={2} placeholder="Optional description" className="mt-1.5 w-full rounded-xl border border-[#e1e2db] px-3 py-2.5 text-sm" /></label>
    <label className="block text-xs font-semibold text-[#73776f]">TAGS<input name="tags" placeholder="Comma-separated tags" className="mt-1.5 w-full rounded-xl border border-[#e1e2db] px-3 py-2.5 text-sm" /></label>
    <button disabled={busy} className="rounded-xl bg-[#263426] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Uploading…' : 'Upload video'}</button>
    {message && <p role="status" className="text-xs text-[#66705e]">{message}</p>}
  </form>
}

export function AddItem({ videoUploadsEnabled }: { videoUploadsEnabled: boolean }) {
  const [open, setOpen] = useState(false)
  return <section className="rounded-[22px] border border-[#e7e5de] bg-[#fffefa] p-5 sm:p-6">
    <div className="mb-4 flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-[#829077]">Capture a thought</p><h2 className="mt-1 text-lg font-semibold">Save something for later</h2></div><button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf0e8] text-xl text-[#40523b]">{open ? '−' : '+'}</button></div>
    <div className="space-y-3">{open ? <ItemForm onCancel={() => setOpen(false)} /> : <button type="button" onClick={() => setOpen(true)} className="w-full rounded-xl border border-dashed border-[#d6d9cf] px-4 py-4 text-left text-sm text-[#898d84] hover:border-[#9da992] hover:bg-white">Paste a link, add a note, keep it close <span className="float-right text-[#607451]">↗</span></button>}
    {videoUploadsEnabled ? <details className="group">
      <summary className="w-full cursor-pointer list-none rounded-xl border border-[#d6d9cf] px-4 py-3 text-left text-sm font-medium text-[#526449] hover:bg-white [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Upload a video</span><span className="hidden group-open:inline">Close video upload</span>
      </summary>
      <div className="mt-3"><VideoUpload /></div>
    </details> : <p className="rounded-xl bg-[#f4f2e8] px-3 py-2.5 text-xs leading-5 text-[#6e674b]">Apply the Stage 3 video migration to enable uploads.</p>}</div>
  </section>
}

export function ItemCard({ item }: { item: SavedItem }) {
  const [editing, setEditing] = useState(false)
  const router = useRouter()
  if (editing) return <article className="rounded-[22px] border border-[#dce1d6] bg-[#fbfcf8] p-5 sm:p-6"><div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">Edit saved item</h3><button type="button" onClick={() => setEditing(false)} className="text-sm text-[#72786d]">Close</button></div><ItemForm item={item} onCancel={() => setEditing(false)} /></article>
  const date = new Date(item.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
  let domain = item.media_storage_key ? 'uploaded video' : item.source_url
  try { if (!item.media_storage_key) domain = new URL(item.source_url).hostname.replace(/^www\./, '') } catch { /* URL validation happens on save. */ }
  return <article className="group rounded-[22px] border border-[#e7e5de] bg-white p-5 transition hover:border-[#d4d9cd] sm:p-6">
    <div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="text-xs text-[#8b9085]">{domain}<span className="px-2">·</span>{date}</p><h3 className="mt-2 text-lg font-semibold leading-snug"><a href={item.media_storage_key ? `/api/videos/${item.id}/file` : item.source_url} target="_blank" rel="noreferrer" className="decoration-[#b5c0aa] underline-offset-4 hover:underline">{item.title}<span className="ml-1.5 text-sm text-[#829077]">↗</span></a></h3></div><div className="flex shrink-0 gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"><button type="button" onClick={() => setEditing(true)} className="rounded-lg px-2 py-1.5 text-xs text-[#5c6657] hover:bg-[#f1f3ed]">Edit</button><form action={deleteItem}><input type="hidden" name="id" value={item.id} /><button className="rounded-lg px-2 py-1.5 text-xs text-[#98706b] hover:bg-[#fbf1ef]">Delete</button></form></div></div>
    {item.notes && <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#656b62]">{item.notes}</p>}
    {item.tags.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{item.tags.map((tag, i) => <span key={`${tag}-${i}`} className="rounded-full bg-[#f0f2ec] px-2.5 py-1 text-xs text-[#596650]">{tag}</span>)}</div>}
    <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className={`rounded-full px-2.5 py-1 ${item.embedding_status === 'ready' ? 'bg-[#edf3e9] text-[#4c6842]' : item.embedding_status === 'failed' ? 'bg-[#fbefed] text-[#985b52]' : item.embedding_status === 'processing' ? 'bg-[#eef2f8] text-[#5b6d8b]' : 'bg-[#f4f1e7] text-[#82734c]'}`}>
        {item.embedding_status === 'ready' ? 'Indexed' : item.embedding_status === 'processing' ? 'Indexing…' : item.embedding_status === 'failed' ? 'Indexing failed' : 'Waiting to index'}
      </span>
      {item.embedding_status === 'failed' && item.embedding_error && <span role="status" className="text-[#8e625c]">{item.embedding_error}</span>}
    </div>
    {item.media_storage_key && <div className="mt-3 rounded-xl bg-[#f8f8f4] p-3 text-sm">
      <video controls preload="metadata" src={`/api/videos/${item.id}/file`} className="mb-2 max-h-64 w-full rounded-lg bg-black" aria-label={item.title} />
      <span className="ml-2 text-xs text-[#858b80]">{item.media_duration_seconds ? `${Math.round(item.media_duration_seconds)} sec` : ''}</span>
      <p className="mt-2 text-xs text-[#626a5e]">Video: {item.media_status === 'ready' ? 'Ready' : item.media_status === 'partially_ready' ? 'Partially processed' : item.media_status === 'failed' ? 'Processing failed' : item.media_status === 'processing' ? 'Processing…' : 'Waiting for local worker'}</p>
      {item.media_error && <p className="mt-1 text-xs text-[#985b52]">{item.media_error}</p>}
      {!item.transcript_segments?.length && item.extracted_text && <p className="mt-2 line-clamp-3 text-xs leading-5 text-[#656b62]">{item.extracted_text.slice(0, 320)}</p>}
      {item.transcript_segments?.length ? <details className="mt-2"><summary className="cursor-pointer text-xs font-medium">Transcript ({item.transcript_segments.length} segments)</summary><div className="mt-2 max-h-48 space-y-2 overflow-auto">{item.transcript_segments.map((segment, i) => <p key={i} className="text-xs leading-5 text-[#656b62]"><span className="mr-2 text-[#829077]">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, '0')}</span>{segment.text}</p>)}</div></details> : null}
      {item.ocr_frames?.length ? <details className="mt-2"><summary className="cursor-pointer text-xs font-medium">On-screen text ({item.ocr_frames.length} frames)</summary><div className="mt-2 space-y-2">{item.ocr_frames.map((frame, i) => <p key={i} className="text-xs text-[#656b62]">{Math.floor(frame.time)}s — {frame.text}</p>)}</div></details> : null}
      {item.visual_descriptions?.length ? <details className="mt-2"><summary className="cursor-pointer text-xs font-medium">Visual descriptions</summary><div className="mt-2 space-y-2">{item.visual_descriptions.map((frame, i) => <p key={i} className="text-xs text-[#656b62]">{Math.floor(frame.time)}s — {frame.text}</p>)}</div></details> : null}
      {item.media_status === 'failed' && <button type="button" onClick={async () => { await fetch(`/api/videos/${item.id}/retry`, { method: 'POST' }); router.refresh() }} className="mt-2 text-xs font-medium text-[#526449] underline">Retry processing</button>}
    </div>}
  </article>
}

export function SearchPanel({ initialItems, initialQuery, initialMode, initialWarning, legacyMissingCount, failedCount, activeIndexingCount: initialActiveCount }: {
  initialItems: SavedItem[]
  initialQuery: string
  initialMode: 'recent' | 'keyword' | 'hybrid'
  initialWarning: string
  legacyMissingCount: number
  failedCount: number
  activeIndexingCount: number
}) {
  const [items, setItems] = useState(initialItems)
  const [query, setQuery] = useState(initialQuery)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState(initialWarning)
  const [mode, setMode] = useState(initialMode)
  const [backfillPending, startBackfill] = useTransition()
  const [backfillMessage, setBackfillMessage] = useState('')
  const [activeIndexingCount, setActiveIndexingCount] = useState(initialActiveCount)
  const router = useRouter()

  useEffect(() => {
    setItems(initialItems)
    setMode(initialMode)
    setWarning(initialWarning)
  }, [initialItems, initialMode, initialWarning])
  useEffect(() => setActiveIndexingCount(initialActiveCount), [initialActiveCount])

  useEffect(() => {
    if (activeIndexingCount < 1) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await fetch('/api/indexing/status', { cache: 'no-store' })
        if (response.ok) {
          const result = await response.json() as { activeCount?: number }
          if (!cancelled && typeof result.activeCount === 'number') {
            setActiveIndexingCount(result.activeCount)
            if (result.activeCount === 0) router.refresh()
          }
        }
      } catch {
        // A temporary status request failure must not interrupt saving or search.
      }
      if (!cancelled) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [activeIndexingCount, router])

  async function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleaned = query.trim()
    if (!cleaned) {
      setError('Enter a search phrase and try again.')
      return
    }
    setPending(true)
    setError('')
    setWarning('')
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: cleaned }),
      })
      const result = await response.json() as { items?: SavedItem[]; mode?: 'keyword' | 'hybrid'; warning?: string; error?: string }
      if (!response.ok) throw new Error(result.error || 'Search failed. Try again.')
      setItems(result.items ?? [])
      setMode(result.mode ?? 'keyword')
      setWarning(result.warning ?? '')
      window.history.replaceState(null, '', `/saved?q=${encodeURIComponent(cleaned)}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Search failed. Try again.')
    } finally {
      setPending(false)
    }
  }

  function queueMissing() {
    setBackfillMessage('')
    startBackfill(async () => {
      const result = await backfillMissingEmbeddings()
      setBackfillMessage(result.message)
      if (result.ok && result.indexed) router.refresh()
    })
  }

  function retryFailed() {
    setBackfillMessage('')
    startBackfill(async () => {
      const result = await retryFailedEmbeddings()
      setBackfillMessage(result.message)
      if (result.ok && result.indexed) router.refresh()
    })
  }

  return <>
    <form onSubmit={submitSearch} className="mb-5 flex gap-2 rounded-2xl border border-[#e5e5de] bg-white p-2 shadow-sm">
      <span aria-hidden="true" className="flex items-center pl-3 text-[#8a9084]">⌕</span>
      <input name="q" value={query} onChange={event => setQuery(event.target.value)} placeholder="Try ‘a cozy place to eat’ or ‘camera tips’…" className="min-w-0 flex-1 bg-transparent px-1 py-2.5 text-sm outline-none" />
      <button disabled={pending} className="rounded-xl bg-[#263426] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#384b38] disabled:opacity-60">{pending ? 'Searching…' : 'Search'}</button>
      {query && <a href="/saved" onClick={event => { event.preventDefault(); setQuery(''); setItems(initialItems); setMode('recent'); setWarning(''); setError(''); window.history.replaceState(null, '', '/saved') }} className="self-center pr-2 text-xs text-[#737a70]">Clear</a>}
    </form>
    {pending && <p role="status" className="mb-4 rounded-xl bg-[#f0f2ec] px-4 py-3 text-sm text-[#596650]">Looking across your saved titles, descriptions, and tags…</p>}
    {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
    {warning && <p role="status" className="mb-4 rounded-xl bg-[#f4f2e8] px-4 py-3 text-sm text-[#6e674b]">{warning}</p>}
    {!query.trim() && (legacyMissingCount > 0 || failedCount > 0 || activeIndexingCount > 0) && <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-[#e4e7dc] bg-[#fbfcf8] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[#626a5e]">{activeIndexingCount > 0 ? `${activeIndexingCount} item${activeIndexingCount === 1 ? '' : 's'} waiting for or receiving embeddings.` : failedCount > 0 ? `${failedCount} item${failedCount === 1 ? '' : 's'} failed indexing.` : `${legacyMissingCount} existing item${legacyMissingCount === 1 ? ' needs' : 's need'} backfilling.`}</p>
      {legacyMissingCount > 0 && <button type="button" onClick={queueMissing} disabled={backfillPending} className="rounded-xl border border-[#cfd6c7] px-4 py-2.5 text-sm font-semibold text-[#40523b] hover:bg-white disabled:opacity-60">{backfillPending ? 'Queueing…' : 'Backfill existing items'}</button>}
      {failedCount > 0 && <button type="button" onClick={retryFailed} disabled={backfillPending} className="rounded-xl border border-[#cfd6c7] px-4 py-2.5 text-sm font-semibold text-[#40523b] hover:bg-white disabled:opacity-60">{backfillPending ? 'Queueing…' : 'Retry failed indexing'}</button>}
      {backfillMessage && <p role="status" className="text-xs text-[#66705e] sm:basis-full">{backfillMessage}</p>}
    </div>}
    <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{query.trim() ? `Results for “${query.trim()}”` : 'Recently saved'}</h2><span className="text-right text-xs text-[#8d9288]">{items.length} {items.length === 1 ? 'item' : 'items'}{mode === 'hybrid' ? ' · semantic + keyword' : mode === 'keyword' ? ' · keyword' : ''}</span></div>
    {items.length ? <div className="space-y-3">{items.map(item => <ItemCard key={item.id} item={item} />)}</div> : <div className="rounded-[22px] border border-dashed border-[#dcddd5] bg-[#fbfbf8] px-6 py-12 text-center"><span className="text-3xl">✳</span><h3 className="mt-3 font-semibold">{query.trim() ? 'No matches this time.' : 'Your library starts here.'}</h3><p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-[#83887f]">{query.trim() ? 'Try another phrase, title, or tag.' : 'Save a link and add a note or tag so it is easier to find later.'}</p></div>}
  </>
}
