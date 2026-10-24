import os from 'node:os'
import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import nextEnv from '@next/env'
import { createClient } from '@supabase/supabase-js'

const { loadEnvConfig } = nextEnv

function safeError(error) {
  const message = error instanceof Error ? error.message : 'EmbeddingGemma processing failed.'
  const cause = error instanceof Error && error.cause instanceof Error
    ? `; cause=${error.cause.message}${error.cause.code ? ` (${error.cause.code})` : ''}`
    : ''
  return `${message}${cause}`
    .replace(/(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]')
    .slice(0, 800)
}

function bounded(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

export async function getMediaPath(key, mediaRoot) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9-]+\.(mp4|mov|webm)$/i.test(key)) {
    throw new Error('Saved media reference is invalid.')
  }
  const root = await realpath(mediaRoot)
  const candidate = await realpath(path.join(root, key))
  if (path.dirname(candidate) !== root) throw new Error('Saved media is outside private storage.')
  const info = await stat(candidate)
  if (!info.isFile()) throw new Error('Saved media file is missing.')
  return candidate
}

export async function processOne({ client, serviceUrl, token, mediaRoot, fetchImpl = fetch, workerName = `${os.hostname()}-${process.pid}` }) {
  const { data: jobs, error: claimError } = await client.rpc('claim_multimodal_embedding_job', { worker_name: workerName })
  if (claimError) throw new Error(`Could not claim EmbeddingGemma job: ${claimError.message}`)
  const job = jobs?.[0]
  if (!job) return { processed: false }
  try {
    const { data: item, error } = await client.from('saved_items')
      .select('id,user_id,title,notes,tags,metadata_summary,media_storage_key,embeddinggemma_media_version,embeddinggemma_metadata_version')
      .eq('id', job.item_id).eq('user_id', job.user_id).single()
    if (error || !item) throw new Error('Could not load the current saved video.')
    const mediaVersion = Number(item.embeddinggemma_media_version)
    const metadataVersion = Number(item.embeddinggemma_metadata_version)
    if ((job.scope === 'media' && mediaVersion !== Number(job.media_version)) ||
        (job.scope === 'metadata' && metadataVersion !== Number(job.metadata_version))) {
      await client.rpc('complete_multimodal_embedding_job', {
        target_job_id: job.job_id, target_claim_token: job.claim_token, target_segments: [],
      })
      return { processed: true, status: 'superseded', itemId: job.item_id }
    }
    const mediaPath = job.scope === 'media' ? await getMediaPath(item.media_storage_key, mediaRoot) : null
    const body = {
      path: mediaPath,
      scope: job.scope,
      title: item.title || '',
      notes: [item.metadata_summary, item.notes].filter(value => typeof value === 'string' && value.trim()).join('\n\n'),
      tags: Array.isArray(item.tags) ? item.tags : [],
    }
    const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/v1/index-media`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(bounded(process.env.EG2_REQUEST_TIMEOUT_MS, 1_200_000, 30_000, 1_800_000)),
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Local EmbeddingGemma service returned HTTP ${response.status}: ${detail.slice(0, 500)}`)
    }
    const payload = await response.json()
    if (payload.model !== 'google/embeddinggemma-2' || payload.dimensions !== 768 || !Array.isArray(payload.segments)) {
      throw new Error('Local service returned an incompatible model or vector payload.')
    }
    const { data: completed, error: completeError } = await client.rpc('complete_multimodal_embedding_job', {
      target_job_id: job.job_id, target_claim_token: job.claim_token, target_segments: payload.segments,
    })
    if (completeError) throw new Error(`Could not store EmbeddingGemma vectors: ${completeError.message}`)
    return { processed: true, status: completed ? 'ready' : 'superseded', itemId: job.item_id }
  } catch (error) {
    const diagnostic = safeError(error)
    console.error(`EmbeddingGemma job ${job.job_id} failed: ${diagnostic}`)
    const { data: status, error: failError } = await client.rpc('fail_multimodal_embedding_job', {
      target_job_id: job.job_id, target_claim_token: job.claim_token, safe_error: diagnostic,
    })
    if (failError) throw new Error(`Could not record EmbeddingGemma failure: ${failError.message}`)
    return { processed: true, status: status ?? 'retrying', itemId: job.item_id }
  }
}

export async function runWorker() {
  loadEnvConfig(process.cwd())
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const token = process.env.EMBEDDINGGEMMA_TOKEN
  const serviceUrl = process.env.EMBEDDINGGEMMA_URL || 'http://127.0.0.1:11601'
  if (!supabaseUrl || !serviceKey) throw new Error('Set Supabase URL and server-only service role key.')
  if (!token) throw new Error('Set EMBEDDINGGEMMA_TOKEN for the local inference service.')
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(serviceUrl)) throw new Error('EmbeddingGemma service must use a local loopback URL.')
  const client = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const mediaRoot = path.resolve(process.env.RECALL_MEDIA_DIR || '.local-media')
  const pollMs = bounded(process.env.MULTIMODAL_WORKER_POLL_MS, 1500, 250, 30_000)
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const workerName = process.env.MULTIMODAL_WORKER_ID || `${os.hostname()}-${process.pid}`
  console.info(`Recall EmbeddingGemma worker ${workerName}: google/embeddinggemma-2 (local).`)
  try {
    while (!stopping) {
      try {
        const result = await processOne({ client, serviceUrl, token, mediaRoot, workerName })
        if (result.processed) console.info(`Multimodal job for ${result.itemId}: ${result.status}.`)
        else await sleep(pollMs)
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Multimodal worker iteration failed.')
        await sleep(pollMs)
      }
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runWorker().catch(error => { console.error(error.message); process.exitCode = 1 })
}
