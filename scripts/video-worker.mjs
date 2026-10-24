import os from 'node:os'
import path from 'node:path'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import nextEnv from '@next/env'
import { createClient } from '@supabase/supabase-js'
import { deduplicateOcrFrames, parseTesseractTsv } from '../lib/video-validation.mjs'

const { loadEnvConfig } = nextEnv
class FrameExtractionError extends Error {}

function safeError(error) {
  return String(error instanceof Error ? error.message : 'Video processing failed.')
    .replace(/(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 1000)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) child.kill() })
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 1_000_000) child.kill() })
    child.on('error', error => reject(new Error(`${command} is unavailable. ${error.message}`)))
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed (${code}): ${stderr.slice(-1000)}`)))
  })
}

function timeSeconds(value) {
  if (typeof value === 'number') return value
  const match = String(value || '').match(/(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)/)
  return match ? Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0
}

async function describeFrame(imagePath) {
  const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '')
  const response = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OLLAMA_VISION_MODEL, prompt: 'Briefly describe the visible scene. Do not infer facts that are not visible.', images: [(await readFile(imagePath)).toString('base64')], stream: false }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new Error(`Ollama vision model unavailable (HTTP ${response.status}).`)
  const result = await response.json()
  return String(result.response || '').trim()
}

async function transcribeVisibleText(imagePath, env = process.env) {
  const base = (env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '')
  const response = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OLLAMA_VISION_MODEL, prompt: 'Transcribe only text that is visibly present in this frame. Preserve the exact spelling, capitalization, numbers, and punctuation. Do not infer, correct, translate, or describe the scene. If a region cannot be read, write [unreadable]. Return only the visible text.', images: [(await readFile(imagePath)).toString('base64')], stream: false }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new Error(`Ollama vision model unavailable (HTTP ${response.status}).`)
  return String((await response.json()).response || '').trim()
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

async function videoDurationSeconds(inputPath, ffprobe, runCommand) {
  try {
    const { stdout } = await runCommand(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath])
    const duration = Number(stdout.trim())
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  } catch { return 0 }
}

export async function transcribeAudioTrack({ inputPath, workDir, audioAvailable = true, enabled = process.env.VIDEO_TRANSCRIPTION_ENABLED === 'true', env = process.env, runCommand = run }) {
  if (!audioAvailable) return { segments: [], status: 'no_audio', warning: 'The video has no audio stream.' }
  if (!enabled) return { segments: [], status: 'disabled', warning: 'Speech transcription is disabled.' }
  const model = env.WHISPER_MODEL_PATH
  if (!model) return { segments: [], status: 'unavailable', warning: 'Set WHISPER_MODEL_PATH to enable speech transcription.' }

  const ffmpeg = env.FFMPEG_BIN || 'ffmpeg'
  const whisper = env.WHISPER_CPP_BIN || 'whisper-cli'
  const audioPath = path.join(workDir, 'audio.wav')
  try {
    await runCommand(ffmpeg, ['-v', 'error', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath, '-y'])
    const transcriptPrefix = path.join(workDir, 'transcript')
    const whisperArgs = env.WHISPER_USE_GPU === 'true' ? [] : ['-ng']
    await runCommand(whisper, [...whisperArgs, '-m', model, '-f', audioPath, '-oj', '-of', transcriptPrefix, '-l', env.WHISPER_LANGUAGE || 'auto', '--no-prints'])
    const whisperJson = JSON.parse(await readFile(`${transcriptPrefix}.json`, 'utf8'))
    const segments = (whisperJson.transcription || whisperJson.segments || []).map(segment => ({
      start: timeSeconds(segment.timestamps?.from ?? segment.start),
      end: timeSeconds(segment.timestamps?.to ?? segment.end),
      text: String(segment.text || '').trim(),
    })).filter(segment => segment.text)
    return { segments, status: segments.length ? 'transcribed' : 'no_speech', warning: '' }
  } catch (error) {
    return { segments: [], status: 'failed', warning: safeError(error) }
  }
}

async function makePrivateDebugDirectory(env) {
  const mediaRoot = path.resolve(env.RECALL_MEDIA_DIR || '.local-media')
  const debugRoot = path.join(mediaRoot, 'ocr-debug')
  await mkdir(debugRoot, { recursive: true, mode: 0o700 })
  await chmod(debugRoot, 0o700)
  const debugDirectory = path.join(debugRoot, randomUUID())
  await mkdir(debugDirectory, { mode: 0o700 })
  return debugDirectory
}

export async function extractOnScreenText({ inputPath, workDir, env = process.env, runCommand = run, debug = env.VIDEO_OCR_DEBUG === 'true' }) {
  const ffmpeg = env.FFMPEG_BIN || 'ffmpeg'
  const ffprobe = env.FFPROBE_BIN || 'ffprobe'
  const tesseract = env.TESSERACT_BIN || 'tesseract'
  const language = env.VIDEO_OCR_LANGUAGE || 'eng'
  if (!/^[A-Za-z0-9_+.-]+$/.test(language)) throw new Error('VIDEO_OCR_LANGUAGE contains unsupported characters.')
  const psm = String(Math.floor(boundedNumber(env.VIDEO_OCR_PSM, 6, 0, 13)))
  const minimumConfidence = boundedNumber(env.VIDEO_OCR_MIN_CONFIDENCE, 90, 0, 100)
  const minimumWordHeight = boundedNumber(env.VIDEO_OCR_MIN_WORD_HEIGHT, 24, 0, 200)
  const requestedInterval = boundedNumber(env.VIDEO_FRAME_INTERVAL_SECONDS, 2, 0.5, 30)
  const maxFrames = Math.floor(boundedNumber(env.VIDEO_MAX_FRAMES, 60, 1, 60))
  const durationSeconds = await videoDurationSeconds(inputPath, ffprobe, runCommand)
  const intervalSeconds = durationSeconds ? Math.max(requestedInterval, durationSeconds / maxFrames) : requestedInterval
  const framePattern = path.join(workDir, 'frame-%03d.jpg')
  const frameFilter = `fps=1/${intervalSeconds.toFixed(3)},scale='min(1440,iw)':-2`
  try { await runCommand(ffmpeg, ['-v', 'error', '-i', inputPath, '-vf', frameFilter, '-frames:v', String(maxFrames), '-q:v', '2', framePattern, '-y']) }
  catch (error) { throw new FrameExtractionError(`FFmpeg could not extract video frames: ${safeError(error)}`) }
  const names = (await readdir(workDir)).filter(name => /^frame-\d+\.jpg$/.test(name)).sort().slice(0, maxFrames)
  const debugDirectory = debug ? await makePrivateDebugDirectory(env) : null
  const frames = []
  const diagnosticFrames = []
  const seenFrameHashes = new Set()
  for (const name of names) {
    const frameNumber = Number(name.match(/\d+/)?.[0] || 1)
    const time = Math.max(0, (frameNumber - 1) * intervalSeconds)
    const framePath = path.join(workDir, name)
    const frameBytes = await readFile(framePath)
    const frameHash = createHash('sha256').update(frameBytes).digest('hex')
    if (debugDirectory) {
      await copyFile(framePath, path.join(debugDirectory, name))
      await chmod(path.join(debugDirectory, name), 0o600)
    }
    if (seenFrameHashes.has(frameHash)) {
      diagnosticFrames.push({ time, frame: name, skipped: 'identical_frame' })
      continue
    }
    seenFrameHashes.add(frameHash)
    const ocrImageName = `ocr-${name}`
    const ocrImagePath = path.join(workDir, ocrImageName)
    await runCommand(ffmpeg, ['-v', 'error', '-i', framePath, '-vf', 'scale=2*iw:2*ih:flags=lanczos,format=gray,eq=contrast=1.25:brightness=0.01', '-frames:v', '1', '-q:v', '2', ocrImagePath, '-y'])
    const { stdout: rawTsv } = await runCommand(tesseract, [ocrImagePath, 'stdout', '-l', language, '--psm', psm, 'tsv'])
    const parsed = parseTesseractTsv(rawTsv, { minConfidence: minimumConfidence, minWordHeight: minimumWordHeight })
    diagnosticFrames.push({ time, frame: name, ocrImage: ocrImageName, rawTsv, words: parsed.words, acceptedText: parsed.acceptedText })
    if (debugDirectory) {
      await copyFile(ocrImagePath, path.join(debugDirectory, ocrImageName))
      await chmod(path.join(debugDirectory, ocrImageName), 0o600)
      await writeFile(path.join(debugDirectory, `${name.slice(0, -4)}.tsv`), rawTsv, { mode: 0o600 })
    }
    if (parsed.acceptedText) frames.push({ time, text: parsed.acceptedText, meanConfidence: parsed.words.filter(word => word.accepted).reduce((sum, word) => sum + word.confidence, 0) / parsed.words.filter(word => word.accepted).length })
  }
  const uniqueFrames = deduplicateOcrFrames(frames, { maxGapSeconds: Math.max(4, intervalSeconds * 4) })
  if (debugDirectory) {
    await writeFile(path.join(debugDirectory, 'ocr-report.json'), JSON.stringify({
      createdAt: new Date().toISOString(), durationSeconds, requestedIntervalSeconds: requestedInterval,
      effectiveIntervalSeconds: intervalSeconds, frameCount: names.length, language, psm: Number(psm), minimumConfidence, minimumWordHeight,
      preprocessing: 'source frame up to 1440px wide; OCR copy enlarged 2x with Lanczos, grayscale, contrast 1.25',
      frames: diagnosticFrames, acceptedFrames: uniqueFrames,
    }, null, 2), { mode: 0o600 })
  }
  return { frames: uniqueFrames, sampledFrameNames: names, intervalSeconds, debugDirectory }
}

export async function extractVideo({ inputPath, workDir, env = process.env, runCommand = run, describe = describeFrame }) {
  const ffmpeg = env.FFMPEG_BIN || 'ffmpeg'
  const transcriptionEnabled = env.VIDEO_TRANSCRIPTION_ENABLED === 'true'
  const ocrEnabled = env.VIDEO_OCR_ENABLED === 'true'
  const warnings = []
  const transcriptResult = await transcribeAudioTrack({ inputPath, workDir, enabled: transcriptionEnabled, env, runCommand })
  const transcriptSegments = transcriptResult.segments
  if (transcriptionEnabled && transcriptResult.warning) warnings.push(transcriptResult.warning)

  let ocrResult = { frames: [], sampledFrameNames: [], intervalSeconds: 2 }
  try {
    if (ocrEnabled) ocrResult = await extractOnScreenText({ inputPath, workDir, env, runCommand })
  }
  catch (error) {
    if (error instanceof FrameExtractionError) throw error
    warnings.push(`OCR unavailable: ${safeError(error)}`)
  }
  const uniqueOcr = ocrResult.frames
  let visualDescriptions = []
  let visionError = ''
  if (ocrEnabled && env.OLLAMA_VISION_MODEL) {
    for (const name of ocrResult.sampledFrameNames.slice(0, Number(env.VIDEO_MAX_VISION_FRAMES || 8))) {
      try {
        const description = await describe(path.join(workDir, name))
        if (description) visualDescriptions.push({ time: Math.max(0, (Number(name.match(/\d+/)?.[0] || 1) - 1) * ocrResult.intervalSeconds), text: description })
      } catch (error) { visionError = safeError(error); break }
    }
  }
  const visionOcrFrames = []
  if (ocrEnabled && env.OLLAMA_VISION_MODEL && env.VIDEO_OCR_VISION_VERIFY === 'true') {
    for (const name of ocrResult.sampledFrameNames.slice(0, Number(env.VIDEO_MAX_OCR_VISION_FRAMES || 8))) {
      try {
        const text = await transcribeVisibleText(path.join(workDir, name), env)
        if (text && !/^\[unreadable\]$/i.test(text)) visionOcrFrames.push({ time: Math.max(0, (Number(name.match(/\d+/)?.[0] || 1) - 1) * ocrResult.intervalSeconds), text, source: 'vision' })
      } catch (error) { visionError = safeError(error); break }
    }
  }
  if (ocrResult.debugDirectory && visionOcrFrames.length) {
    const reportPath = path.join(ocrResult.debugDirectory, 'ocr-report.json')
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    report.visionVerifiedFrames = visionOcrFrames
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
  }
  const searchableOcr = deduplicateOcrFrames([...uniqueOcr, ...visionOcrFrames].sort((a, b) => a.time - b.time), { maxGapSeconds: Math.max(4, ocrResult.intervalSeconds * 4) })
  const extractedText = [
    transcriptSegments.map(segment => `[${segment.start.toFixed(1)}s] ${segment.text}`).join('\n'),
    searchableOcr.map(frame => `[${frame.time.toFixed(1)}s screen text] ${frame.text}`).join('\n'),
    visualDescriptions.map(frame => `[${frame.time.toFixed(1)}s visual] ${frame.text}`).join('\n'),
  ].filter(Boolean).join('\n').slice(0, 60_000)
  const hasCoreContent = transcriptSegments.length || searchableOcr.length || visualDescriptions.length
  const noExtractedContent = !hasCoreContent
    ? (!transcriptionEnabled && !ocrEnabled
      ? 'Whisper and OCR are disabled; raw media remains available for multimodal indexing.'
      : 'No speech or on-screen text was detected.')
    : ''
  const error = [warnings.join(' '), visionError, noExtractedContent].filter(Boolean).join(' ').slice(0, 1000)
  const status = error ? 'partially_ready' : 'ready'
  return { transcriptSegments, ocrFrames: searchableOcr, visualDescriptions, extractedText, status, error: error || null }
}

export async function processOneVideo({ client, workerName = `${os.hostname()}-${process.pid}`, env = process.env }) {
  const { data: jobs, error: claimError } = await client.rpc('claim_video_processing_job', { worker_name: workerName })
  if (claimError) throw new Error(`Could not claim video job: ${claimError.message}`)
  const job = jobs?.[0]
  if (!job) return { processed: false }
  let result
  try {
    const root = path.resolve(env.RECALL_MEDIA_DIR || '.local-media')
    const inputPath = path.join(root, job.storage_key)
    if (path.dirname(inputPath) !== root) throw new Error('Invalid media storage key.')
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'recall-video-'))
    try { result = await extractVideo({ inputPath, workDir, env }) } finally { await rm(workDir, { recursive: true, force: true }) }
    const { data: done, error } = await client.rpc('complete_video_processing_job', {
      target_job_id: job.job_id, target_claim_token: job.claim_token, target_media_version: job.media_version,
      target_transcript: result.transcriptSegments, target_ocr: result.ocrFrames,
      target_visual: result.visualDescriptions, target_extracted_text: result.extractedText,
      target_status: result.status, target_error: result.error,
    })
    if (error) throw new Error(`Could not save extracted video content: ${error.message}`)
    return { processed: true, status: done ? result.status : 'superseded', itemId: job.item_id }
  } catch (error) {
    const { data: status, error: failError } = await client.rpc('fail_video_processing_job', {
      target_job_id: job.job_id, target_claim_token: job.claim_token, safe_error: safeError(error),
    })
    if (failError) throw new Error(`Could not record video failure: ${failError.message}`)
    return { processed: true, status: status || 'retrying', itemId: job.item_id }
  }
}

async function runOcrDiagnostic(storageFilename) {
  loadEnvConfig(process.cwd())
  if (!/^[0-9a-f-]{36}\.(mp4|mov|webm)$/i.test(storageFilename || '')) {
    throw new Error('Pass one generated media filename from the private local media directory.')
  }
  const mediaRoot = await realpath(path.resolve(process.env.RECALL_MEDIA_DIR || '.local-media'))
  const inputPath = await realpath(path.join(mediaRoot, storageFilename))
  if (path.dirname(inputPath) !== mediaRoot) throw new Error('The diagnostic video must remain inside private media storage.')
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'recall-ocr-diagnostic-'))
  try {
    const result = await extractOnScreenText({ inputPath, workDir, env: { ...process.env, VIDEO_OCR_DEBUG: 'true' }, debug: true })
    console.info(`OCR diagnostic complete: sampled=${result.sampledFrameNames.length}; accepted=${result.frames.length}; intervalSeconds=${result.intervalSeconds}.`)
    console.info(`Private OCR report and selected frames saved: ${result.debugDirectory}`)
  } finally { await rm(workDir, { recursive: true, force: true }) }
}

export async function runVideoWorker() {
  loadEnvConfig(process.cwd())
  const pollMs = Math.max(250, Math.min(30_000, Number(process.env.VIDEO_WORKER_POLL_MS || 2000)))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Set Supabase URL and server-only service-role key before starting the video worker.')
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const workerName = process.env.VIDEO_WORKER_ID || `${os.hostname()}-${process.pid}`
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  const textExtraction = process.env.VIDEO_TRANSCRIPTION_ENABLED === 'true' || process.env.VIDEO_OCR_ENABLED === 'true'
  console.info(`Recall video worker ${workerName}: FFmpeg${textExtraction ? ` + optional text extraction${process.env.OLLAMA_VISION_MODEL ? ` + Ollama ${process.env.OLLAMA_VISION_MODEL}` : ''}` : ' (Whisper/Tesseract disabled; multimodal index handles search)'}.`)
  try {
    while (!stopping) {
      try {
        const result = await processOneVideo({ client, workerName })
        if (result.processed) console.info(`Video job for ${result.itemId}: ${result.status}.`)
        else await sleep(pollMs)
      } catch (error) { console.error(error instanceof Error ? error.message : 'Video worker failed.'); await sleep(pollMs) }
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
  console.info('Recall video worker stopped.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--diagnose-ocr') await runOcrDiagnostic(process.argv[3])
  else await runVideoWorker()
}
