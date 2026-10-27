'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import type { SavedItem } from './page'
import { backfillMissingEmbeddings, backfillMultimodalEmbeddings, createItem, deleteItem, regenerateVideoMetadata, retryFailedEmbeddings, retryFailedMediaRetrieval, updateItem } from './actions'

const fieldClass = 'mt-1.5 w-full rounded-xl border border-[#e5e2de] bg-white px-3.5 py-3 text-sm text-[#282630] placeholder:text-[#aaa8b0] outline-none transition focus:border-[#8979df] focus:ring-4 focus:ring-[#ece9fc]'
const buttonClass = 'inline-flex items-center justify-center rounded-xl bg-[var(--recall-violet)] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[var(--recall-violet-dark)] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#d8d2ff]'

function SubmitButton({ editing = false }: { editing?: boolean }) {
  const { pending } = useFormStatus()
  return <button disabled={pending} className={buttonClass}>{pending ? (editing ? 'Saving…' : 'Saving link…') : (editing ? 'Save changes' : 'Save video')}</button>
}

function ItemForm({ item, onCancel }: { item?: SavedItem; onCancel?: () => void }) {
  return <form action={item ? updateItem : createItem} className="space-y-4">
    {item && <input type="hidden" name="id" value={item.id} />}
    <label className="block text-xs font-semibold text-[#6c6975]">VIDEO LINK<input required type="url" name="source_url" defaultValue={item?.source_url} placeholder="https://www.instagram.com/reel/…" className={fieldClass} aria-label="Video URL" /></label>
    {item && <>
      <label className="block text-xs font-semibold text-[#6c6975]">TITLE<input required name="title" defaultValue={item.title} maxLength={180} placeholder="What do you want to remember?" className={fieldClass} /></label>
      <label className="block text-xs font-semibold text-[#6c6975]">NOTES<textarea name="notes" defaultValue={item.notes} rows={3} placeholder="A thought or useful detail…" className={`${fieldClass} resize-y`} /></label>
      <label className="block text-xs font-semibold text-[#6c6975]">TAGS <span className="font-normal normal-case">· comma separated</span><input name="tags" defaultValue={item.tags.join(', ')} placeholder="design, recipe, places" className={fieldClass} /></label>
    </>}
    <div className="flex flex-wrap items-center gap-3"><SubmitButton editing={Boolean(item)} />{onCancel && <button type="button" onClick={onCancel} className="rounded-xl px-3 py-2.5 text-sm font-medium text-[#696672] hover:bg-[#f4f2ef]">Cancel</button>}{!item && <span className="text-xs text-[#8b8992]">We save the link first. Analysis depends on media availability.</span>}</div>
  </form>
}

