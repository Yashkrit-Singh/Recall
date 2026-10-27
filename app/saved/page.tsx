import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AddItem, SearchPanel } from './library'
import { signOut } from './actions'
import { searchSavedItems } from '@/lib/saved-search.server'
import { TelegramConnection } from './telegram-connection'

export type SavedItem = {
  id: string; user_id: string; source_url: string; title: string; notes: string; tags: string[]; created_at: string; updated_at: string; rank?: number
  embedding_status: 'pending' | 'processing' | 'ready' | 'failed'; embedding_error: string | null
  media_storage_key?: string | null; media_status?: 'pending' | 'processing' | 'ready' | 'partially_ready' | 'failed' | null
  media_error?: string | null; media_duration_seconds?: number | null
  media_retrieval_status?: 'not_requested' | 'pending' | 'retrieving' | 'retrieved' | 'unsupported' | 'requires_authorization' | 'retry_wait' | 'failed'
  media_retrieval_error?: string | null
  transcript_segments?: Array<{ start: number; end: number; text: string }>
  ocr_frames?: Array<{ time: number; text: string }>
  visual_descriptions?: Array<{ time: number; text: string }>
  extracted_text?: string
  matched_modality?: 'video' | 'audio' | 'metadata'
  segment_start?: number | null
  segment_end?: number | null
  search_index?: string
  embeddinggemma_status?: 'pending' | 'processing' | 'ready' | 'failed' | null
  embeddinggemma_error?: string | null
  metadata_generation_status?: 'not_requested' | 'waiting_for_media' | 'pending' | 'processing' | 'ready' | 'partially_ready' | 'failed' | null
  metadata_generation_error?: string | null
  metadata_generation_warnings?: string[]
  metadata_summary?: string
  metadata_transcript_summary?: string
  metadata_visual_summary?: string
}

type Props = { searchParams: Promise<{ q?: string; error?: string; uploaded?: string; notice?: string; page?: string; saved?: string }> }
const PAGE_SIZE = 12

