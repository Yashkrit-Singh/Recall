import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import nextEnv from '@next/env'
import { createClient } from '@supabase/supabase-js'
import { deduplicateOcrFrames } from '../lib/video-validation.mjs'

const { loadEnvConfig } = nextEnv
const pollMs = Number(process.env.VIDEO_WORKER_POLL_MS || 2000)

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
    body: JSON.stringify({ model: process.env.OLLAMA_VISION_MODEL, prompt: 'Briefly describe the visible scene and useful on-screen information. Do not guess unseen context.', images: [(await readFile(imagePath)).toString('base64')], stream: false }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new Error(`Ollama vision model unavailable (HTTP ${response.status}).`)
  const result = await response.json()
  return String(result.response || '').trim()
}

export async function extractVideo({ inputPath, workDir, env = process.env, runCommand = run, describe = describeFrame }) {
  const ffmpeg = env.FFMPEG_BIN || 'ffmpeg'
  const whisper = env.WHISPER_CPP_BIN || 'whisper-cli'
  const model = env.WHISPER_MODEL_PATH
  const warnings = []
  const audioPath = path.join(workDir, 'audio.wav')
  let audioExtracted = false
  try {
    await runCommand(ffmpeg, ['-v', 'error', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath, '-y'])
    audioExtracted = true
  } catch (error) { warnings.push(`Audio extraction unavailable: ${safeError(error)}`) }
  let transcriptSegments = []
  if (!model) warnings.push('Set WHISPER_MODEL_PATH to enable speech transcription.')
  else if (audioExtracted) {
    try {
      const transcriptPrefix = path.join(workDir, 'transcript')
      const whisperArgs = env.WHISPER_USE_GPU === 'true' ? [] : ['-ng']
      await runCommand(whisper, [...whisperArgs, '-m', model, '-f', audioPath, '-oj', '-of', transcriptPrefix, '-l', env.WHISPER_LANGUAGE || 'auto', '--no-prints'])
      const whisperJson = JSON.parse(await readFile(`${transcriptPrefix}.json`, 'utf8'))
      transcriptSegments = (whisperJson.transcription || whisperJson.segments || []).map(segment => ({
        start: timeSeconds(segment.timestamps?.from ?? segment.start),
        end: timeSeconds(segment.timestamps?.to ?? segment.end),
        text: String(segment.text || '').trim(),
      })).filter(segment => segment.text)
    } catch (error) { warnings.push(safeError(error)) }
  }

  const interval = Math.max(2, Number(env.VIDEO_FRAME_INTERVAL_SECONDS || 10))
  const maxFrames = Math.max(1, Math.min(60, Number(env.VIDEO_MAX_FRAMES || 30)))
  const framePattern = path.join(workDir, 'frame-%03d.jpg')
  await runCommand(ffmpeg, ['-v', 'error', '-i', inputPath, '-vf', `fps=1/${interval},scale='min(960,iw)':-2`, '-frames:v', String(maxFrames), '-q:v', '4', framePattern, '-y'])
  const names = (await readdir(workDir)).filter(name => /^frame-\d+\.jpg$/.test(name)).sort().slice(0, maxFrames)
  const ocrFrames = []
  for (const name of names) {
    const frameNumber = Number(name.match(/\d+/)?.[0] || 1)
    try {
      const { stdout } = await runCommand(env.TESSERACT_BIN || 'tesseract', [path.join(workDir, name), 'stdout', '--psm', '6'])
      ocrFrames.push({ time: Math.max(0, (frameNumber - 1) * interval), text: stdout.trim() })
    } catch (error) { warnings.push(`OCR unavailable: ${safeError(error)}`); break }
  }
  const uniqueOcr = deduplicateOcrFrames(ocrFrames)
  let visualDescriptions = []
  let visionError = ''
  if (env.OLLAMA_VISION_MODEL) {
    for (const name of names.slice(0, Number(env.VIDEO_MAX_VISION_FRAMES || 8))) {
      try {
        const description = await describe(path.join(workDir, name))
        if (description) visualDescriptions.push({ time: Math.max(0, (Number(name.match(/\d+/)?.[0] || 1) - 1) * interval), text: description })
      } catch (error) { visionError = safeError(error); break }
    }
  }
  const extractedText = [
    transcriptSegments.map(segment => `[${segment.start.toFixed(1)}s] ${segment.text}`).join('\n'),
    uniqueOcr.map(frame => `[${frame.time.toFixed(1)}s screen text] ${frame.text}`).join('\n'),
    visualDescriptions.map(frame => `[${frame.time.toFixed(1)}s visual] ${frame.text}`).join('\n'),
  ].filter(Boolean).join('\n').slice(0, 60_000)
  const hasCoreContent = transcriptSegments.length || uniqueOcr.length
  const error = [warnings.join(' '), visionError, !hasCoreContent ? 'No speech or on-screen text was detected.' : ''].filter(Boolean).join(' ').slice(0, 1000)
  const status = error ? 'partially_ready' : 'ready'
  return { transcriptSegments, ocrFrames: uniqueOcr, visualDescriptions, extractedText, status, error: error || null }
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

export async function runVideoWorker() {
  loadEnvConfig(process.cwd())
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Set Supabase URL and server-only service-role key before starting the video worker.')
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const workerName = process.env.VIDEO_WORKER_ID || `${os.hostname()}-${process.pid}`
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  console.info(`Recall video worker ${workerName}: FFmpeg + whisper.cpp + Tesseract${process.env.OLLAMA_VISION_MODEL ? ` + Ollama ${process.env.OLLAMA_VISION_MODEL}` : ''}.`)
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runVideoWorker()
