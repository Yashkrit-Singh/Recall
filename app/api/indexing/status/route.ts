import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to check indexing status.' }, { status: 401 })

  const provider = (process.env.RECALL_SEARCH_PROVIDER || 'embeddinggemma2').trim().toLowerCase()
  const legacy = provider === 'nomic'
    ? await supabase.from('saved_items').select('id', { count: 'exact', head: true }).in('embedding_status', ['pending', 'processing'])
    : { count: 0, error: null }
  if (legacy.error) {
    return NextResponse.json({ error: 'Indexing status is unavailable. Run the durable embedding queue migration.' }, { status: 503 })
  }
  const { count: mediaCount } = await supabase.from('saved_items')
    .select('id', { count: 'exact', head: true })
    .in('media_status', ['pending', 'processing'])
  const { error: retrievalSchemaError } = await supabase.from('saved_items').select('media_retrieval_status').limit(0)
  let retrievalCount = 0
  if (!retrievalSchemaError) {
    const { count: activeRetrievalCount } = await supabase.from('saved_items')
      .select('id', { count: 'exact', head: true })
      .in('media_retrieval_status', ['pending', 'retrieving', 'retry_wait'])
    retrievalCount = activeRetrievalCount ?? 0
  }
  const { error: multimodalSchemaError } = await supabase.from('saved_items').select('embeddinggemma_status').limit(0)
  let multimodalCount = 0
  if (!multimodalSchemaError) {
    const { count: activeMultimodalCount } = await supabase.from('saved_items')
      .select('id', { count: 'exact', head: true })
      .in('embeddinggemma_status', ['pending', 'processing'])
    multimodalCount = activeMultimodalCount ?? 0
  }
  const { error: metadataSchemaError } = await supabase.from('saved_items').select('metadata_generation_status').limit(0)
  let metadataActiveCount = 0
  if (!metadataSchemaError) {
    const { count } = await supabase.from('saved_items').select('id', { count: 'exact', head: true })
      .in('metadata_generation_status', ['pending', 'processing'])
    metadataActiveCount = count ?? 0
  }
  return NextResponse.json({ activeCount: (legacy.count ?? 0) + (mediaCount ?? 0) + retrievalCount + multimodalCount + metadataActiveCount, multimodalActiveCount: multimodalCount, metadataActiveCount })
}
