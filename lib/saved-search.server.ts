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
  keyword_rank?: number
  retrieval_rank?: number
  similarity?: number
  embedding_status?: 'pending' | 'processing' | 'ready' | 'failed'
  embedding_error?: string | null
  media_storage_key?: string | null
  media_status?: 'pending' | 'processing' | 'ready' | 'partially_ready' | 'failed' | null
  media_error?: string | null
  media_duration_seconds?: number | null
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

async function addIndexingStatus(supabase: SupabaseClient, items: SearchItem[]) {
  if (!items.length) return items
  const { data } = await supabase.from('saved_items')
    .select('id,embedding_status,embedding_error,media_storage_key,media_status,media_error,media_duration_seconds,transcript_segments,ocr_frames,visual_descriptions,extracted_text')
    .in('id', items.map(item => item.id))
  if (!data) return items
  const statusById = new Map(data.map(row => [row.id, row]))
  let updated = items.map(item => ({ ...item, ...statusById.get(item.id) }))
  const { data: generatedMetadataRows } = await supabase.from('saved_items')
    .select('id,metadata_generation_status,metadata_generation_error,metadata_generation_warnings,metadata_summary,metadata_transcript_summary,metadata_visual_summary')
    .in('id', items.map(item => item.id))
  if (generatedMetadataRows) {
    const generatedMetadataById = new Map(generatedMetadataRows.map(row => [row.id, row]))
    updated = updated.map(item => ({ ...item, ...generatedMetadataById.get(item.id) }))
  }
  const { data: multimodalStatusRows } = await supabase.from('saved_items')
    .select('id,embeddinggemma_status,embeddinggemma_error')
    .in('id', items.map(item => item.id))
  if (multimodalStatusRows) {
    const multimodalStatusById = new Map(multimodalStatusRows.map(row => [row.id, row]))
    updated = updated.map(item => ({ ...item, ...multimodalStatusById.get(item.id) }))
  }
  const { data: retrievalRows } = await supabase.from('saved_items')
    .select('id,media_retrieval_status,media_retrieval_error')
    .in('id', items.map(item => item.id))
  if (retrievalRows) {
    const retrievalById = new Map(retrievalRows.map(row => [row.id, row]))
    updated = updated.map(item => ({ ...item, ...retrievalById.get(item.id) }))
  }
  return updated
}

export async function searchSavedItems(supabase: SupabaseClient, query: string) {
  const { data: keywordRows, error: keywordError } = await supabase.rpc('search_saved_items', { search_term: query })
  if (keywordError) throw new Error('Keyword search is unavailable. Check that the database migrations have run.')
  const keyword = (keywordRows ?? []) as SearchItem[]

  const searchProvider = (process.env.RECALL_SEARCH_PROVIDER || 'embeddinggemma2').trim().toLowerCase()
  if (searchProvider !== 'embeddinggemma2' && searchProvider !== 'nomic') {
    throw new Error('RECALL_SEARCH_PROVIDER must be either "embeddinggemma2" or "nomic".')
  }

  if (searchProvider === 'embeddinggemma2') {
    try {
      const serviceUrl = process.env.EMBEDDINGGEMMA_URL || 'http://127.0.0.1:11601'
      const token = process.env.EMBEDDINGGEMMA_TOKEN
      if (!token) throw new Error('Set EMBEDDINGGEMMA_TOKEN for local multimodal search.')
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(serviceUrl)) {
        throw new Error('EmbeddingGemma search must use a local loopback service URL.')
      }
      const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/v1/embed-query`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query }), signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`Local EmbeddingGemma service returned HTTP ${response.status}.`)
      const payload = await response.json() as { model?: string; dimensions?: number; embedding?: number[] }
      if (payload.model !== 'google/embeddinggemma-2' || payload.dimensions !== 768 || payload.embedding?.length !== 768) {
        throw new Error('Local EmbeddingGemma service returned an incompatible query vector.')
      }
      const { data: multimodalRows, error: multimodalError } = await supabase.rpc('search_saved_item_multimodal', {
        query_embedding: vectorLiteral(payload.embedding), result_limit: 30,
      })
      if (multimodalError) throw new Error('Multimodal search is unavailable. Apply its additive migration first.')
      const multimodal = (multimodalRows ?? []) as SearchItem[]
      const fused = new Map<string, { item: SearchItem; score: number; keywordRank?: number }>()
      const addRanks = (rows: SearchItem[]) => rows.forEach((item, index) => {
        const current = fused.get(item.id) ?? { item, score: 0 }
        current.score += 1 / (60 + index + 1)
        if (item.rank !== undefined) current.keywordRank = Math.max(current.keywordRank ?? 0, item.rank)
        if (item.similarity !== undefined) current.item = item
        fused.set(item.id, current)
      })
      addRanks(multimodal)
      addRanks(keyword)
      const items = Array.from(fused.values()).sort((a, b) => b.score - a.score).map(({ item, score, keywordRank }) => ({
        ...item, keyword_rank: keywordRank, retrieval_rank: score,
      }))
      return {
        items: await addIndexingStatus(supabase, items),
        mode: multimodal.length ? 'multimodal' as const : 'keyword' as const,
        warning: multimodal.length ? '' : 'No EmbeddingGemma vectors match yet. Showing keyword results.',
      }
    } catch (error) {
      return {
        items: await addIndexingStatus(supabase, keyword),
        mode: 'keyword' as const,
        warning: error instanceof Error ? `${error.message} Showing keyword matches instead.` : 'Multimodal search failed. Showing keyword matches instead.',
      }
    }
  }

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
    const fused = new Map<string, { item: SearchItem; score: number; keywordRank?: number }>()
    const addRanks = (rows: SearchItem[]) => rows.forEach((item, index) => {
      const current = fused.get(item.id) ?? { item, score: 0 }
      current.score += 1 / (60 + index + 1)
      if (item.rank !== undefined) current.keywordRank = Math.max(current.keywordRank ?? 0, item.rank)
      if (item.similarity !== undefined) current.item = item
      fused.set(item.id, current)
    })
    addRanks(semantic)
    addRanks(keyword)
    const rankedItems = Array.from(fused.values()).sort((a, b) => b.score - a.score).map(({ item, score, keywordRank }) => ({
      ...item, keyword_rank: keywordRank, retrieval_rank: score,
    }))
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
