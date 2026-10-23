import test from 'node:test'
import assert from 'node:assert/strict'
import { processOne } from '../scripts/embedding-worker.mjs'

class QueueDouble {
  constructor() {
    this.version = 4
    this.job = {
      job_id: 'job-1',
      item_id: 'item-1',
      content_version: 4,
      claim_token: null,
      title: 'A useful reel',
      notes: 'A trip with friends',
      tags: ['travel', 'music'],
      status: 'queued',
      attempts: 0,
      max_attempts: 5,
    }
    this.embedding = null
    this.lastError = null
  }

  from() {
    return {
      select: () => ({
        eq: () => ({ single: async () => ({ data: {
          title: this.job.title,
          notes: this.job.notes,
          tags: this.job.tags,
          extracted_text: this.extractedText ?? '',
          embedding_content_version: this.version,
        }, error: null }) }),
      }),
    }
  }

  async rpc(name, args) {
    if (name === 'claim_embedding_job') {
      if (this.job.status !== 'queued') return { data: [], error: null }
      this.job.status = 'processing'
      this.job.attempts += 1
      this.job.claim_token = `token-${this.job.attempts}`
      return { data: [{ ...this.job }], error: null }
    }
    if (name === 'complete_embedding_job') {
      if (this.job.claim_token !== args.target_claim_token || this.version !== args.target_content_version) {
        this.job.status = 'superseded'
        return { data: false, error: null }
      }
      this.embedding = args.item_embedding
      this.job.status = 'succeeded'
      return { data: true, error: null }
    }
    if (name === 'fail_embedding_job') {
      this.lastError = args.safe_error
      this.job.status = this.job.attempts >= this.job.max_attempts ? 'failed' : 'queued'
      return { data: this.job.status === 'failed' ? 'failed' : 'retrying', error: null }
    }
    throw new Error(`Unexpected RPC: ${name}`)
  }
}

test('successful job stores an embedding generated from title, notes, and tags', async () => {
  const queue = new QueueDouble()
  let textSentToEmbedder = ''
  const result = await processOne({
    client: queue,
    workerName: 'test-worker',
    embed: async text => {
      textSentToEmbedder = text
      return Array(768).fill(0.125)
    },
  })
  assert.equal(result.status, 'ready')
  assert.match(textSentToEmbedder, /A useful reel/)
  assert.match(textSentToEmbedder, /A trip with friends/)
  assert.match(textSentToEmbedder, /travel, music/)
  assert.equal(queue.job.status, 'succeeded')
  assert.match(queue.embedding, /^\[0\.125,/)
})

test('embedding input includes extracted video content from the current saved row', async () => {
  const queue = new QueueDouble()
  queue.extractedText = '[12.0s] A chef explains a tomato soup recipe'
  let textSentToEmbedder = ''
  const result = await processOne({ client: queue, embed: async text => {
    textSentToEmbedder = text
    return Array(768).fill(0.2)
  } })
  assert.equal(result.status, 'ready')
  assert.match(textSentToEmbedder, /tomato soup recipe/)
})

test('an unavailable Ollama endpoint records a retry and keeps the item pending', async () => {
  const queue = new QueueDouble()
  const result = await processOne({
    client: queue,
    embed: async () => { throw new Error('Could not reach Ollama at http://localhost:11434.') },
  })
  assert.equal(result.status, 'retrying')
  assert.equal(queue.job.status, 'queued')
  assert.match(queue.lastError, /Could not reach Ollama/)
})

test('a transient Ollama failure is automatically retried and can then succeed', async () => {
  const queue = new QueueDouble()
  let calls = 0
  const embed = async () => {
    calls += 1
    if (calls === 1) throw new Error('Ollama is starting.')
    return Array(768).fill(0.75)
  }
  assert.equal((await processOne({ client: queue, embed })).status, 'retrying')
  assert.equal((await processOne({ client: queue, embed })).status, 'ready')
  assert.equal(calls, 2)
  assert.equal(queue.job.status, 'succeeded')
})

test('duplicate workers cannot claim the same active job', async () => {
  const queue = new QueueDouble()
  let embeds = 0
  const embed = async () => {
    embeds += 1
    await new Promise(resolve => setTimeout(resolve, 15))
    return Array(768).fill(0.25)
  }
  const results = await Promise.all([
    processOne({ client: queue, workerName: 'worker-a', embed }),
    processOne({ client: queue, workerName: 'worker-b', embed }),
  ])
  assert.equal(results.filter(result => result.processed).length, 1)
  assert.equal(embeds, 1)
})

test('a concurrent edit makes the old job stale and prevents its embedding write', async () => {
  const queue = new QueueDouble()
  const result = await processOne({
    client: queue,
    embed: async () => {
      queue.version += 1
      return Array(768).fill(0.5)
    },
  })
  assert.equal(result.status, 'superseded')
  assert.equal(queue.embedding, null)
})