export default async function SavedPage({ searchParams }: Props) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const q = (params.q ?? '').trim()
  const page = Math.max(0, Number.parseInt(params.page ?? '0', 10) || 0)
  let items: SavedItem[] = []
  let totalItems = 0
  let loadError = ''
  let videoUploadsEnabled = false
  let retrievalSchemaReady = false
  let multimodalSchemaReady = false
  let multimodalActiveCount = 0
  let multimodalFailedCount = 0
  let metadataActiveCount = 0
  const configuredProvider = (process.env.RECALL_SEARCH_PROVIDER || 'embeddinggemma2').trim().toLowerCase()
  const searchProvider: 'embeddinggemma2' | 'nomic' = configuredProvider === 'nomic' ? 'nomic' : 'embeddinggemma2'
  const mediaRetrievalEnabled = process.env.RECALL_YTDLP_ENABLED === 'true'
  let searchMode: 'recent' | 'keyword' | 'hybrid' | 'multimodal' = 'recent'
  let searchWarning = ''
  if (q) {
    try {
      const result = await searchSavedItems(supabase, q)
      items = result.items as SavedItem[]
      totalItems = items.length
      searchMode = result.mode
      searchWarning = result.warning
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Search is unavailable. Check the database setup.'
    }
  } else {
    const { data, count, error } = await supabase.from('saved_items')
      .select('id,user_id,source_url,title,notes,tags,created_at,updated_at,embedding_status,embedding_error', { count: 'exact' })
      .order('created_at', { ascending: false }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    items = (data ?? []) as SavedItem[]
    totalItems = count ?? 0
    if (error) loadError = 'Your library could not be loaded. Check the database setup.'
    if (!error) {
      const { error: mediaSchemaError } = await supabase.from('saved_items').select('media_storage_key').limit(0)
      if (!mediaSchemaError) {
        videoUploadsEnabled = true
        if (items.length) {
          const { data: mediaData, error: mediaError } = await supabase.from('saved_items')
            .select('id,media_storage_key,media_status,media_error,media_duration_seconds,transcript_segments,ocr_frames,visual_descriptions,extracted_text')
            .in('id', items.map(item => item.id))
          if (!mediaError) {
            const mediaById = new Map((mediaData ?? []).map(row => [row.id, row]))
            items = items.map(item => ({ ...item, ...mediaById.get(item.id) }))
          }
        }
      }
      const { error: metadataSchemaError } = await supabase.from('saved_items').select('metadata_generation_status').limit(0)
      if (!metadataSchemaError && items.length) {
        const { data: metadataRows } = await supabase.from('saved_items')
          .select('id,metadata_generation_status,metadata_generation_error,metadata_generation_warnings,metadata_summary,metadata_transcript_summary,metadata_visual_summary')
          .in('id', items.map(item => item.id))
        if (metadataRows) {
          const byId = new Map(metadataRows.map(row => [row.id, row]))
          items = items.map(item => ({ ...item, ...byId.get(item.id) }))
        }
      }
    }
  }
  const { error: retrievalSchemaError } = await supabase.from('saved_items').select('media_retrieval_status').limit(0)
  retrievalSchemaReady = !retrievalSchemaError
  if (retrievalSchemaReady && items.length && !q) {
    const { data: retrievalData } = await supabase.from('saved_items').select('id,media_retrieval_status,media_retrieval_error').in('id', items.map(item => item.id))
    const retrievalById = new Map((retrievalData ?? []).map(row => [row.id, row]))
    items = items.map(item => ({ ...item, ...retrievalById.get(item.id) }))
  }
  const { error: multimodalSchemaError } = await supabase.from('saved_items').select('embeddinggemma_status').limit(0)
  multimodalSchemaReady = !multimodalSchemaError
  if (multimodalSchemaReady) {
    const [active, failed] = await Promise.all([
      supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('embeddinggemma_status', ['pending', 'processing']),
      supabase.from('saved_items').select('id', { count: 'exact', head: true }).eq('embeddinggemma_status', 'failed'),
    ])
    multimodalActiveCount = active.count ?? 0
    multimodalFailedCount = failed.count ?? 0
    if (items.length && !q) {
      const { data: multimodalData } = await supabase.from('saved_items').select('id,embeddinggemma_status,embeddinggemma_error').in('id', items.map(item => item.id))
      if (multimodalData) {
        const byId = new Map(multimodalData.map(row => [row.id, row]))
        items = items.map(item => ({ ...item, ...byId.get(item.id) }))
      }
    }
  }
  const { error: metadataCountSchemaError } = await supabase.from('saved_items').select('metadata_generation_status').limit(0)
  if (!metadataCountSchemaError) {
    const { count } = await supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('metadata_generation_status', ['pending', 'processing'])
    metadataActiveCount = count ?? 0
  }
  const [legacyMissingResult, failedResult, activeResult, activeMediaResult, activeRetrievalResult] = await Promise.all([
    searchProvider === 'nomic' ? supabase.rpc('count_unqueued_saved_item_embeddings') : Promise.resolve({ data: 0, error: null }),
    searchProvider === 'nomic' ? supabase.from('saved_items').select('id', { count: 'exact', head: true }).eq('embedding_status', 'failed') : Promise.resolve({ count: 0, error: null }),
    searchProvider === 'nomic' ? supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('embedding_status', ['pending', 'processing']) : Promise.resolve({ count: 0, error: null }),
    supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('media_status', ['pending', 'processing']),
    retrievalSchemaReady ? supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('media_retrieval_status', ['pending', 'retrieving', 'retry_wait']) : Promise.resolve({ count: 0, error: null }),
  ])
  if (searchProvider === 'nomic' && (legacyMissingResult.error || failedResult.error || activeResult.error)) searchWarning = [searchWarning, 'Run the durable embedding queue migration in Supabase to enable indexing status.'].filter(Boolean).join(' ')

  return <main className="min-h-screen px-4 pb-16 sm:px-7">
    <header className="mx-auto flex max-w-7xl items-center justify-between border-b border-[var(--recall-line)] py-4 sm:py-5">
      <Link href="/saved" className="flex items-center gap-3" aria-label="Recall library home">
        <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#29243e] text-lg font-semibold text-white shadow-sm">R</span>
        <span><span className="block text-[17px] font-semibold tracking-tight">Recall</span><span className="block text-[11px] text-[var(--recall-muted)]">Personal video memory</span></span>
      </Link>
      <div className="flex items-center gap-2 sm:gap-4">
        <span className="hidden items-center gap-2 rounded-full border border-[#e6e3dc] bg-white px-3 py-2 text-xs font-medium text-[#55535f] md:flex"><span className="h-2 w-2 rounded-full bg-[#4c9a71]" />{user.email}</span>
        <form action={signOut}><button className="rounded-xl border border-[#e4e1dc] bg-white px-3.5 py-2.5 text-sm font-medium text-[#5e5b66] transition hover:bg-[#f5f3ef]">Sign out</button></form>
      </div>
    </header>
    <div className="mx-auto grid max-w-7xl gap-8 py-7 sm:py-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
      <section className="min-w-0">
        <div className="mb-7 sm:mb-8"><p className="text-xs font-semibold uppercase tracking-[.13em] text-[var(--recall-violet)]">Your personal library</p><h1 className="mt-2 text-[30px] font-semibold leading-tight tracking-[-.035em] sm:text-[38px]">Your video memory</h1><p className="mt-2 max-w-xl text-[15px] leading-6 text-[var(--recall-muted)]">Save the videos worth remembering. Find them whenever you need them.</p></div>
        {(params.error || loadError) && <p role="alert" className="mb-4 rounded-xl border border-[#efd4d1] bg-[#fff7f6] px-4 py-3 text-sm text-[#9b4e48]">{loadError || params.error}</p>}
        {params.saved === '1' && <p role="status" className="mb-4 rounded-xl border border-[#d7eadc] bg-[#f3faf5] px-4 py-3 text-sm text-[#38694b]">Link saved. Recall will attempt to retrieve and analyze it when the configured local tools support the source.</p>}
        {params.notice === 'duplicate' && <p role="status" className="mb-4 rounded-xl border border-[#e6e2f2] bg-[#f7f6fc] px-4 py-3 text-sm text-[#5c537f]">That video is already in your library. We kept the existing saved item.</p>}
        {params.notice === 'duplicate-edit' && <p role="status" className="mb-4 rounded-xl border border-[#e6e2f2] bg-[#f7f6fc] px-4 py-3 text-sm text-[#5c537f]">Another saved item already uses that video link. Your changes were not applied.</p>}
        {params.uploaded === '1' && <p role="status" className="mb-4 rounded-xl border border-[#d7eadc] bg-[#f3faf5] px-4 py-3 text-sm text-[#38694b]">Video uploaded. It is ready for local processing.</p>}
        {params.notice === 'retrieval-not-queued' && <p role="status" className="mb-4 rounded-xl border border-[#eee2c2] bg-[#fffaf0] px-4 py-3 text-sm text-[#78653b]">Your link was saved, but media retrieval could not be queued. The link remains in your library.</p>}
        {mediaRetrievalEnabled && !retrievalSchemaReady && <p role="status" className="mb-4 rounded-xl border border-[#eee2c2] bg-[#fffaf0] px-4 py-3 text-sm text-[#78653b]">Local link retrieval is enabled, but its database migration is not detected. Links still save normally.</p>}
        <AddItem videoUploadsEnabled={videoUploadsEnabled} mediaRetrievalEnabled={mediaRetrievalEnabled && retrievalSchemaReady} />
        {!q && totalItems === 0 && !loadError && <section className="mt-5 rounded-2xl border border-[#e9e6e1] bg-white p-5 sm:p-6" aria-labelledby="first-steps-heading">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--recall-violet)]">A simple workflow</p><h2 id="first-steps-heading" className="mt-2 text-lg font-semibold">Your next favourite video is worth remembering.</h2><p className="mt-1 max-w-xl text-sm leading-6 text-[var(--recall-muted)]">Paste a video link above to start building your personal video memory.</p>
          <ol className="mt-5 grid gap-3 sm:grid-cols-3"><li className="rounded-xl bg-[#f8f7f5] p-3"><span className="text-xs font-semibold text-[var(--recall-violet)]">01</span><p className="mt-1 text-sm font-medium">Save a link</p><p className="mt-1 text-xs leading-5 text-[var(--recall-muted)]">Keep the original source in your private library.</p></li><li className="rounded-xl bg-[#f8f7f5] p-3"><span className="text-xs font-semibold text-[var(--recall-violet)]">02</span><p className="mt-1 text-sm font-medium">Recall analyses</p><p className="mt-1 text-xs leading-5 text-[var(--recall-muted)]">Local tools process media when it is available.</p></li><li className="rounded-xl bg-[#f8f7f5] p-3"><span className="text-xs font-semibold text-[var(--recall-violet)]">03</span><p className="mt-1 text-sm font-medium">Find it in Telegram</p><p className="mt-1 text-xs leading-5 text-[var(--recall-muted)]">Connect the bot to search your videos in natural language.</p></li></ol>
        </section>}
        <div className="mt-8">
          <SearchPanel initialItems={items} initialQuery={q} initialMode={searchMode} initialWarning={searchWarning} legacyMissingCount={Number(legacyMissingResult.data ?? 0)} failedCount={failedResult.count ?? 0}
            activeIndexingCount={(activeResult.count ?? 0) + (activeMediaResult.count ?? 0) + (activeRetrievalResult.count ?? 0) + (searchProvider === 'embeddinggemma2' ? multimodalActiveCount : 0) + metadataActiveCount}
            searchProvider={searchProvider} multimodalSchemaReady={multimodalSchemaReady} multimodalActiveCount={multimodalActiveCount} multimodalFailedCount={multimodalFailedCount} />
          {!q && totalItems > PAGE_SIZE && <nav aria-label="Library pages" className="mt-6 flex items-center justify-between border-t border-[var(--recall-line)] pt-4 text-sm">
            {page > 0 ? <Link className="rounded-lg px-3 py-2 text-[#5c536f] hover:bg-white" href={`/saved?page=${page - 1}`}>← Newer</Link> : <span />}
            <span className="text-xs text-[var(--recall-muted)]">Page {page + 1} of {Math.ceil(totalItems / PAGE_SIZE)}</span>
            {(page + 1) * PAGE_SIZE < totalItems ? <Link className="rounded-lg px-3 py-2 text-[#5c536f] hover:bg-white" href={`/saved?page=${page + 1}`}>Older →</Link> : <span />}
          </nav>}
        </div>
      </section>
      <aside className="min-w-0 lg:pt-1"><div className="space-y-4 lg:sticky lg:top-6">
        <TelegramConnection enabled={Boolean(process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_BOT_TOKEN)} botUsername={process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '').trim() || ''} />
        <section className="rounded-2xl border border-[#e9e6e1] bg-[#f0eef9] p-5"><p className="text-sm font-semibold text-[#37324a]">Your videos stay yours</p><p className="mt-2 text-sm leading-6 text-[#676377]">Your library is private to your Recall account. Video retrieval and analysis run only through the tools configured for this installation.</p></section>
      </div></aside>
    </div>
  </main>
}
