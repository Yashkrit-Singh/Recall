import 'server-only'

import { createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { searchSavedItems } from '../saved-search.server'
import { searchSavedVideos } from '../video-search.mjs'

function base64url(value: string) {
  return Buffer.from(value).toString('base64url')
}

function scopedUserJwt(userId: string) {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) throw new Error('Set the server-only SUPABASE_JWT_SECRET to enforce Supabase RLS for Telegram searches.')
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const issuer = `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, '')}/auth/v1`
  const claims = base64url(JSON.stringify({ iss: issuer, sub: userId, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 60 }))
  const content = `${header}.${claims}`
  const signature = createHmac('sha256', secret).update(content).digest('base64url')
  return `${content}.${signature}`
}

export async function searchVideosAsTelegramUser(userId: string, query: string) {
  const provider = (process.env.RECALL_SEARCH_PROVIDER || 'embeddinggemma2').trim().toLowerCase()
  if (provider !== 'embeddinggemma2') throw new Error('Telegram video search requires RECALL_SEARCH_PROVIDER=embeddinggemma2; legacy Nomic vectors are not queried.')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase server configuration is missing.')
  const token = scopedUserJwt(userId)
  const supabase = createClient(url, key, { accessToken: async () => token })
  return searchSavedVideos({
    userId,
    query,
    search: async (searchQuery: string) => {
      const result = await searchSavedItems(supabase, searchQuery)
      return result
    },
    minSimilarity: bounded(process.env.RECALL_TELEGRAM_MIN_SIMILARITY, 0.63, 0, 1),
    minKeywordRank: bounded(process.env.RECALL_TELEGRAM_MIN_KEYWORD_RANK, 2.5, 0, 20),
    maxResults: bounded(process.env.RECALL_TELEGRAM_MAX_RESULTS, 3, 1, 3),
  })
}

function bounded(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}
