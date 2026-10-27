import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalVideoUrl, searchSavedVideos, selectStrongVideos } from '../lib/video-search.mjs'

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const pastaId = '11111111-1111-4111-8111-111111111111'
const waterfallId = '22222222-2222-4222-8222-222222222222'

function candidate(overrides = {}) {
  return {
    id: pastaId, user_id: ownerA, title: 'Creamy pasta recipe',
    source_url: 'https://www.instagram.com/reel/pasta123/',
    media_storage_key: 'private-generated-media.mp4',
    search_index: 'EmbeddingGemma 2', similarity: 0.71,
    matched_modality: 'video', segment_start: 18,
    ...overrides,
  }
}

test('vague natural-language retrieval returns the strongest matching saved video first', () => {
  const pasta = candidate({ title: 'Creamy tomato pasta', similarity: 0.72 })
  const loose = candidate({ id: waterfallId, title: 'Travel video with green scenery', source_url: 'https://www.instagram.com/reel/travel123/', similarity: 0.49 })
  const result = selectStrongVideos({ userId: ownerA, items: [pasta, loose] })
  assert.equal(result.length, 1)
  assert.equal(result[0].id, pastaId)
  assert.equal(result[0].title, 'Creamy tomato pasta')
})

test('uses existing rank-fused order after independent semantic and keyword eligibility checks', () => {
  const semanticFirst = candidate({ similarity: 0.68 })
  const keywordSecond = candidate({ id: waterfallId, title: 'Pasta with white sauce', similarity: undefined, search_index: undefined, keyword_rank: 4 })
  const result = selectStrongVideos({ userId: ownerA, items: [semanticFirst, keywordSecond] })
  assert.deepEqual(result.map(item => item.id), [pastaId, waterfallId])
})

test('returns no more than three strong results even if the result limit is larger', () => {
  const items = Array.from({ length: 6 }, (_, index) => candidate({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    source_url: `https://www.instagram.com/reel/item${index}/`, similarity: 0.8 - index / 100,
  }))
  assert.equal(selectStrongVideos({ userId: ownerA, items, maxResults: 20 }).length, 3)
})

test('excludes weak semantic candidates rather than padding with unrelated videos', () => {
  const weak = candidate({ similarity: 0.62 })
  assert.deepEqual(selectStrongVideos({ userId: ownerA, items: [weak] }), [])
})

test('no-match query returns no video cards', async () => {
  const result = await searchSavedVideos({
    userId: ownerA, query: 'an underwater volcano on Mars',
    search: async () => ({ mode: 'multimodal', items: [candidate({ similarity: 0.21 })] }),
  })
  assert.deepEqual(result.items, [])
})

test('deduplicates repeated segment candidates representing the same saved video', () => {
  const first = candidate({ similarity: 0.73 })
  const duplicate = candidate({ similarity: 0.72, matched_modality: 'audio', segment_start: 41 })
  assert.equal(selectStrongVideos({ userId: ownerA, items: [first, duplicate] }).length, 1)
})

test('keyword fallback remains usable when semantic indexing is unavailable', async () => {
  const keywordVideo = candidate({ search_index: undefined, similarity: undefined, keyword_rank: 4 })
  const result = await searchSavedVideos({
    userId: ownerA, query: 'creamy pasta',
    search: async () => ({ mode: 'keyword', warning: 'EmbeddingGemma unavailable; keyword fallback.', items: [keywordVideo] }),
  })
  assert.equal(result.items[0].id, pastaId)
  assert.match(result.warning, /keyword fallback/)
})

test('user A cannot receive user B saved videos even if a search adapter returns one', async () => {
  const otherUser = candidate({ user_id: ownerB })
  const result = await searchSavedVideos({ userId: ownerA, query: 'pasta', search: async () => ({ items: [otherUser] }) })
  assert.deepEqual(result.items, [])
})

test('bot response items contain only saved record identity, title, validated URL and no private media path', () => {
  const result = selectStrongVideos({ userId: ownerA, items: [candidate()] })
  assert.equal(result[0].id, pastaId)
  assert.equal(result[0].url, 'https://www.instagram.com/reel/pasta123/')
  assert.equal(JSON.stringify(result).includes('private-generated-media.mp4'), false)
  assert.equal(JSON.stringify(result).includes('0.71'), false)
})

test('rejects invalid destinations and canonicalizes only verified video URLs', () => {
  assert.equal(canonicalVideoUrl('javascript:alert(1)'), null)
  assert.equal(canonicalVideoUrl('http://localhost:3000/api/videos/private/file'), null)
  assert.equal(canonicalVideoUrl('instagram.com/reel/abc123'), 'https://instagram.com/reel/abc123')
  assert.equal(canonicalVideoUrl('https://www.instagram.com/accounts/login/'), null)
})

test('ordinary searches call only the search adapter and never enqueue video processing', async () => {
  let enqueues = 0
  const result = await searchSavedVideos({
    userId: ownerA, query: 'creamy pasta',
    search: async () => ({ items: [candidate()] }),
    enqueueVideoProcessing: async () => { enqueues += 1 },
  })
  assert.equal(result.items.length, 1)
  assert.equal(enqueues, 0)
})
