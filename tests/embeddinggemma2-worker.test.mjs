import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { getMediaPath, processOne } from '../scripts/embeddinggemma2-worker.mjs'

test('media paths must be generated filenames directly inside private storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-eg2-path-'))
  try {
    await writeFile(path.join(root, 'a1b2c3.mp4'), 'fixture')
    assert.equal(await getMediaPath('a1b2c3.mp4', root), await realpath(path.join(root, 'a1b2c3.mp4')))
    await assert.rejects(getMediaPath('../outside.mp4', root), /invalid/i)
    await assert.rejects(getMediaPath('missing.mp4', root))
    const nested = path.join(root, 'nested')
    await mkdir(nested)
    const outside = path.join(nested, 'outside.mp4')
    await writeFile(outside, 'fixture')
    await symlink(outside, path.join(root, 'escape.mp4'))
    await assert.rejects(getMediaPath('escape.mp4', root), /outside private storage/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('successful worker execution sends model vectors through the version-checked RPC', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-eg2-worker-'))
  try {
    const mediaName = 'a1b2c3.mp4'
    await writeFile(path.join(root, mediaName), 'fixture')
    const calls = []
    const client = {
      rpc: async (name, args) => {
        calls.push([name, args])
        return name === 'claim_multimodal_embedding_job'
          ? { data: [{ job_id: 'job1', item_id: 'item1', user_id: 'user1', scope: 'media', media_version: 3, metadata_version: 2, claim_token: 'lease' }] }
          : { data: true }
      },
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: {
        id: 'item1', user_id: 'user1', title: 'Clip', notes: 'Note', tags: ['tag'], media_storage_key: mediaName,
        embeddinggemma_media_version: 3, embeddinggemma_metadata_version: 2,
      } }) }) }) }) }),
    }
    const fetchImpl = async (_url, init) => {
      assert.equal(JSON.parse(init.body).scope, 'media')
      return { ok: true, json: async () => ({ model: 'google/embeddinggemma-2', dimensions: 768, segments: [{ modality: 'video', start: 0, end: 30, embedding: Array(768).fill(0.1) }] }) }
    }
    const result = await processOne({ client, serviceUrl: 'http://127.0.0.1:11601', token: 'local', mediaRoot: root, fetchImpl })
    assert.deepEqual(result, { processed: true, status: 'ready', itemId: 'item1' })
    assert.equal(calls[1][0], 'complete_multimodal_embedding_job')
    assert.equal(calls[1][1].target_segments[0].embedding.length, 768)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('service failures are recorded for bounded database retries without losing the item', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-eg2-failure-'))
  try {
    await writeFile(path.join(root, 'a1b2c3.mp4'), 'fixture')
    const calls = []
    const client = {
      rpc: async (name, args) => {
        calls.push([name, args])
        if (name === 'claim_multimodal_embedding_job') return { data: [{ job_id: 'job1', item_id: 'item1', user_id: 'user1', scope: 'media', media_version: 3, metadata_version: 2, claim_token: 'lease' }] }
        if (name === 'fail_multimodal_embedding_job') return { data: 'retry_wait' }
        return { data: null }
      },
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: {
        id: 'item1', user_id: 'user1', title: 'Clip', notes: '', tags: [], media_storage_key: 'a1b2c3.mp4',
        embeddinggemma_media_version: 3, embeddinggemma_metadata_version: 2,
      } }) }) }) }) }),
    }
    const connectionError = new Error('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11601'), { code: 'ECONNREFUSED' }) })
    const result = await processOne({ client, serviceUrl: 'http://127.0.0.1:11601', token: 'local', mediaRoot: root, fetchImpl: async () => { throw connectionError } })
    assert.equal(result.status, 'retry_wait')
    assert.deepEqual(calls.map(([name]) => name), ['claim_multimodal_embedding_job', 'fail_multimodal_embedding_job'])
    assert.match(calls[1][1].safe_error, /ECONNREFUSED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('metadata indexing does not require a retrieved video file', async () => {
  const calls = []
  const client = {
    rpc: async (name, args) => {
      calls.push([name, args])
      return name === 'claim_multimodal_embedding_job'
        ? { data: [{ job_id: 'job-meta', item_id: 'item-link', user_id: 'user1', scope: 'metadata', media_version: 0, metadata_version: 1, claim_token: 'lease' }] }
        : { data: true }
    },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: {
      id: 'item-link', user_id: 'user1', title: 'Saved recipe Reel', notes: 'Try the roasted tomatoes', tags: ['cooking'],
      media_storage_key: null, embeddinggemma_media_version: 0, embeddinggemma_metadata_version: 1,
    } }) }) }) }) }),
  }
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.path, null)
    assert.equal(body.scope, 'metadata')
    assert.deepEqual(body.tags, ['cooking'])
    return { ok: true, json: async () => ({ model: 'google/embeddinggemma-2', dimensions: 768, segments: [{ modality: 'metadata', start: null, end: null, embedding: Array(768).fill(0.2) }] }) }
  }
  const result = await processOne({ client, serviceUrl: 'http://127.0.0.1:11601', token: 'local', mediaRoot: '/not-needed-for-metadata', fetchImpl })
  assert.equal(result.status, 'ready')
  assert.equal(calls[1][0], 'complete_multimodal_embedding_job')
})

test('concurrent edit marks a claimed job superseded without sending its stale vectors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-eg2-stale-'))
  try {
    await writeFile(path.join(root, 'a1b2c3.mp4'), 'fixture')
    const calls = []
    const client = {
      rpc: async (name, args) => {
        calls.push([name, args])
        return name === 'claim_multimodal_embedding_job'
          ? { data: [{ job_id: 'job1', item_id: 'item1', user_id: 'user1', scope: 'media', media_version: 3, metadata_version: 2, claim_token: 'lease' }] }
          : { data: false }
      },
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: {
        id: 'item1', user_id: 'user1', title: 'Clip', notes: '', tags: [], media_storage_key: 'a1b2c3.mp4',
        embeddinggemma_media_version: 4, embeddinggemma_metadata_version: 2,
      } }) }) }) }) }),
    }
    const result = await processOne({ client, serviceUrl: 'http://127.0.0.1:11601', token: 'local', mediaRoot: root, fetchImpl: async () => { throw new Error('must not call model') } })
    assert.equal(result.status, 'superseded')
    assert.equal(calls[1][0], 'complete_multimodal_embedding_job')
    assert.deepEqual(calls[1][1].target_segments, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('migration keeps the Nomic index separate and scopes multimodal rows to their owner', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202610250001_embeddinggemma2_multimodal_index.sql', import.meta.url), 'utf8')
  assert.match(sql, /create table if not exists public\.saved_item_multimodal_embeddings/i)
  assert.match(sql, /model_id text not null check \(model_id = 'google\/embeddinggemma-2'\)/i)
  assert.match(sql, /embedding extensions\.vector\(768\)/i)
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /using \(user_id=\(select auth\.uid\(\)\)\)/i)
  assert.match(sql, /search_saved_item_multimodal/i)
  assert.match(sql, /preserves saved_items\.embedding/i)
  assert.doesNotMatch(sql, /drop table|delete from public\.saved_items/i)
})
