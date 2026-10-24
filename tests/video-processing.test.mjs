import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { validateVideoUpload, deduplicateOcrFrames, parseTesseractTsv } from '../lib/video-validation.mjs'
import { extractOnScreenText, extractVideo, processOneVideo } from '../scripts/video-worker.mjs'

function ocrTsv(...words) {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
  return [header, ...words.map((word, index) => `5\t1\t1\t1\t1\t${index + 1}\t${index * 50}\t0\t45\t40\t96\t${word}`)].join('\n')
}

test('accepts supported upload types and rejects invalid types and oversized files', () => {
  assert.equal(validateVideoUpload({ filename: 'clip.mp4', mimeType: 'video/mp4', size: 100 }), '.mp4')
  assert.equal(validateVideoUpload({ filename: 'clip.mov', mimeType: 'video/quicktime', size: 100 }), '.mov')
  assert.throws(() => validateVideoUpload({ filename: 'clip.mkv', mimeType: 'video/x-matroska', size: 100 }), /MP4, MOV, or WebM/)
  assert.throws(() => validateVideoUpload({ filename: 'clip.mp4', mimeType: 'video/mp4', size: 101, maxBytes: 100 }), /smaller/)
})

test('OCR repeats are deduplicated after case and whitespace normalization', () => {
  const frames = [{ time: 0, text: '  Hello   World ' }, { time: 2, text: 'hello world' }, { time: 4, text: 'New slide' }]
  assert.deepEqual(deduplicateOcrFrames(frames), [{ time: 0, text: 'Hello World' }, { time: 4, text: 'New slide' }])
})

test('Tesseract TSV confidence filtering preserves legitimate short numbers and multilingual words', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t0\t0\t8\t28\t96\tI',
    '5\t1\t1\t1\t1\t2\t10\t0\t10\t28\t95\t7',
    '5\t1\t1\t1\t1\t3\t22\t0\t42\t28\t94\tcafé',
    '5\t1\t1\t1\t2\t1\t0\t30\t30\t10\t19\txqz',
    '5\t1\t1\t1\t3\t1\t0\t50\t30\t28\t91\tNS®',
    '5\t1\t1\t1\t4\t1\t0\t70\t10\t10\t96\t4',
  ].join('\n')
  const parsed = parseTesseractTsv(tsv, { minConfidence: 80, minWordHeight: 24 })
  assert.equal(parsed.acceptedText, 'I 7 café')
  assert.equal(parsed.words.find(word => word.text === 'xqz').rejectedReason, 'low_confidence')
  assert.equal(parsed.words.find(word => word.text === 'NS®').rejectedReason, 'mostly_non_text_characters')
  assert.equal(parsed.words.find(word => word.text === '4').rejectedReason, 'too_small')
})

test('near-identical OCR on adjacent frames deduplicates while later repeats keep their timestamp', () => {
  const frames = [
    { time: 2, text: 'THIS IS HOW YOU DIE' },
    { time: 4, text: 'This is how you die!' },
    { time: 20, text: 'THIS IS HOW YOU DIE' },
  ]
  assert.deepEqual(deduplicateOcrFrames(frames, { maxGapSeconds: 3 }), [frames[0], frames[2]])
})