function VideoUpload() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const router = useRouter()
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('Uploading and validating video…')
    try {
      const form = event.currentTarget
      const response = await fetch('/api/videos/upload', { method: 'POST', body: new FormData(form) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Upload failed.')
      setMessage('Video uploaded. Local processing can begin.'); form.reset(); router.refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Upload failed.') }
    finally { setBusy(false) }
  }
  return <form onSubmit={upload} className="space-y-3 rounded-xl border border-[#e9e6e1] bg-[#fbfaf8] p-4">
    <label className="block text-xs font-semibold text-[#6c6975]">VIDEO FILE<input required name="video" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" className="mt-2 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[#eeebfa] file:px-3 file:py-2 file:text-xs file:font-medium file:text-[#5547a2]" /></label>
    <label className="block text-xs font-semibold text-[#6c6975]">TITLE<input name="title" maxLength={180} placeholder="Optional title" className={fieldClass} /></label>
    <label className="block text-xs font-semibold text-[#6c6975]">DESCRIPTION<textarea name="description" maxLength={8000} rows={2} placeholder="Optional description" className={`${fieldClass} resize-y`} /></label>
    <label className="block text-xs font-semibold text-[#6c6975]">TAGS<input name="tags" placeholder="Comma-separated tags" className={fieldClass} /></label>
    <button disabled={busy} className={buttonClass}>{busy ? 'Uploading…' : 'Upload video'}</button>
    {message && <p role="status" className="text-xs text-[#696672]">{message}</p>}
  </form>
}

export function AddItem({ videoUploadsEnabled, mediaRetrievalEnabled }: { videoUploadsEnabled: boolean; mediaRetrievalEnabled: boolean }) {
  return <section className="rounded-2xl border border-[#e5e1f2] bg-white p-5 shadow-[0_8px_24px_rgba(37,32,62,.035)] sm:p-6" aria-labelledby="save-video-heading">
    <div className="mb-4 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eeebfa] text-[#5e4db7]" aria-hidden="true">↗</span><div><p className="text-xs font-semibold uppercase tracking-[.1em] text-[#7568bb]">Keep it close</p><h2 id="save-video-heading" className="mt-0.5 text-lg font-semibold tracking-tight">Save a video</h2></div></div>
    <ItemForm />
    {mediaRetrievalEnabled && <p className="mt-3 text-xs leading-5 text-[#8b8992]">Recall saves the link immediately and will try local retrieval for supported links. It won’t claim content it could not access.</p>}
    {videoUploadsEnabled ? <details className="group mt-5 border-t border-[#efedea] pt-4"><summary className="cursor-pointer list-none text-sm font-medium text-[#5e4db7] [&::-webkit-details-marker]:hidden"><span className="group-open:hidden">Or upload a video</span><span className="hidden group-open:inline">Close upload form</span></summary><div className="mt-3"><VideoUpload /></div></details> : <p className="mt-4 text-xs text-[#8b8992]">Video upload is not available until the media setup is complete.</p>}
  </section>
}

function StatusLabel({ tone, children }: { tone: 'ready' | 'pending' | 'failed'; children: React.ReactNode }) {
  const styles = tone === 'ready' ? 'bg-[#edf7ef] text-[#3d754e]' : tone === 'failed' ? 'bg-[#fff0ef] text-[#a24d47]' : 'bg-[#f3f1fb] text-[#6555ae]'
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>
}

export function ItemCard({ item, searchProvider }: { item: SavedItem; searchProvider: 'embeddinggemma2' | 'nomic' }) {
  const [editing, setEditing] = useState(false)
  const [showVideo, setShowVideo] = useState(false)
  const [retrievalBusy, setRetrievalBusy] = useState(false)
  const [retrievalMessage, setRetrievalMessage] = useState('')
  const [videoRetryBusy, setVideoRetryBusy] = useState(false)
  const [videoRetryMessage, setVideoRetryMessage] = useState('')
  const [metadataBusy, setMetadataBusy] = useState(false)
  const [metadataMessage, setMetadataMessage] = useState('')
  const router = useRouter()
  if (editing) return <article className="rounded-2xl border border-[#e5e1f2] bg-white p-5 sm:p-6"><div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">Edit saved video</h3><button type="button" onClick={() => setEditing(false)} className="rounded-lg px-2 py-1 text-sm text-[#696672] hover:bg-[#f4f2ef]">Close</button></div><ItemForm item={item} onCancel={() => setEditing(false)} /></article>
  const date = new Date(item.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
  let domain = item.media_storage_key ? 'Uploaded video' : item.source_url
  try { if (!item.media_storage_key) domain = new URL(item.source_url).hostname.replace(/^www\./, '') } catch { /* URL validation occurs when saving. */ }
  const primaryStatus = searchProvider === 'embeddinggemma2' ? item.embeddinggemma_status : item.embedding_status
  const displayTitle = item.title || (item.metadata_generation_status === 'processing' || item.metadata_generation_status === 'pending' ? 'Generating title…' : 'Saved video')
  const metadataStatusText = item.metadata_generation_status === 'waiting_for_media' ? 'Waiting for video' : item.metadata_generation_status === 'pending' ? 'Queued for analysis' : item.metadata_generation_status === 'processing' ? 'Understanding video content…' : item.metadata_generation_status === 'ready' ? 'Content analysis ready' : item.metadata_generation_status === 'partially_ready' ? 'Partially analyzed' : item.metadata_generation_status === 'failed' ? 'Analysis needs attention' : 'Not analyzed'
  const retrievalLabel = item.media_retrieval_status === 'pending' ? 'Saved · waiting to retrieve' : item.media_retrieval_status === 'retrieving' ? 'Retrieving video…' : item.media_retrieval_status === 'retry_wait' ? 'Waiting to retry retrieval' : item.media_retrieval_status === 'retrieved' ? 'Video retrieved · analysis next' : item.media_retrieval_status === 'requires_authorization' ? 'Source requires access' : item.media_retrieval_status === 'unsupported' ? 'Source not supported for retrieval' : item.media_retrieval_status === 'failed' ? 'Video unavailable · link saved' : 'Saved · waiting to analyze'
  const tone = primaryStatus === 'ready' ? 'ready' : primaryStatus === 'failed' || item.media_status === 'failed' || item.media_retrieval_status === 'failed' ? 'failed' : 'pending'
  const statusText = tone === 'ready' ? 'Ready to find in Telegram' : tone === 'failed' ? 'Saved · needs attention' : item.media_status === 'processing' || item.media_retrieval_status === 'retrieving' || item.metadata_generation_status === 'processing' ? 'Understanding video…' : item.embeddinggemma_status === 'processing' || item.embedding_status === 'processing' ? 'Preparing for search…' : 'Saved · processing may take a moment'
  const sourceUrl = item.media_storage_key ? `/api/videos/${item.id}/file` : item.source_url
  return <article className="group overflow-hidden rounded-2xl border border-[#e9e6e1] bg-white transition hover:border-[#d8d3e8] hover:shadow-[0_8px_24px_rgba(37,32,62,.045)]">
    <div className="relative aspect-[16/8.5] overflow-hidden bg-[#f1eff8]">
      {item.media_storage_key && showVideo ? <video controls playsInline preload="metadata" src={`/api/videos/${item.id}/file`} className="h-full w-full bg-black object-contain" aria-label={`Preview ${displayTitle}`} /> : <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(ellipse_at_top,#f7f5ff,#efedf7_75%)]">
        {item.media_storage_key ? <button type="button" onClick={() => setShowVideo(true)} className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-lg text-[#5d4db5] shadow-sm transition hover:scale-105" aria-label={`Load preview for ${displayTitle}`}>▶</button> : <div className="text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-xl font-semibold text-[#6655bc] shadow-sm">R</span><p className="mt-2 text-xs font-medium text-[#827c9d]">Saved video</p></div>}
      </div>}
      <div className="absolute left-3 top-3"><StatusLabel tone={tone}>{statusText}</StatusLabel></div>
    </div>
    <div className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-xs text-[#92909a]">{domain} <span className="px-1">·</span>{date}</p><h3 className="mt-1.5 line-clamp-2 text-[17px] font-semibold leading-snug tracking-[-.02em]"><a href={sourceUrl} target="_blank" rel="noreferrer" className="underline decoration-transparent underline-offset-4 transition hover:decoration-[#9588d5]">{displayTitle}<span aria-hidden="true" className="ml-1.5 text-xs text-[#8273cf]">↗</span></a></h3></div>
        <div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => setEditing(true)} className="rounded-lg px-2 py-1.5 text-xs font-medium text-[#625f6b] hover:bg-[#f4f2ef]">Edit</button><form action={deleteItem} onSubmit={event => { if (!window.confirm(`Delete “${displayTitle}” from your library?`)) event.preventDefault() }}><input type="hidden" name="id" value={item.id} /><button className="rounded-lg px-2 py-1.5 text-xs font-medium text-[#9a5c57] hover:bg-[#fff0ef]">Delete</button></form></div></div>
      {item.search_index === 'EmbeddingGemma 2' && item.matched_modality && <p className="mt-2 text-[11px] font-medium text-[#7064af]">Matched {item.matched_modality}{item.segment_start != null ? ` · ${Math.floor(item.segment_start / 60).toString().padStart(2, '0')}:${Math.floor(item.segment_start % 60).toString().padStart(2, '0')}` : ''} · EmbeddingGemma 2</p>}
      {item.metadata_summary && <p className="mt-2.5 line-clamp-3 text-sm leading-5 text-[#66636e]">{item.metadata_summary}</p>}
      {item.notes && <p className="mt-2 line-clamp-2 text-sm leading-5 text-[#77747e]">{item.notes}</p>}
      {item.tags.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{item.tags.slice(0, 4).map((tag, i) => <span key={`${tag}-${i}`} className="rounded-md bg-[#f4f2f8] px-2 py-1 text-[11px] font-medium text-[#625b7c]">{tag}</span>)}{item.tags.length > 4 && <span className="px-1 py-1 text-[11px] text-[#898692]">+{item.tags.length - 4}</span>}</div>}
      {item.media_retrieval_status && item.media_retrieval_status !== 'not_requested' && <div className="mt-3 border-t border-[#f0eeeb] pt-3"><p className="text-xs text-[#77747e]">{retrievalLabel}</p>{item.media_retrieval_status === 'failed' && <button type="button" disabled={retrievalBusy} onClick={async () => { setRetrievalBusy(true); setRetrievalMessage(''); try { const result = await retryFailedMediaRetrieval(item.id); setRetrievalMessage(result.message); if (result.ok) router.refresh() } catch { setRetrievalMessage('Could not queue retrieval retry.') } finally { setRetrievalBusy(false) } }} className="mt-2 text-xs font-semibold text-[#6252bd] underline disabled:opacity-50">{retrievalBusy ? 'Queueing…' : 'Retry retrieval'}</button>}{retrievalMessage && <p role="status" className="mt-1 text-xs text-[#77747e]">{retrievalMessage}</p>}</div>}
      {(item.media_storage_key || (item.metadata_generation_status && item.metadata_generation_status !== 'not_requested')) && <details className="mt-3 border-t border-[#f0eeeb] pt-3"><summary className="cursor-pointer text-xs font-semibold text-[#686571]">Processing details <span className="font-normal text-[#92909a]">· {metadataStatusText}</span></summary><div className="mt-3 space-y-2 text-xs leading-5 text-[#73717b]">
        {item.metadata_generation_warnings?.map((warning, index) => <p key={index}>{warning}</p>)}
        {item.metadata_transcript_summary && <details><summary className="cursor-pointer font-medium">What is spoken</summary><p className="mt-1">{item.metadata_transcript_summary}</p></details>}
        {item.metadata_visual_summary && <details><summary className="cursor-pointer font-medium">Visual timeline summary</summary><p className="mt-1">{item.metadata_visual_summary}</p></details>}
        {item.transcript_segments?.length ? <details><summary className="cursor-pointer font-medium">Transcript ({item.transcript_segments.length} segments)</summary><div className="mt-2 max-h-44 space-y-2 overflow-auto">{item.transcript_segments.map((segment, i) => <p key={i}><span className="mr-2 text-[#8273cf]">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, '0')}</span>{segment.text}</p>)}</div></details> : null}
        {item.ocr_frames?.length ? <details><summary className="cursor-pointer font-medium">On-screen text ({item.ocr_frames.length} frames)</summary><div className="mt-2 space-y-2">{item.ocr_frames.map((frame, i) => <p key={i}>{Math.floor(frame.time)}s — {frame.text}</p>)}</div></details> : null}
        {item.visual_descriptions?.length ? <details><summary className="cursor-pointer font-medium">Visual descriptions</summary><div className="mt-2 space-y-2">{item.visual_descriptions.map((frame, i) => <p key={i}>{Math.floor(frame.time)}s — {frame.text}</p>)}</div></details> : null}
        {item.extracted_text && <p className="line-clamp-4">{item.extracted_text.slice(0, 500)}</p>}
        {item.media_storage_key && <p>{item.media_status === 'ready' ? 'Video analysis is ready.' : item.media_status === 'partially_ready' ? 'Some video analysis is ready.' : item.media_status === 'failed' ? 'Video analysis could not finish.' : item.media_status === 'processing' ? 'Video analysis is running.' : 'Waiting for the local video worker.'}{item.media_duration_seconds ? ` · ${Math.round(item.media_duration_seconds)} sec` : ''}</p>}
        {item.media_storage_key && item.media_status !== 'pending' && item.media_status !== 'processing' && <button type="button" disabled={videoRetryBusy} onClick={async () => { setVideoRetryBusy(true); setVideoRetryMessage(''); try { const response = await fetch(`/api/videos/${item.id}/retry`, { method: 'POST' }); const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || 'Could not queue video processing.'); setVideoRetryMessage('Processing queued again.'); router.refresh() } catch (error) { setVideoRetryMessage(error instanceof Error ? error.message : 'Could not queue video processing.') } finally { setVideoRetryBusy(false) } }} className="font-semibold text-[#6252bd] underline disabled:opacity-50">{videoRetryBusy ? 'Queueing…' : item.media_status === 'failed' ? 'Retry analysis' : 'Reprocess video'}</button>}{videoRetryMessage && <p role="status">{videoRetryMessage}</p>}
        {item.media_storage_key && (item.media_status === 'ready' || item.media_status === 'partially_ready') && <button type="button" disabled={metadataBusy || item.metadata_generation_status === 'pending' || item.metadata_generation_status === 'processing'} onClick={async () => { setMetadataBusy(true); setMetadataMessage(''); try { const result = await regenerateVideoMetadata(item.id); setMetadataMessage(result.message); if (result.ok) router.refresh() } catch { setMetadataMessage('Could not queue metadata generation.') } finally { setMetadataBusy(false) } }} className="font-semibold text-[#6252bd] underline disabled:opacity-50">{metadataBusy ? 'Queueing…' : item.metadata_generation_status === 'failed' ? 'Retry metadata' : 'Regenerate metadata'}</button>}{metadataMessage && <p role="status">{metadataMessage}</p>}
      </div></details>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#f0eeeb] pt-3"><span className="text-[11px] text-[#93909a]">{primaryStatus === 'ready' ? 'Search index ready' : primaryStatus === 'processing' ? 'Preparing for search…' : primaryStatus === 'failed' ? 'Search indexing needs attention' : searchProvider === 'embeddinggemma2' && !item.embeddinggemma_status ? 'Waiting for search indexing' : 'Saved for later'}</span><a href={sourceUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[#6252bd] hover:text-[#44349f]">Open video ↗</a></div>
    </div>
  </article>
}

export function SearchPanel({ initialItems, initialQuery, initialMode, initialWarning, legacyMissingCount, failedCount, activeIndexingCount: initialActiveCount, searchProvider, multimodalSchemaReady, multimodalActiveCount, multimodalFailedCount }: {
  initialItems: SavedItem[]
  initialQuery: string
  initialMode: 'recent' | 'keyword' | 'hybrid' | 'multimodal'
  initialWarning: string
  legacyMissingCount: number
  failedCount: number
  activeIndexingCount: number
  searchProvider: 'embeddinggemma2' | 'nomic'
  multimodalSchemaReady: boolean
  multimodalActiveCount: number
  multimodalFailedCount: number
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
  const [multimodalActive, setMultimodalActive] = useState(multimodalActiveCount)
  const router = useRouter()

  useEffect(() => {
    setItems(initialItems)
    setMode(initialMode)
    setWarning(initialWarning)
  }, [initialItems, initialMode, initialWarning])
  useEffect(() => setActiveIndexingCount(initialActiveCount), [initialActiveCount])
  useEffect(() => setMultimodalActive(multimodalActiveCount), [multimodalActiveCount])

  useEffect(() => {
    if (activeIndexingCount < 1) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await fetch('/api/indexing/status', { cache: 'no-store' })
        if (response.ok) {
          const result = await response.json() as { activeCount?: number; multimodalActiveCount?: number }
          if (!cancelled && typeof result.activeCount === 'number') {
            setActiveIndexingCount(result.activeCount)
            if (typeof result.multimodalActiveCount === 'number') setMultimodalActive(result.multimodalActiveCount)
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
      const result = await response.json() as { items?: SavedItem[]; mode?: 'keyword' | 'hybrid' | 'multimodal'; warning?: string; error?: string }
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

  function queueMultimodal() {
    setBackfillMessage('')
    startBackfill(async () => {
      const result = await backfillMultimodalEmbeddings()
      setBackfillMessage(result.message)
      if (result.ok && result.indexed) router.refresh()
    })
  }

  return <>
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><h2 className="text-lg font-semibold tracking-tight">Your library</h2><p className="mt-1 text-xs text-[#85828d]">Filter saved items here. For natural-language video discovery, use Telegram.</p></div><span className="text-xs text-[#98959f]">{query.trim() ? `${items.length} matches` : 'Recently saved'}</span></div>
    <form onSubmit={submitSearch} className="mb-5 flex gap-2 rounded-2xl border border-[#e7e4df] bg-white p-2 shadow-[0_3px_12px_rgba(38,33,57,.025)]">
      <span aria-hidden="true" className="flex items-center pl-3 text-xl text-[#77718c]">⌕</span>
      <input name="q" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search titles, notes, tags, or video details…" aria-label="Filter your saved videos" className="min-w-0 flex-1 bg-transparent px-1 py-2.5 text-sm outline-none" />
      <button disabled={pending} className="rounded-xl bg-[#29243e] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#403961] disabled:opacity-60">{pending ? 'Searching…' : 'Filter'}</button>
      {query && <a href="/saved" onClick={event => { event.preventDefault(); setQuery(''); setItems(initialItems); setMode('recent'); setWarning(''); setError(''); window.history.replaceState(null, '', '/saved') }} className="self-center pr-2 text-xs text-[#737a70]">Clear</a>}
    </form>
    {pending && <p role="status" className="mb-4 rounded-xl bg-[#f0f2ec] px-4 py-3 text-sm text-[#596650]">Looking across your saved titles, descriptions, and tags…</p>}
    {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
    {warning && <p role="status" className="mb-4 rounded-xl bg-[#f4f2e8] px-4 py-3 text-sm text-[#6e674b]">{warning}</p>}
    {!query.trim() && searchProvider === 'embeddinggemma2' && <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-[#e4e7dc] bg-[#fbfcf8] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[#626a5e]">{!multimodalSchemaReady ? 'Apply the EmbeddingGemma 2 migration to enable multimodal indexing.' : multimodalFailedCount > 0 ? `${multimodalFailedCount} item${multimodalFailedCount === 1 ? '' : 's'} failed EmbeddingGemma indexing.` : multimodalActive > 0 ? `${multimodalActive} EmbeddingGemma job${multimodalActive === 1 ? '' : 's'} waiting or running.` : 'EmbeddingGemma 2 is the active semantic search index.'}</p>
      {multimodalSchemaReady && <button type="button" onClick={queueMultimodal} disabled={backfillPending} className="rounded-xl border border-[#cfd6c7] px-4 py-2.5 text-sm font-semibold text-[#40523b] hover:bg-white disabled:opacity-60">{backfillPending ? 'Queueing…' : 'Backfill / retry EmbeddingGemma items'}</button>}
      {backfillMessage && <p role="status" className="text-xs text-[#66705e] sm:basis-full">{backfillMessage}</p>}
    </div>}
    {!query.trim() && searchProvider === 'nomic' && (legacyMissingCount > 0 || failedCount > 0 || activeIndexingCount > 0) && <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-[#e4e7dc] bg-[#fbfcf8] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-[#626a5e]">{activeIndexingCount > 0 ? `${activeIndexingCount} item${activeIndexingCount === 1 ? '' : 's'} waiting for or receiving embeddings.` : failedCount > 0 ? `${failedCount} item${failedCount === 1 ? '' : 's'} failed indexing.` : `${legacyMissingCount} existing item${legacyMissingCount === 1 ? ' needs' : 's need'} backfilling.`}</p>
      {legacyMissingCount > 0 && <button type="button" onClick={queueMissing} disabled={backfillPending} className="rounded-xl border border-[#cfd6c7] px-4 py-2.5 text-sm font-semibold text-[#40523b] hover:bg-white disabled:opacity-60">{backfillPending ? 'Queueing…' : 'Backfill existing items'}</button>}
      {failedCount > 0 && <button type="button" onClick={retryFailed} disabled={backfillPending} className="rounded-xl border border-[#cfd6c7] px-4 py-2.5 text-sm font-semibold text-[#40523b] hover:bg-white disabled:opacity-60">{backfillPending ? 'Queueing…' : 'Retry failed indexing'}</button>}
      {backfillMessage && <p role="status" className="text-xs text-[#66705e] sm:basis-full">{backfillMessage}</p>}
    </div>}
    {items.length ? <div className="grid gap-4 md:grid-cols-2">{items.map(item => <ItemCard key={item.id} item={item} searchProvider={searchProvider} />)}</div> : <div className="rounded-2xl border border-dashed border-[#dedbe5] bg-white px-6 py-10 text-center"><span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f0eef9] text-xl text-[#6252bd]">⌕</span><h3 className="mt-3 font-semibold">{query.trim() ? 'No matches this time.' : 'Your library is ready when you are.'}</h3><p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-[#85828d]">{query.trim() ? 'Try another title, note, or tag.' : 'Your saved videos will appear here.'}</p></div>}
  </>
}
