import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { validateVideoUpload, deduplicateOcrFrames } from '../lib/video-validation.mjs'
import { extractVideo, processOneVideo } from '../scripts/video-worker.mjs'

test('accepts supported upload types and rejects invalid types and oversized files', () => {
  assert.equal(validateVideoUpload({ filename: 'clip.mp4', mimeType: 'video/mp4', size: 100 }), '.mp4')
  assert.equal(validateVideoUpload({ filename: 'clip.mov', mimeType: 'video/quicktime', size: 100 }), '.mov')
  assert.throws(() => validateVideoUpload({ filename: 'clip.mkv', mimeType: 'video/x-matroska', size: 100 }), /MP4, MOV, or WebM/)
  assert.throws(() => validateVideoUpload({ filename: 'clip.mp4', mimeType: 'video/mp4', size: 101, maxBytes: 100 }), /smaller/)
})

test('OCR repeats are deduplicated after case and whitespace normalization', () => {
  const frames = [{ time: 0, text: '  Hello   World ' }, { time: 10, text: 'hello world' }, { time: 20, text: 'New slide' }]
  assert.deepEqual(deduplicateOcrFrames(frames), [{ time: 0, text: 'hello world' }, { time: 20, text: 'new slide' }])
})

test('local extraction keeps transcript timestamps, OCR, and optional visual descriptions searchable', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'recall-test-'))
  const mockRun = async (command, args) => {
    if (command === 'whisper-cli') {
      await writeFile(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: [
        { timestamps: { from: '00:00:01.200', to: '00:00:02.500' }, text: '  A recipe for tomato soup ' },
      ] }))
      return { stdout: '', stderr: '' }
    }
    if (args.includes('-frames:v')) {
      await writeFile(path.join(workDir, 'frame-001.jpg'), 'frame')
      await writeFile(path.join(workDir, 'frame-002.jpg'), 'frame')
      return { stdout: '', stderr: '' }
    }
    if (command === 'tesseract') return { stdout: args[0].includes('001') ? 'Ingredients: tomato' : ' ingredients:   TOMATO ', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  try {
    const result = await extractVideo({ inputPath: '/fixture.mp4', workDir, env: { WHISPER_MODEL_PATH: '/fixture-model.bin', OLLAMA_VISION_MODEL: 'fixture-vision' }, runCommand: mockRun, describe: async () => 'A bowl of tomato soup' })
    assert.equal(result.status, 'ready')
    assert.equal(result.transcriptSegments[0].start, 1.2)
    assert.equal(result.ocrFrames.length, 1)
    assert.equal(result.visualDescriptions[0].text, 'A bowl of tomato soup')
    assert.match(result.extractedText, /\[1\.2s\] A recipe for tomato soup/)
    assert.match(result.extractedText, /Ingredients: tomato|ingredients: tomato/)
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test('unavailable optional vision keeps extracted text and reports partial readiness', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'recall-test-'))
  const mockRun = async (command, args) => {
    if (command === 'whisper-cli') {
      await writeFile(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({ transcription: [{ timestamps: { from: '00:00:00.000', to: '00:00:01.000' }, text: 'Speech remains available' }] }))
    } else if (args.includes('-frames:v')) await writeFile(path.join(workDir, 'frame-001.jpg'), 'frame')
    else if (command === 'tesseract') return { stdout: 'Title card', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  try {
    const result = await extractVideo({ inputPath: '/fixture.mp4', workDir, env: { WHISPER_MODEL_PATH: '/fixture-model.bin', OLLAMA_VISION_MODEL: 'unavailable' }, runCommand: mockRun, describe: async () => { throw new Error('Ollama vision unavailable') } })
    assert.equal(result.status, 'partially_ready')
    assert.match(result.extractedText, /Speech remains available/)
    assert.match(result.error, /vision unavailable/)
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

class VideoQueueDouble {
  constructor() {
    this.job = { job_id: 'video-job-1', item_id: 'item-1', media_version: 1, storage_key: 'a'.repeat(36) + '.mp4', claim_token: 'token', attempts: 1 }
    this.status = 'queued'
    this.lastError = ''
  }
  async rpc(name, args) {
    if (name === 'claim_video_processing_job') {
      if (this.status !== 'queued') return { data: [], error: null }
      this.status = 'processing'; return { data: [this.job], error: null }
    }
    if (name === 'fail_video_processing_job') { this.status = 'queued'; this.lastError = args.safe_error; return { data: 'retrying', error: null } }
    if (name === 'complete_video_processing_job') { this.status = 'succeeded'; return { data: true, error: null } }
    throw new Error(`Unexpected RPC ${name}`)
  }
}

test('missing local transcription configuration records a durable retry instead of losing the job', async () => {
  const queue = new VideoQueueDouble()
  const result = await processOneVideo({ client: queue, env: { RECALL_MEDIA_DIR: '/tmp/recall-no-such-media', VIDEO_WORKER_POLL_MS: '1' } })
  assert.equal(result.status, 'retrying')
  assert.equal(queue.status, 'queued')
  // On machines with FFmpeg installed, the missing fixture file reaches FFmpeg
  // and produces a process failure instead of a missing-executable error.
  assert.match(queue.lastError, /ffmpeg (is unavailable|failed)/)
})

test('worker claiming prevents duplicate processing of the same job', async () => {
  const queue = new VideoQueueDouble()
  const [one, two] = await Promise.all([
    processOneVideo({ client: queue, env: { RECALL_MEDIA_DIR: '/tmp/a' } }),
    processOneVideo({ client: queue, env: { RECALL_MEDIA_DIR: '/tmp/a' } }),
  ])
  assert.equal([one, two].filter(result => result.processed).length, 1)
})
