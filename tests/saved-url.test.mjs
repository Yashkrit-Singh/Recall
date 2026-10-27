import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { findEquivalentSavedItemId, instagramDuplicateFilters, normalizeSavedUrl, SavedUrlError } from '../lib/saved-url.mjs'

test('Instagram share URLs with tracking and fragments normalize to one canonical Reel URL', () => {
  const variants = [
    'https://www.instagram.com/reel/ABC123/',
    'https://instagram.com/reel/ABC123',
    'https://m.instagram.com/reels/ABC123/?igsh=tracking#share',
    'http://www.instagram.com/reel/ABC123/?utm_source=copy_link&igsh=another',
  ]
  for (const variant of variants) assert.equal(normalizeSavedUrl(variant).url, 'https://www.instagram.com/reel/ABC123/')
})

test('Instagram post permalinks retain their identifier and discard irrelevant query data', () => {
  assert.equal(normalizeSavedUrl('https://www.instagram.com/p/Ab_C-9?img_index=1#caption').url, 'https://www.instagram.com/p/Ab_C-9/')
})

test('non-Instagram video URLs are preserved without Instagram-specific query or path rules', () => {
  const youtube = 'https://youtube.com/reel/ABC123?si=tracking#t=12'
  assert.equal(normalizeSavedUrl(youtube).url, youtube)
  assert.equal(normalizeSavedUrl(youtube).isInstagram, false)
})

test('malformed URLs, Instagram lookalike hosts, unsupported paths, and missing identifiers are rejected clearly', () => {
  for (const input of [
    'https://instagram.com.evil.example/reel/ABC123',
    'https://evil.instagram.com/reel/ABC123',
    'https://www.instagram.com/stories/user/123',
    'https://www.instagram.com/reel/',
    'not a url',
    'javascript:alert(1)',
  ]) assert.throws(() => normalizeSavedUrl(input), SavedUrlError)
})

test('duplicate lookup patterns include equivalent Reel path spelling and duplicate match compares canonical URLs', () => {
  const normalized = normalizeSavedUrl('https://www.instagram.com/reel/ABC_123/?igsh=tracking')
  assert.deepEqual(instagramDuplicateFilters(normalized), [
    'source_url.ilike.%instagram.com/reel/ABC_123%',
    'source_url.ilike.%instagram.com/reels/ABC_123%',
  ])
  assert.equal(findEquivalentSavedItemId([
    { id: 'same-reel', source_url: 'https://m.instagram.com/reels/ABC_123?utm_medium=share#x' },
    { id: 'different-case', source_url: 'https://instagram.com/reel/abc_123/' },
  ], normalized.url), 'same-reel')
  assert.equal(findEquivalentSavedItemId([{ id: 'current', source_url: normalized.url }], normalized.url, 'current'), null)
})

test('save and edit duplicate queries are scoped to the signed-in user and normalized URL is stored', async () => {
  const actions = await readFile(new URL('../app/saved/actions.ts', import.meta.url), 'utf8')
  assert.match(actions, /normalizeSavedUrl\(formData\.get\('source_url'\)\)/)
  assert.match(actions, /\.eq\('user_id', userId\)/)
  assert.match(actions, /const source_url = normalized\.url/)
  assert.match(actions, /findUserDuplicate\(supabase, user\.id, normalized/)
})
