import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import nextEnv from '@next/env'
import { createClient } from '@supabase/supabase-js'
import {
  createEmbedding,
  getEmbeddingModel,
  savedItemEmbeddingText,
  vectorLiteral,
} from '../lib/embedding-provider.mjs'

const { loadEnvConfig } = nextEnv

const POLL_INTERVAL_MS = Number(process.env.EMBEDDING_WORKER_POLL_MS || 1500)

function safeError(error) {
  const message = error instanceof Error ? error.message : 'Embedding generation failed.'
  return message
    .replace(/(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted token]')
    .slice(0, 1000)
}

export async function processOne({ client, embed = createEmbedding, workerName = `${os.hostname()}-${process.pid}` }) {
  const { data: claimed, error: claimError } = await client.rpc('claim_embedding_job', { worker_name: workerName })
  if (claimError) throw new Error(`Could not claim embedding job: ${claimError.message}`)
  const job = claimed?.[0]
  if (!job) return { processed: false }

  try {
    // Fetch the current row so extracted video content is included. The
    // version check in complete_embedding_job rejects edits made meanwhile.
    const { data: item, error: itemError } = await client.from('saved_items')
      .select('title,notes,tags,extracted_text,embedding_content_version')
      .eq('id', job.item_id)
      .single()
    if (itemError || !item) throw new Error('Could not load saved item text for embedding.')
    if (item.embedding_content_version !== job.content_version) {
      return { processed: true, status: 'superseded', itemId: job.item_id }
    }
    const text = savedItemEmbeddingText(item)
    const vector = await embed(text, 'document')
    const { data: completed, error: completeError } = await client.rpc('complete_embedding_job', {
      target_job_id: job.job_id,
      target_claim_token: job.claim_token,
      target_content_version: job.content_version,
      item_embedding: vectorLiteral(vector),
      model_name: getEmbeddingModel(),
    })
    if (completeError) throw new Error(`Could not store the completed embedding: ${completeError.message}`)
    return { processed: true, status: completed ? 'ready' : 'superseded', itemId: job.item_id }
  } catch (error) {
    const { data: status, error: failError } = await client.rpc('fail_embedding_job', {
      target_job_id: job.job_id,
      target_claim_token: job.claim_token,
      target_content_version: job.content_version,
      safe_error: safeError(error),
    })
    if (failError) throw new Error(`Could not record embedding failure: ${failError.message}`)
    return { processed: true, status: status ?? 'retrying', itemId: job.item_id }
  }
}

export async function runWorker() {
  loadEnvConfig(process.cwd())
  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and server-only SUPABASE_SERVICE_ROLE_KEY before starting the embedding worker.')
  }
  const workerName = process.env.EMBEDDING_WORKER_ID || `${os.hostname()}-${process.pid}`
  const pollInterval = Number(process.env.EMBEDDING_WORKER_POLL_MS || POLL_INTERVAL_MS)
  const client = createClient(serviceUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  console.info(`Recall embedding worker ${workerName} using ${process.env.EMBEDDING_PROVIDER || 'ollama'} / ${getEmbeddingModel()}.`)
  try {
    while (!stopping) {
      try {
        const result = await processOne({ client, workerName })
        if (result.processed) {
          console.info(`Embedding job for ${result.itemId}: ${result.status}.`)
        } else {
          await sleep(pollInterval)
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Worker iteration failed.')
        await sleep(pollInterval)
      }
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  console.info('Recall embedding worker stopped.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runWorker()
}
