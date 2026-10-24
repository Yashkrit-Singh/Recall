import os from 'node:os'
import path from 'node:path'
import { access, copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import nextEnv from '@next/env'
import { createClient } from '@supabase/supabase-js'
import { canonicalizeInstagramReelUrl, classifyYtDlpFailure, createMediaRetrievalProvider, createStorageKey, createYtDlpChildEnvironment, generatedMediaPath, retrieveMediaFile, RetrievalError, runProcess, sanitizeYtDlpDiagnostic, ytdlpArguments, ytDlpArgumentNames } from '../lib/media-retrieval.mjs'

const { loadEnvConfig } = nextEnv
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function safeError(error) {
  const message = error instanceof RetrievalError ? error.message : 'Media retrieval failed due to a local worker error.'
  return message.replace(/https?:\/\/\S+/gi, '[source URL]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1000)
}

function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'recall-retrieval-'))
}

async function resolveExecutable(command, pathValue = process.env.PATH || '') {
  const candidates = path.isAbsolute(command) || command.includes(path.sep)
    ? [path.resolve(command)]
    : pathValue.split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch { /* Continue searching PATH. */ }
  }
  throw new Error(`Configured yt-dlp executable is not executable or was not found: ${path.basename(command)}`)
}

async function runYtDlpDiagnostic(env, executable) {
  const testUrl = env.RECALL_YTDLP_DIAGNOSTIC_URL
  const provider = createMediaRetrievalProvider(env.MEDIA_RETRIEVAL_PROVIDER || 'yt-dlp')
  if (!testUrl || !provider.canHandle(testUrl)) {
    throw new Error('Set RECALL_YTDLP_DIAGNOSTIC_URL to a supported public Reel URL you own or are authorized to test.')
  }
  const canonicalUrl = canonicalizeInstagramReelUrl(testUrl)
  console.info(`yt-dlp diagnostic URL normalized: https://www.instagram.com/${canonicalUrl.split('/')[3]}/<shortcode>/ (plain HTTPS URL; Markdown removed if present).`)

  const childEnv = createYtDlpChildEnvironment(env)
  const version = await runProcess(executable, ['--version'], { env: childEnv, timeoutMs: 10_000, maxOutputBytes: 2_000 })
  console.info(`yt-dlp diagnostic version: ${sanitizeYtDlpDiagnostic(version.stdout.trim()) || 'empty version output'}`)
  console.info(`yt-dlp version stderr: ${sanitizeYtDlpDiagnostic(version.stderr) || '(empty)'}`)

  const workDir = await temporaryDirectory()
  try {
    const diagnosticEnv = { ...env, YTDLP_PATH: executable }
    const diagnosticArgs = ytdlpArguments({
      url: canonicalUrl,
      outputTemplate: path.join(workDir, 'download.%(ext)s'),
      maxBytes: Math.max(1, Number(env.RECALL_VIDEO_MAX_BYTES || 100 * 1024 * 1024)),
      maxDurationSeconds: Math.max(1, Number(env.RECALL_VIDEO_MAX_DURATION_SECONDS || 600)),
      diagnostic: true,
    })
    const printIndex = diagnosticArgs.indexOf('--print')
    const printTemplate = diagnosticArgs[printIndex + 1]
    console.info(`yt-dlp diagnostic settings: match-filter=(removed); print-template=${sanitizeYtDlpDiagnostic(printTemplate, 80)}; print-template-is-separate-argument=${diagnosticArgs[printIndex + 1] === 'after_move:filepath'}`)
    console.info(`yt-dlp diagnostic retrieval argument names: ${ytDlpArgumentNames(diagnosticArgs)}; URL=[redacted]`)
    const media = await retrieveMediaFile({ job: { source_url: canonicalUrl }, env: diagnosticEnv, workDir, diagnostic: true })
    console.info(`yt-dlp retrieval stdout: ${media.processOutput.stdout || '(empty)'}`)
    console.info(`yt-dlp retrieval stderr: ${media.processOutput.stderr || '(empty)'}`)
    console.info(`yt-dlp diagnostic retrieval succeeded; container=${media.mimeType}; sizeBytes=${media.sizeBytes}; durationSeconds=${media.durationSeconds}; hasAudio=${media.hasAudio}.`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function processOneRetrieval({ client, workerName = `${os.hostname()}-${process.pid}`, env = process.env, retrieve, provider }) {
  const { data: jobs, error: claimError } = await client.rpc('claim_media_retrieval_job', { target_worker_name: workerName })
  if (claimError) throw new Error(`Could not claim media retrieval job: ${claimError.message}`)
  const job = jobs?.[0]
  if (!job) return { processed: false }

  let workDir
  let finalPath
  let handoffStarted = false
  try {
    workDir = await temporaryDirectory()
    const activeProvider = provider || createMediaRetrievalProvider(job.provider || env.MEDIA_RETRIEVAL_PROVIDER || 'yt-dlp')
    const media = retrieve
      ? await retrieve({ job, env, workDir })
      : await activeProvider.retrieve({ job, env, workDir })
    const mediaRoot = path.resolve(projectRoot, env.RECALL_MEDIA_DIR || '.local-media')
    await mkdir(mediaRoot, { recursive: true, mode: 0o700 })
    const storageKey = createStorageKey(path.extname(media.mediaPath).toLowerCase())
    finalPath = generatedMediaPath(mediaRoot, storageKey)
    await copyFile(media.mediaPath, finalPath, constants.COPYFILE_EXCL)

    handoffStarted = true
    const { data: completed, error } = await client.rpc('complete_media_retrieval_job', {
      target_job_id: job.job_id,
      target_claim_token: job.claim_token,
      target_storage_key: storageKey,
      target_mime_type: media.mimeType,
      target_size_bytes: media.sizeBytes,
      target_duration_seconds: media.durationSeconds,
    })
    if (error) throw new Error(`Could not hand off retrieved media to the video queue: ${error.message}`)
    if (!completed) {
      await rm(finalPath, { force: true })
      finalPath = undefined
      return { processed: true, status: 'superseded', itemId: job.item_id }
    }
    finalPath = undefined
    return { processed: true, status: 'retrieved', itemId: job.item_id, hasAudio: media.hasAudio }
  } catch (error) {
    const classified = error instanceof RetrievalError ? error : classifyYtDlpFailure(error instanceof Error ? error.message : '')
    const { data: status, error: failError } = await client.rpc('fail_media_retrieval_job', {
      target_job_id: job.job_id,
      target_claim_token: job.claim_token,
      target_status: classified.status,
      safe_error: safeError(classified),
    })
    if (failError) throw new Error(`Could not record retrieval failure: ${failError.message}`)
    return {
      processed: true,
      status: status || classified.status,
      itemId: job.item_id,
      failure: {
        category: classified.category,
        exitCode: classified.exitCode,
        signal: classified.signal,
        errorCode: classified.errorCode,
        errorMessage: classified.errorMessage,
        timedOut: classified.timedOut,
        timeoutMs: classified.timeoutMs,
        diagnostic: classified.diagnostic,
        stdoutDiagnostic: classified.stdoutDiagnostic || '',
        stderrDiagnostic: classified.stderrDiagnostic || '',
      },
    }
  } finally {
    // If the completion RPC returned an error, it may still have committed.
    // Keep that generated file until DB state can be inspected, rather than
    // leave a saved item pointing at a deleted file.
    if (finalPath && !handoffStarted) await rm(finalPath, { force: true }).catch(() => undefined)
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runMediaRetrievalWorker() {
  // Load .env.local before reading any worker settings; this worker is a plain
  // Node process and does not inherit Next.js's request-time environment setup.
  loadEnvConfig(projectRoot)
  if (process.env.RECALL_YTDLP_ENABLED !== 'true') {
    throw new Error('Media retrieval is opt-in. Set RECALL_YTDLP_ENABLED=true for local development before starting this worker.')
  }
  const provider = createMediaRetrievalProvider(process.env.MEDIA_RETRIEVAL_PROVIDER || 'yt-dlp')
  const ytdlpExecutable = await resolveExecutable(process.env.YTDLP_PATH || 'yt-dlp')
  if (process.argv.includes('--diagnose')) {
    await runYtDlpDiagnostic(process.env, ytdlpExecutable)
    return
  }
  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) throw new Error('Set Supabase URL and server-only SUPABASE_SERVICE_ROLE_KEY before starting the retrieval worker.')

  const client = createClient(serviceUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const workerName = process.env.MEDIA_RETRIEVAL_WORKER_ID || `${os.hostname()}-${process.pid}`
  const pollMs = Math.max(250, Math.min(30_000, Number(process.env.MEDIA_RETRIEVAL_WORKER_POLL_MS || 2000)))
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.info(`Recall media retrieval worker ${workerName}: ${provider.id} (opt-in local development only).`)
  console.info(`yt-dlp executable: ${ytdlpExecutable}`)
  console.info(`yt-dlp child Expat override: ${process.env.YTDLP_DYLD_LIBRARY_PATH ? 'configured' : 'not configured'}`)
  try {
    while (!stopping) {
      try {
        const result = await processOneRetrieval({ client, workerName, provider })
        if (result.processed) {
          if (result.failure) {
            console.error(`Media retrieval job ${result.itemId}: ${result.status}; category=${result.failure.category}; exitCode=${result.failure.exitCode ?? 'unavailable'}; signal=${result.failure.signal || 'none'}; timedOut=${result.failure.timedOut}; timeoutMs=${result.failure.timeoutMs ?? 'n/a'}; spawnErrorCode=${result.failure.errorCode || 'none'}; spawnError=${result.failure.errorMessage || 'none'}; diagnostic=${result.failure.diagnostic}; stdout=${result.failure.stdoutDiagnostic || '(empty)'}; stderr=${result.failure.stderrDiagnostic || '(empty)'}`)
          } else console.info(`Media retrieval job for ${result.itemId}: ${result.status}.`)
        }
        else await sleep(pollMs)
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Media retrieval worker failed.')
        await sleep(pollMs)
      }
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  console.info('Recall media retrieval worker stopped.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runMediaRetrievalWorker()
  } catch (error) {
    if (error instanceof RetrievalError) {
      console.error(`Media retrieval diagnostic failed; category=${error.category}; exitCode=${error.exitCode ?? 'unavailable'}; signal=${error.signal || 'none'}; spawnErrorCode=${error.errorCode || 'none'}; spawnError=${error.errorMessage || 'none'}; diagnostic=${error.diagnostic}; stdout=${error.stdoutDiagnostic || '(empty)'}; stderr=${error.stderrDiagnostic || '(empty)'}`)
    } else {
      console.error(sanitizeYtDlpDiagnostic(error instanceof Error ? error.message : String(error)))
    }
    process.exitCode = 1
  }
}
