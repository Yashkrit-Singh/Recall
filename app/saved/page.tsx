import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AddItem, SearchPanel } from './library'
import { signOut } from './actions'
import { searchSavedItems } from '@/lib/saved-search.server'

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

type Props = { searchParams: Promise<{ q?: string; error?: string; uploaded?: string; notice?: string }> }

export default async function SavedPage({ searchParams }: Props) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const q = (params.q ?? '').trim()
  let items: SavedItem[] = []
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
      searchMode = result.mode
      searchWarning = result.warning
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Search is unavailable. Check the database setup.'
    }
  } else {
    const { data, error } = await supabase.from('saved_items').select('id,user_id,source_url,title,notes,tags,created_at,updated_at,embedding_status,embedding_error').order('created_at', { ascending: false })
    items = (data ?? []) as SavedItem[]
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
  const { error: retrievalSchemaError } = await supabase.from('saved_items').select('media_retrieval_status').limit(0)
  retrievalSchemaReady = !retrievalSchemaError
  if (retrievalSchemaReady && items.length) {
    const { data: retrievalData } = await supabase.from('saved_items')
      .select('id,media_retrieval_status,media_retrieval_error')
      .in('id', items.map(item => item.id))
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
    const { count } = await supabase.from('saved_items').select('id', { count: 'exact', head: true })
      .in('metadata_generation_status', ['pending', 'processing'])
    metadataActiveCount = count ?? 0
  }
  const [legacyMissingResult, failedResult, activeResult, activeMediaResult, activeRetrievalResult] = await Promise.all([
    searchProvider === 'nomic' ? supabase.rpc('count_unqueued_saved_item_embeddings') : Promise.resolve({ data: 0, error: null }),
    searchProvider === 'nomic' ? supabase.from('saved_items').select('id', { count: 'exact', head: true }).eq('embedding_status', 'failed') : Promise.resolve({ count: 0, error: null }),
    searchProvider === 'nomic' ? supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('embedding_status', ['pending', 'processing']) : Promise.resolve({ count: 0, error: null }),
    supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('media_status', ['pending', 'processing']),
    retrievalSchemaReady
      ? supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('media_retrieval_status', ['pending', 'retrieving', 'retry_wait'])
      : Promise.resolve({ count: 0, error: null }),
  ])
  if (searchProvider === 'nomic' && (legacyMissingResult.error || failedResult.error || activeResult.error)) {
    searchWarning = [searchWarning, 'Run the durable embedding queue migration in Supabase to enable indexing status.'].filter(Boolean).join(' ')
  }

  return <main className="min-h-screen px-4 pb-16 sm:px-8">
    <header className="mx-auto flex max-w-6xl items-center justify-between border-b border-[#e5e4dc] py-5"><a href="/saved" className="text-sm font-bold tracking-[.18em] text-[#526449]">RECALL<span className="ml-2 align-middle text-[10px] font-normal tracking-normal text-[#9a9d93]">YOUR PERSONAL MEMORY</span></a><div className="flex items-center gap-3"><span className="hidden text-xs text-[#82877d] sm:inline">{user.email}</span><form action={signOut}><button className="rounded-full border border-[#dedfd8] px-3.5 py-2 text-xs font-medium text-[#62685f] hover:bg-white">Sign out</button></form></div></header>
    <div className="mx-auto grid max-w-6xl gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_330px] lg:gap-12 lg:py-12">
      <section className="min-w-0 lg:order-1">
        <div className="mb-7"><p className="text-xs font-semibold uppercase tracking-[.16em] text-[#829077]">Your personal library</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Find that thing again.</h1><p className="mt-2 text-sm text-[#777d73]">A growing collection of ideas, places, and things to come back to.</p></div>
        {(params.error || loadError) && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{loadError || params.error}</p>}
        {params.uploaded === '1' && <p role="status" className="mb-4 rounded-xl bg-[#edf3e9] px-4 py-3 text-sm text-[#4c6842]">Video saved. Local processing is queued.</p>}
        {params.notice === 'retrieval-not-queued' && <p role="status" className="mb-4 rounded-xl bg-[#f4f2e8] px-4 py-3 text-sm text-[#6e674b]">Your link was saved, but media retrieval could not be queued. Apply migration 008 and check the local worker configuration.</p>}
        {mediaRetrievalEnabled && !retrievalSchemaReady && <p role="status" className="mb-4 rounded-xl bg-[#f4f2e8] px-4 py-3 text-sm text-[#6e674b]">Experimental link retrieval is enabled locally, but migration 008 is not detected yet. Links still save normally.</p>}
        <SearchPanel initialItems={items} initialQuery={q} initialMode={searchMode} initialWarning={searchWarning}
          legacyMissingCount={Number(legacyMissingResult.data ?? 0)} failedCount={failedResult.count ?? 0}
          activeIndexingCount={(activeResult.count ?? 0) + (activeMediaResult.count ?? 0) + (activeRetrievalResult.count ?? 0) + (searchProvider === 'embeddinggemma2' ? multimodalActiveCount : 0) + metadataActiveCount}
          searchProvider={searchProvider} multimodalSchemaReady={multimodalSchemaReady} multimodalActiveCount={multimodalActiveCount} multimodalFailedCount={multimodalFailedCount} />
      </section>
      <aside className="lg:order-2"><div className="lg:sticky lg:top-8"><AddItem videoUploadsEnabled={videoUploadsEnabled} mediaRetrievalEnabled={mediaRetrievalEnabled && retrievalSchemaReady} /><div className="mt-5 rounded-[22px] bg-[#e9ede4] p-5"><p className="text-xs font-semibold uppercase tracking-[.14em] text-[#66765e]">A little reminder</p><p className="mt-2 text-sm leading-6 text-[#5f6859]">{mediaRetrievalEnabled ? 'Experimental local retrieval may work with some public Reel links. It never uses passwords, browser cookies, or access-control workarounds.' : 'Recall processes videos you upload using tools running on this machine. Link retrieval is disabled by default.'}</p></div></div></aside>
    </div>
  </main>
}
