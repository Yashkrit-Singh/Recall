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
  transcript_segments?: Array<{ start: number; end: number; text: string }>
  ocr_frames?: Array<{ time: number; text: string }>
  visual_descriptions?: Array<{ time: number; text: string }>
  extracted_text?: string
}

type Props = { searchParams: Promise<{ q?: string; error?: string; uploaded?: string }> }

export default async function SavedPage({ searchParams }: Props) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const q = (params.q ?? '').trim()
  let items: SavedItem[] = []
  let loadError = ''
  let videoUploadsEnabled = false
  let searchMode: 'recent' | 'keyword' | 'hybrid' = 'recent'
  let searchWarning = ''
  if (q) {
    try {
      const result = await searchSavedItems(supabase, q)
      items = result.items as SavedItem[]
      searchMode = result.mode
      searchWarning = result.warning
      const { error: mediaSchemaError } = await supabase.from('saved_items').select('media_storage_key').limit(0)
      videoUploadsEnabled = !mediaSchemaError
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
  }
  const [legacyMissingResult, failedResult, activeResult, activeMediaResult] = await Promise.all([
    supabase.rpc('count_unqueued_saved_item_embeddings'),
    supabase.from('saved_items').select('id', { count: 'exact', head: true }).eq('embedding_status', 'failed'),
    supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('embedding_status', ['pending', 'processing']),
    supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('media_status', ['pending', 'processing']),
  ])
  if (legacyMissingResult.error || failedResult.error || activeResult.error) {
    searchWarning = [searchWarning, 'Run the durable embedding queue migration in Supabase to enable indexing status.'].filter(Boolean).join(' ')
  }

  return <main className="min-h-screen px-4 pb-16 sm:px-8">
    <header className="mx-auto flex max-w-6xl items-center justify-between border-b border-[#e5e4dc] py-5"><a href="/saved" className="text-sm font-bold tracking-[.18em] text-[#526449]">RECALL<span className="ml-2 align-middle text-[10px] font-normal tracking-normal text-[#9a9d93]">YOUR PERSONAL MEMORY</span></a><div className="flex items-center gap-3"><span className="hidden text-xs text-[#82877d] sm:inline">{user.email}</span><form action={signOut}><button className="rounded-full border border-[#dedfd8] px-3.5 py-2 text-xs font-medium text-[#62685f] hover:bg-white">Sign out</button></form></div></header>
    <div className="mx-auto grid max-w-6xl gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_330px] lg:gap-12 lg:py-12">
      <section className="min-w-0 lg:order-1">
        <div className="mb-7"><p className="text-xs font-semibold uppercase tracking-[.16em] text-[#829077]">Your personal library</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Find that thing again.</h1><p className="mt-2 text-sm text-[#777d73]">A growing collection of ideas, places, and things to come back to.</p></div>
        {(params.error || loadError) && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{loadError || params.error}</p>}
        {params.uploaded === '1' && <p role="status" className="mb-4 rounded-xl bg-[#edf3e9] px-4 py-3 text-sm text-[#4c6842]">Video saved. Local processing is queued.</p>}
        <SearchPanel initialItems={items} initialQuery={q} initialMode={searchMode} initialWarning={searchWarning}
          legacyMissingCount={Number(legacyMissingResult.data ?? 0)} failedCount={failedResult.count ?? 0}
          activeIndexingCount={(activeResult.count ?? 0) + (activeMediaResult.count ?? 0)} />
      </section>
      <aside className="lg:order-2"><div className="lg:sticky lg:top-8"><AddItem videoUploadsEnabled={videoUploadsEnabled} /><div className="mt-5 rounded-[22px] bg-[#e9ede4] p-5"><p className="text-xs font-semibold uppercase tracking-[.14em] text-[#66765e]">A little reminder</p><p className="mt-2 text-sm leading-6 text-[#5f6859]">Recall processes videos you upload using tools running on this machine. Saved links remain user-provided and are never scraped.</p></div></div></aside>
    </div>
  </main>
}
