import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { createEmbedding, embeddingSetupMessage, getEmbeddingModel, vectorLiteral } from './embeddings.server'

export type SearchItem = {
  id: string
  user_id: string
  source_url: string
  title: string
  notes: string
  tags: string[]
  created_at: string
  updated_at: string
  rank?: number
  similarity?: number
  embedding_status?: 'pending' | 'processing' | 'ready' | 'failed'
  embedding_error?: string | null
  media_storage_key?: string | null
  media_status?: 'pending' | 'processing' | 'ready' | 'partially_ready' | 'failed' | null
  media_error?: string | null
  media_duration_seconds?: number | null
  transcript_segments?: Array<{ start: number; end: number; text: string }>
  ocr_frames?: Array<{ time: number; text: string }>
  visual_descriptions?: Array<{ time: number; text: string }>
  extracted_text?: string
}

async function addIndexingStatus(supabase: SupabaseClient, items: SearchItem[]) {
  if (!items.length) return items
  const { data } = await supabase.from('saved_items')
    .select('id,embedding_status,embedding_error,media_storage_key,media_status,media_error,media_duration_seconds,transcript_segments,ocr_frames,visual_descriptions,extracted_text')
    .in('id', items.map(item => item.id))
  if (!data) return items
  const statusById = new Map(data.map(row => [row.id, row]))
  return items.map(item => ({ ...item, ...statusById.get(item.id) }))
}

export async function searchSavedItems(supabase: SupabaseClient, query: string) {
  const { data: keywordRows, error: keywordError } = await supabase.rpc('search_saved_items', { search_term: query })
  if (keywordError) throw new Error('Keyword search is unavailable. Check that the database migrations have run.')
  const keyword = (keywordRows ?? []) as SearchItem[]

  const setupMessage = embeddingSetupMessage()
  if (setupMessage) return { items: await addIndexingStatus(supabase, keyword), mode: 'keyword' as const, warning: `${setupMessage} Showing keyword matches instead.` }

  try {
    const queryVector = await createEmbedding(query, 'query')
    const { data: semanticRows, error: semanticError } = await supabase.rpc('search_saved_items_semantic', {
      query_embedding: vectorLiteral(queryVector),
      result_limit: 30,
      required_model: getEmbeddingModel(),
    })
    if (semanticError) throw new Error('Semantic search is not available. Check that the vector migration has run.')
    const semantic = (semanticRows ?? []) as SearchItem[]

    // Reciprocal rank fusion combines two ordered lists without comparing unlike scores.
    const fused = new Map<string, { item: SearchItem; score: number }>()
    const addRanks = (rows: SearchItem[]) => rows.forEach((item, index) => {
      const current = fused.get(item.id) ?? { item, score: 0 }
      current.score += 1 / (60 + index + 1)
      if (item.similarity !== undefined) current.item = item
      fused.set(item.id, current)
    })
    addRanks(semantic)
    addRanks(keyword)
    const rankedItems = Array.from(fused.values()).sort((a, b) => b.score - a.score).map(({ item }) => item)
    return {
      items: await addIndexingStatus(supabase, rankedItems),
      mode: semantic.length ? 'hybrid' as const : 'keyword' as const,
      warning: semantic.length ? '' : 'No close semantic matches were found. Showing keyword matches, if any.',
    }
  } catch (error) {
    return {
      items: await addIndexingStatus(supabase, keyword),
      mode: 'keyword' as const,
      warning: error instanceof Error ? `${error.message} Showing keyword matches instead.` : 'Semantic search failed. Showing keyword matches instead.',
    }
  }
}
