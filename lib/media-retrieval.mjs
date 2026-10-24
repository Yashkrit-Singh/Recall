import { spawn } from 'node:child_process'
import { readdir, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class RetrievalError extends Error {
  constructor(message, { status = 'failed', retryable = false, category = 'provider_error', exitCode = null, signal = null, errorCode = null, errorMessage = '', timedOut = false, timeoutMs = null, stdoutDiagnostic = '', stderrDiagnostic = '', diagnostic = '' } = {}) {
    super(message)
    this.name = 'RetrievalError'
    this.status = status
    this.retryable = retryable
    this.category = category
    this.exitCode = exitCode
    this.signal = signal
    this.errorCode = errorCode
    this.errorMessage = errorMessage
    this.timedOut = timedOut
    this.timeoutMs = timeoutMs
    this.stdoutDiagnostic = stdoutDiagnostic
    this.stderrDiagnostic = stderrDiagnostic
    this.diagnostic = diagnostic
  }
}

const SHORTCODE = /^[A-Za-z0-9_-]+$/

export function canonicalizeInstagramReelUrl(value) {
  let supplied = String(value ?? '').trim()
  if (!supplied) throw new RetrievalError('Paste an Instagram Reel URL.', { status: 'unsupported', category: 'invalid_url' })
  const unescaped = supplied.replace(/\\([^A-Za-z0-9\s])/g, '$1')
  if (unescaped.startsWith('[')) {
    const markdown = unescaped.match(/^\[([^\]]+)\]\(([^()]*)\)$/)
    if (!markdown) throw new RetrievalError('This looks like a malformed Markdown link. Paste the plain HTTPS URL or use [label](URL).', { status: 'unsupported', category: 'invalid_url' })
    supplied = markdown[2].trim()
  } else {
    supplied = unescaped
  }
  let url
  try { url = new URL(supplied) } catch { throw new RetrievalError('The saved link is not a valid URL. Paste the plain URL, not Markdown text.', { status: 'unsupported', category: 'invalid_url' }) }
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new RetrievalError('Automatic retrieval only supports public Instagram Reel and post links.', { status: 'unsupported', category: 'unsupported_url' })
  }
  const match = url.pathname.match(/^\/(reel|reels|p)\/([^/]+)\/?$/i)
  if (!match || !SHORTCODE.test(match[2])) {
    throw new RetrievalError('Automatic retrieval only supports Instagram Reel and post permalinks.', { status: 'unsupported', category: 'unsupported_url' })
  }
  return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`
}

export function sanitizeYtDlpDiagnostic(message, maxLength = 500) {
  return String(message || '')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/--cookies?(?:-from-browser)?\s+[^\s]+/gi, '--cookies [redacted]')
    .replace(/\b(?:cookie|authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Keep the end of traceback-heavy output, where yt-dlp prints the
    // actionable extractor/network error after the stack frames.
    .slice(-maxLength)
}

export function classifyYtDlpFailure(message, { exitCode = null, signal = null, stdout = '', stderr = '', errorCode = null, errorMessage = '', timedOut = false, timeoutMs = null } = {}) {
  const text = [message, stderr, stdout, errorMessage].filter(Boolean).map(String).join('\n')
  const diagnostic = sanitizeYtDlpDiagnostic([stderr, stdout, errorMessage, message].filter(Boolean).map(String).join(' | ')) || 'No stderr or stdout captured.'
  const metadata = {
    exitCode, signal, errorCode, errorMessage: sanitizeYtDlpDiagnostic(errorMessage), timedOut, timeoutMs,
    stdoutDiagnostic: sanitizeYtDlpDiagnostic(stdout, 1200),
    stderrDiagnostic: sanitizeYtDlpDiagnostic(stderr, 1200),
    diagnostic,
  }
  if (timedOut) {
    return new RetrievalError('The media retrieval process timed out.', { ...metadata, status: 'retry_wait', retryable: true, category: 'process_timeout' })
  }
  if (/(pyexpat|no module named.*expat|importerror.*expat|module.*expat)/i.test(text)) {
    return new RetrievalError('yt-dlp Python could not load Expat. Set YTDLP_DYLD_LIBRARY_PATH to the Homebrew Expat lib directory.', { ...metadata, category: 'local_dependency' })
  }
  if (/(no such file or directory|enoent|not found|could not be started)/i.test(text)) {
    return new RetrievalError('yt-dlp executable is unavailable. Check YTDLP_PATH and the worker PATH.', { ...metadata, category: 'local_dependency' })
  }
  if (/(no such option|unrecognized option|unknown option)/i.test(text)) {
    return new RetrievalError('The configured yt-dlp command uses an unsupported option. Check the installed yt-dlp version and worker arguments.', { ...metadata, category: 'local_configuration' })
  }
  if (/(module not found|no module named|importerror|dyld\[|image not found|library not loaded|bad cpu type)/i.test(text)) {
    return new RetrievalError('yt-dlp could not start because a local runtime dependency is unavailable.', { ...metadata, category: 'local_dependency' })
  }
  if (/(unsupported url|no suitable extractor|not a valid url|unsupported site)/i.test(text)) {
    return new RetrievalError('This link is not supported by the configured media provider.', { ...metadata, status: 'unsupported', category: 'unsupported_url' })
  }
  if (/(private|login required|please log in|logged in to|authentication required|http error 401|http error 403|forbidden|access denied|not authorized|captcha|challenge|sign in|members only|login.*required)/i.test(text)) {
    return new RetrievalError('The source requires authorization or blocks automated access. No credentials or access workarounds were used.', { ...metadata, status: 'requires_authorization', category: 'access_restricted' })
  }
  if (/(http error 429|too many requests|rate.?limit|temporarily blocked)/i.test(text)) {
    return new RetrievalError('The source rate-limited or blocked retrieval. Automatic retries are paused.', { ...metadata, status: 'failed', category: 'rate_limited' })
  }
  if (/(does not pass filter|does not match filter|not matching filter|filtered out|skipping .*duration|maximum filesize|file size.*(?:limit|larger)|max[- ]filesize)/i.test(text)) {
    return new RetrievalError('yt-dlp skipped this item because it did not pass the configured media filter.', { ...metadata, status: 'failed', category: 'filtered_item' })
  }
  if (/(timed? ?out|timeout|connection reset|connection refused|temporary failure|name or service not known|could not resolve host|failed to perform.*curl: \(6\)|network is unreachable|http error 5\d\d|server error)/i.test(text)) {
    return new RetrievalError('Temporary network or source-server failure.', { ...metadata, status: 'retry_wait', retryable: true, category: 'transient_network' })
  }
  return new RetrievalError('The provider could not retrieve this link. See the sanitized worker diagnostic.', { ...metadata, category: 'provider_error' })
}

export function createYtDlpChildEnvironment(env = process.env) {
  const childEnv = { ...process.env, ...env }
  if (env.YTDLP_DYLD_LIBRARY_PATH) childEnv.DYLD_LIBRARY_PATH = env.YTDLP_DYLD_LIBRARY_PATH
  return childEnv
}

export function ytDlpArgumentNames(args) {
  return args.filter(argument => argument.startsWith('--')).join(' ')
}

function terminate(child) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch { child.kill?.('SIGTERM') }
  const force = setTimeout(() => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { child.kill?.('SIGKILL') }
  }, 1500)
  force.unref?.()
  return force
}

export function runProcess(command, args, { env = process.env, timeoutMs = 20_000, maxOutputBytes = 64_000, watchDirectory, maxFileBytes } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (error) {
      const failure = classifyYtDlpFailure(error instanceof Error ? error.message : '', {
        errorCode: error?.code,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      reject(failure)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let spawnError = null
    let observedExitCode = null
    let observedSignal = null
    let fileTooLarge = false
    let outputTooLarge = false
    let sizeTimer
    let forceKillTimer
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (sizeTimer) clearInterval(sizeTimer)
      fn(value)
    }
    const timer = setTimeout(() => { timedOut = true; forceKillTimer = terminate(child) }, timeoutMs)
    if (watchDirectory && Number.isFinite(maxFileBytes) && maxFileBytes > 0) {
      sizeTimer = setInterval(async () => {
        if (settled || fileTooLarge) return
        try {
          const names = await readdir(watchDirectory)
          let total = 0
          for (const name of names.filter(entry => entry.startsWith('download.'))) {
            try { total += (await stat(path.join(watchDirectory, name))).size } catch { /* file may be in a rename */ }
          }
          if (total > maxFileBytes) { fileTooLarge = true; forceKillTimer = terminate(child) }
        } catch { /* output directory is not created until download begins */ }
      }, 250)
      sizeTimer.unref?.()
    }
    const capture = (target, chunk) => {
      if (outputTooLarge || settled) return
      const next = target.value + chunk.toString()
      if (Buffer.byteLength(next) > maxOutputBytes) {
        outputTooLarge = true
        forceKillTimer = terminate(child)
      } else target.value = next
    }
    child.stdout.on('data', chunk => capture({ get value() { return stdout }, set value(value) { stdout = value } }, chunk))
    child.stderr.on('data', chunk => capture({ get value() { return stderr }, set value(value) { stderr = value } }, chunk))
    child.on('error', error => { spawnError = error })
    child.on('exit', (code, signal) => { observedExitCode = code; observedSignal = signal })
    child.on('close', (code, signal) => {
      const finalExitCode = code ?? observedExitCode
      const finalSignal = signal ?? observedSignal
      if (spawnError) {
        return settle(reject, classifyYtDlpFailure(spawnError.message, {
          // libuv may put its negative spawn error code in ChildProcess 'close'
          // code; it is not an operating-system process exit status.
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          errorCode: spawnError.code,
          errorMessage: spawnError.message,
        }))
      }
      if (timedOut) return settle(reject, classifyYtDlpFailure('Media retrieval process timeout.', { exitCode: finalExitCode, signal: finalSignal, stdout, stderr, timedOut: true, timeoutMs }))
      if (fileTooLarge) return settle(reject, new RetrievalError('The download exceeded the configured file-size limit.', { status: 'failed', category: 'file_size_limit', exitCode: finalExitCode, signal: finalSignal, diagnostic: sanitizeYtDlpDiagnostic(`${stderr} ${stdout}`) || 'The download exceeded the configured file-size limit.' }))
      if (outputTooLarge) return settle(reject, new RetrievalError('The media provider produced too much command output.', { status: 'failed', category: 'process_output_limit', exitCode: finalExitCode, signal: finalSignal, diagnostic: sanitizeYtDlpDiagnostic(`${stderr} ${stdout}`) || 'The command output exceeded its configured limit.' }))
      if (settled) return
      if (code === 0) settle(resolve, { stdout, stderr, exitCode: finalExitCode, signal: finalSignal })
      else settle(reject, classifyYtDlpFailure(stderr.slice(-4000), { exitCode: finalExitCode, signal: finalSignal, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }))
    })
  })
}

export function ytdlpArguments({ url, outputTemplate, maxBytes, maxDurationSeconds, diagnostic = false }) {
  const canonicalUrl = canonicalizeInstagramReelUrl(url)
  return [
    '--ignore-config', '--no-playlist', '--no-progress',
    '--no-cache-dir', '--socket-timeout', '30', '--retries', '0', '--fragment-retries', '0',
    '--merge-output-format', 'mp4', '--max-filesize', String(maxBytes),
    '--output', outputTemplate, '--print', 'after_move:filepath',
    // yt-dlp's --print implies quiet mode. In diagnostic runs explicitly undo
    // that, request verbose logs, and explicitly permit download. Duration is
    // validated with ffprobe after download rather than filtered on metadata.
    ...(diagnostic ? ['--no-quiet', '--verbose', '--no-simulate'] : []),
    canonicalUrl,
  ]
}

function safeStoragePath(root, key) {
  if (!/^[0-9a-f-]{36}\.(mp4|mov|webm)$/.test(key)) throw new Error('Generated media key did not pass validation.')
  const resolvedRoot = path.resolve(root)
  const outputPath = path.resolve(resolvedRoot, key)
  if (path.dirname(outputPath) !== resolvedRoot) throw new Error('Generated media path escaped private storage.')
  return outputPath
}

async function probeVideo(filePath, { ffprobePath = 'ffprobe', maxBytes, maxDurationSeconds, run = runProcess } = {}) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxBytes) {
    throw new RetrievalError(`Retrieved file must be between 1 byte and ${maxBytes} bytes.`, { status: 'failed' })
  }
  let stdout
  try {
    ({ stdout } = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', filePath], { timeoutMs: 20_000, maxOutputBytes: 1_000_000 }))
  } catch (error) {
    if (error instanceof RetrievalError && /unavailable/i.test(error.message)) {
      throw new RetrievalError('ffprobe is unavailable. Install FFmpeg and check FFPROBE_BIN.', { status: 'failed' })
    }
    throw new RetrievalError('The downloaded file is not readable video media.', { status: 'failed' })
  }
  let info
  try { info = JSON.parse(stdout) } catch { throw new RetrievalError('The media probe returned invalid information.', { status: 'failed' }) }
  const duration = Number(info.format?.duration)
  const streamTypes = Array.isArray(info.streams) ? info.streams.map(stream => stream.codec_type) : []
  if (!streamTypes.includes('video')) throw new RetrievalError('The downloaded file does not contain a video stream.', { status: 'failed' })
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxDurationSeconds) {
    throw new RetrievalError(`Video duration must be 1 to ${maxDurationSeconds} seconds.`, { status: 'failed' })
  }
  const extension = path.extname(filePath).toLowerCase()
  const mimeType = ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' })[extension]
  if (!mimeType) throw new RetrievalError('The downloaded video container is not supported.', { status: 'failed' })
  return { sizeBytes: fileStat.size, durationSeconds: duration, mimeType, hasAudio: streamTypes.includes('audio') }
}

export async function retrieveMediaFile({ job, env = process.env, workDir, run = runProcess, diagnostic = false }) {
  const canonicalUrl = canonicalizeInstagramReelUrl(job.source_url)
  const maxBytes = Math.max(1, Number(env.RECALL_VIDEO_MAX_BYTES || 100 * 1024 * 1024))
  const maxDurationSeconds = Math.max(1, Number(env.RECALL_VIDEO_MAX_DURATION_SECONDS || 600))
  const timeoutMs = Math.max(30_000, Math.min(25 * 60_000, Number(env.YTDLP_TIMEOUT_MS || 15 * 60_000)))
  const outputTemplate = path.join(workDir, 'download.%(ext)s')
  const childEnv = createYtDlpChildEnvironment(env)
  const ytdlpPath = env.YTDLP_PATH || 'yt-dlp'
  let output
  try {
    output = await run(ytdlpPath, ytdlpArguments({ url: canonicalUrl, outputTemplate, maxBytes, maxDurationSeconds, diagnostic }), {
      env: childEnv, timeoutMs, maxOutputBytes: diagnostic ? 1_000_000 : 64_000, watchDirectory: workDir, maxFileBytes: maxBytes,
    })
  } catch (error) {
    if (error instanceof RetrievalError) throw error
    throw classifyYtDlpFailure(error)
  }
  if (!output || typeof output.stdout !== 'string' || !Number.isInteger(output.exitCode)) {
    throw new RetrievalError('The yt-dlp runner returned no process result.', {
      status: 'failed', category: 'missing_process_result',
      diagnostic: sanitizeYtDlpDiagnostic(output?.stderr || output?.stdout || '') || 'Runner resolved without both a stdout string and numeric exit code.',
    })
  }
  if (output.exitCode !== 0) {
    throw classifyYtDlpFailure(output.stderr || '', { exitCode: output.exitCode, signal: output.signal || null, stdout: output.stdout || '', stderr: output.stderr || '' })
  }
  const processOutput = {
    stdout: sanitizeYtDlpDiagnostic(output.stdout, 1200),
    stderr: sanitizeYtDlpDiagnostic(output.stderr || '', 1200),
  }
  const lines = output.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const printedPath = lines.filter(line => path.isAbsolute(line) && /^download\.(mp4|mov|webm)$/i.test(path.basename(line))).at(-1)
  if (!printedPath) {
    const diagnosticText = [output.stderr, output.stdout].filter(Boolean).join('\n')
    const skipped = /(does not pass filter|does not match filter|not matching filter|filtered out|skipping .*duration|maximum filesize|file size.*(?:limit|larger)|max[- ]filesize)/i.test(diagnosticText)
    const generatedFiles = (await readdir(workDir)).filter(name => /^download\.(mp4|mov|webm)$/i.test(name))
    if (generatedFiles.length === 1) {
      try {
        const discoveredPath = path.join(workDir, generatedFiles[0])
        const metadata = await probeVideo(discoveredPath, { ffprobePath: env.FFPROBE_BIN || 'ffprobe', maxBytes, maxDurationSeconds, run })
        throw new RetrievalError('yt-dlp downloaded and ffprobe-validated a file but did not emit its filepath on stdout.', {
          status: 'failed', category: 'missing_filepath_output', exitCode: output.exitCode ?? 0, signal: output.signal ?? null,
          stdoutDiagnostic: processOutput.stdout, stderrDiagnostic: processOutput.stderr,
          diagnostic: `A generated media file exists and passed ffprobe validation (sizeBytes=${metadata.sizeBytes}, durationSeconds=${metadata.durationSeconds}), but no filepath was printed.`,
        })
      } catch (error) {
        if (error instanceof RetrievalError && error.category === 'missing_filepath_output') throw error
        // Invalid or unreadable output is reported below as the missing/skip result.
      }
    }
    const category = skipped ? 'filtered_item' : lines.length ? 'missing_filepath_output' : 'empty_process_result'
    throw new RetrievalError('yt-dlp exited without reporting a completed media file.', {
      status: 'failed', category, exitCode: output.exitCode ?? 0, signal: output.signal ?? null,
      stdoutDiagnostic: processOutput.stdout,
      stderrDiagnostic: processOutput.stderr,
      diagnostic: sanitizeYtDlpDiagnostic(diagnosticText) || (skipped ? 'yt-dlp reported an item skip without further output.' : 'yt-dlp exited successfully but emitted no filepath on stdout and no generated media file was found.'),
    })
  }
  const tempRoot = await realpath(workDir)
  let mediaPath
  try { mediaPath = await realpath(printedPath) } catch { throw new RetrievalError('The provider output file was not found.', { status: 'failed' }) }
  const relative = path.relative(tempRoot, mediaPath)
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.dirname(relative) !== '.') {
    throw new RetrievalError('The provider output path was outside its private temporary directory.', { status: 'failed' })
  }
  if (!/^download\.(mp4|mov|webm)$/i.test(path.basename(mediaPath))) {
    throw new RetrievalError('The provider returned an unexpected file name or container.', { status: 'failed' })
  }
  const metadata = await probeVideo(mediaPath, { ffprobePath: env.FFPROBE_BIN || 'ffprobe', maxBytes, maxDurationSeconds, run })
  return { mediaPath, canonicalUrl, ...metadata, processOutput }
}

// Provider contract used by the durable queue worker. A future provider can
// implement the same canHandle/retrieve methods without changing queue or
// Stage 3 video-processing code.
export function createMediaRetrievalProvider(providerId = 'yt-dlp', { run = runProcess } = {}) {
  if (providerId !== 'yt-dlp') throw new Error(`Unsupported media retrieval provider: ${providerId}`)
  return Object.freeze({
    id: providerId,
    canHandle(url) {
      try { canonicalizeInstagramReelUrl(url); return true } catch { return false }
    },
    retrieve(input) {
      if (!this.canHandle(input.job.source_url)) {
        throw new RetrievalError('This link is not supported by the configured media provider.', { status: 'unsupported' })
      }
      return retrieveMediaFile({ ...input, run })
    },
  })
}

export function createStorageKey(extension) {
  if (!['.mp4', '.mov', '.webm'].includes(extension)) throw new Error('Unsupported media extension.')
  return `${randomUUID()}${extension}`
}

export function generatedMediaPath(root, storageKey) {
  return safeStoragePath(root, storageKey)
}
