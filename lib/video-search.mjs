const VIDEO_HOSTS = new Set([
  'instagram.com', 'www.instagram.com', 'm.instagram.com',
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'tiktok.com', 'www.tiktok.com', 'vimeo.com', 'www.vimeo.com',
])

function parsePublicHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let raw = value.trim()
  if (/^(?:www\.)?instagram\.com\//i.test(raw)) raw = `https://${raw}`
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || !VIDEO_HOSTS.has(url.hostname.toLowerCase())) return null
  return url
}

function hasVideoRoute(url) {
  const path = url.pathname.toLowerCase()
  if (url.hostname.endsWith('instagram.com')) return /^\/(?:reel|reels|p|tv)\/[^/]+/.test(path)
  if (url.hostname === 'youtu.be') return path.length > 1
  if (url.hostname.endsWith('youtube.com')) return path === '/watch' && url.searchParams.has('v') || /^\/(?:shorts|live)\/[^/]+/.test(path)
  if (url.hostname.endsWith('tiktok.com')) return /\/@[^/]+\/video\/\d+/.test(path)
  if (url.hostname.endsWith('vimeo.com')) return /^\/\d+/.test(path)
  return false
}

export function canonicalVideoUrl(value) {
  const url = parsePublicHttpsUrl(value)
  return url && hasVideoRoute(url) ? url.toString() : null
}

export function isSavedVideo(item) {
  if (item?.media_storage_key) return true
  const url = parsePublicHttpsUrl(item?.source_url)
  return Boolean(url && hasVideoRoute(url))
}

function timestampReason(item) {
  if (!['video', 'audio'].includes(item.matched_modality) || !Number.isFinite(item.segment_start)) return null
  const seconds = Math.max(0, Math.floor(item.segment_start))
  return `Relevant ${item.matched_modality} segment at ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function selectStrongVideos({ userId, items, maxResults = 3, minSimilarity = 0.63, minKeywordRank = 2.5 }) {
  const limit = Math.max(1, Math.min(3, Math.floor(Number(maxResults) || 3)))
  const seen = new Set()
  const selected = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.user_id !== userId || typeof item.id !== 'string' || seen.has(item.id)) continue
    seen.add(item.id)
    const sourceUrl = canonicalVideoUrl(item.source_url)
    if (!isSavedVideo(item) || !sourceUrl) continue

    // These are separate eligibility gates: vector similarity is only for the
    // active EmbeddingGemma index; keyword rank is only for the keyword RPC.
    // Their raw numeric scales are never combined.
    const semanticMatch = item.search_index === 'EmbeddingGemma 2'
      && Number.isFinite(item.similarity) && item.similarity >= minSimilarity
    const keywordMatch = Number.isFinite(item.keyword_rank ?? item.rank)
      && (item.keyword_rank ?? item.rank) >= minKeywordRank
    if (!semanticMatch && !keywordMatch) continue

    selected.push({
      id: item.id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 120) : 'Saved video',
      url: sourceUrl,
      reason: timestampReason(item),
    })
    if (selected.length >= limit) break
  }
  return selected
}

export async function searchSavedVideos({ userId, query, search, maxResults, minSimilarity, minKeywordRank }) {
  const cleaned = typeof query === 'string' ? query.trim().slice(0, 300) : ''
  if (!cleaned) return { items: [], warning: 'Send a description of a saved video.' }
  const result = await search(cleaned)
  return {
    items: selectStrongVideos({ userId, items: result.items, maxResults, minSimilarity, minKeywordRank }),
    warning: result.warning || '',
    mode: result.mode,
  }
}