test('OCR debug mode saves source frames, TSV confidence, accepted text, and private permissions', async () => {
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), 'recall-ocr-private-'))
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'recall-ocr-work-'))
  let samplingFilter = ''
  let tesseractArgs = []
  const mockRun = async (command, args) => {
    if (command === 'ffprobe') return { stdout: '8\n', stderr: '' }
    if (args.includes('-frames:v')) {
      const output = args.at(-2)
      if (path.basename(output).startsWith('frame-%')) samplingFilter = args[args.indexOf('-vf') + 1]
      if (path.basename(output).startsWith('frame-%')) await writeFile(path.join(workDir, 'frame-001.jpg'), 'debug-frame')
      else await writeFile(output, 'ocr-image')
    }
    if (command === 'tesseract') { tesseractArgs = args; return { stdout: ocrTsv('visible', 'text'), stderr: '' } }
    return { stdout: '', stderr: '' }
  }
  try {
    const result = await extractOnScreenText({ inputPath: '/fixture.mp4', workDir, env: { RECALL_MEDIA_DIR: mediaRoot, VIDEO_OCR_DEBUG: 'true', VIDEO_OCR_LANGUAGE: 'eng+fra' }, runCommand: mockRun, debug: true })
    const report = JSON.parse(await readFile(path.join(result.debugDirectory, 'ocr-report.json'), 'utf8'))
    assert.equal(report.frames[0].time, 0)
    assert.equal(report.frames[0].words[0].confidence, 96)
    assert.equal(report.frames[0].acceptedText, 'visible text')
    assert.equal(report.language, 'eng+fra')
    assert.match(samplingFilter, /fps=1\/2\.000,scale='min\(1440,iw\)':-2/)
    assert.ok(tesseractArgs.includes('-l') && tesseractArgs.includes('eng+fra'))
    assert.ok(tesseractArgs.includes('--psm') && tesseractArgs.includes('6'))
    assert.equal(await readFile(path.join(result.debugDirectory, 'frame-001.tsv'), 'utf8'), ocrTsv('visible', 'text'))
    assert.equal((await stat(result.debugDirectory)).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(result.debugDirectory, 'ocr-report.json'))).mode & 0o777, 0o600)
  } finally {
    await rm(mediaRoot, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  }
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
    if (command === 'ffprobe') return { stdout: '12\n', stderr: '' }
    if (args.includes('-frames:v')) {
      const outputPath = args.at(-2)
      if (path.basename(outputPath).startsWith('frame-%')) {
        await writeFile(path.join(workDir, 'frame-001.jpg'), 'frame-1')
        await writeFile(path.join(workDir, 'frame-002.jpg'), 'frame-2')
      } else await writeFile(outputPath, 'processed frame')
      return { stdout: '', stderr: '' }
    }
    if (command === 'tesseract') return { stdout: ocrTsv(args[0].includes('001') ? 'Ingredients:' : 'ingredients:', args[0].includes('001') ? 'tomato' : 'TOMATO'), stderr: '' }
    return { stdout: '', stderr: '' }
  }
  try {
    const result = await extractVideo({ inputPath: '/fixture.mp4', workDir, env: { VIDEO_TRANSCRIPTION_ENABLED: 'true', VIDEO_OCR_ENABLED: 'true', WHISPER_MODEL_PATH: '/fixture-model.bin', OLLAMA_VISION_MODEL: 'fixture-vision' }, runCommand: mockRun, describe: async () => 'A bowl of tomato soup' })
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
    } else if (command === 'ffprobe') return { stdout: '12\n', stderr: '' }
    else if (args.includes('-frames:v')) {
      const outputPath = args.at(-2)
      if (path.basename(outputPath).startsWith('frame-%')) await writeFile(path.join(workDir, 'frame-001.jpg'), 'frame')
      else await writeFile(outputPath, 'processed frame')
    }
    else if (command === 'tesseract') return { stdout: ocrTsv('Title', 'card'), stderr: '' }
    return { stdout: '', stderr: '' }
  }
  try {
    const result = await extractVideo({ inputPath: '/fixture.mp4', workDir, env: { VIDEO_TRANSCRIPTION_ENABLED: 'true', VIDEO_OCR_ENABLED: 'true', WHISPER_MODEL_PATH: '/fixture-model.bin', OLLAMA_VISION_MODEL: 'unavailable' }, runCommand: mockRun, describe: async () => { throw new Error('Ollama vision unavailable') } })
    assert.equal(result.status, 'partially_ready')
    assert.match(result.extractedText, /Speech remains available/)
    assert.match(result.error, /vision unavailable/)
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test('Whisper and Tesseract are skipped by default for direct multimodal indexing', async () => {
  const calls = []
  const result = await extractVideo({
    inputPath: '/private/video.mp4', workDir: '/tmp/recall-test',
    env: {},
    runCommand: async (...args) => { calls.push(args); throw new Error('should not invoke text extractors') },
  })
  assert.deepEqual(calls, [])
  assert.equal(result.transcriptSegments.length, 0)
  assert.equal(result.ocrFrames.length, 0)
  assert.match(result.error, /raw media remains available for multimodal indexing/i)
  assert.equal(result.status, 'partially_ready')
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
  const result = await processOneVideo({ client: queue, env: { RECALL_MEDIA_DIR: '/tmp/recall-no-such-media', VIDEO_TRANSCRIPTION_ENABLED: 'true', VIDEO_OCR_ENABLED: 'true', VIDEO_WORKER_POLL_MS: '1' } })
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
