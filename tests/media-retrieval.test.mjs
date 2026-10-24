import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { canonicalizeInstagramReelUrl, classifyYtDlpFailure, createMediaRetrievalProvider, retrieveMediaFile, runProcess, sanitizeYtDlpDiagnostic, ytdlpArguments, ytDlpArgumentNames } from '../lib/media-retrieval.mjs'
import { processOneRetrieval } from '../scripts/media-retrieval-worker.mjs'

test('canonicalizes only supported public Instagram Reel and post URL patterns', () => {
  assert.equal(canonicalizeInstagramReelUrl('https://www.instagram.com/reel/Ab_c-123/?igsh=private-looking-token#part'), 'https://www.instagram.com/reel/Ab_c-123/')
  assert.equal(canonicalizeInstagramReelUrl('https://instagram.com/p/ABC123'), 'https://www.instagram.com/p/ABC123/')
  for (const url of [
    'http://www.instagram.com/reel/Ab_c-123/',
    'https://notinstagram.com/reel/Ab_c-123/',
    'https://instagram.com.evil.test/reel/Ab_c-123/',
    'https://user:pass@instagram.com/reel/Ab_c-123/',
    'https://instagram.com/stories/user/123/',
    'https://instagram.com/reel/../private/',
  ]) assert.throws(() => canonicalizeInstagramReelUrl(url), { status: 'unsupported' })
})

test('accepts plain and valid Markdown-wrapped Reel URLs, including escaped Markdown punctuation', () => {
  const expected = 'https://www.instagram.com/reel/De1kdwASq8e/'
  assert.equal(canonicalizeInstagramReelUrl(expected), expected)
  assert.equal(canonicalizeInstagramReelUrl(`[Watch this](${expected})`), expected)
  assert.equal(canonicalizeInstagramReelUrl('[https\\://www\\.instagram.com/reel/De1kdwASq8e/]\\(https\\://www\\.instagram.com/reel/De1kdwASq8e/)'), expected)
})

test('rejects malformed Markdown wrappers and malformed URLs before starting yt-dlp', () => {
  assert.throws(() => canonicalizeInstagramReelUrl('[label](not a URL)'), { category: 'invalid_url' })
  assert.throws(() => canonicalizeInstagramReelUrl('[missing href]'), { category: 'invalid_url' })
  assert.throws(() => canonicalizeInstagramReelUrl('ht!tp://instagram.com/reel/abc/'), { category: 'invalid_url' })
  assert.throws(() => canonicalizeInstagramReelUrl('https://instagram.com/reel/'), { category: 'unsupported_url' })
})

test('malformed URL is rejected by the retrieval adapter before the subprocess runner is called', async () => {
  let invoked = false
  await assert.rejects(retrieveMediaFile({
    job: { source_url: '[not a URL](not a URL)' },
    env: { YTDLP_PATH: '/fixture/yt-dlp' },
    workDir: '/tmp/recall-invalid-url',
    run: async () => { invoked = true; return { stdout: '', stderr: '', exitCode: 0 } },
  }), error => error.category === 'invalid_url')
  assert.equal(invoked, false)
})

test('classifies permanent access and rate limits separately from transient errors', () => {
  assert.equal(classifyYtDlpFailure('Unsupported URL').status, 'unsupported')
  assert.equal(classifyYtDlpFailure('This account is private; login required').status, 'requires_authorization')
  assert.equal(classifyYtDlpFailure('HTTP Error 429: Too Many Requests').status, 'failed')
  assert.equal(classifyYtDlpFailure('HTTP Error 503: Service Unavailable').status, 'retry_wait')
  assert.equal(classifyYtDlpFailure('connection reset by peer').retryable, true)
  assert.match(classifyYtDlpFailure("ImportError: No module named 'pyexpat'").message, /YTDLP_DYLD_LIBRARY_PATH/)
  assert.equal(classifyYtDlpFailure("ImportError: No module named 'pyexpat'").category, 'local_dependency')
  assert.equal(classifyYtDlpFailure('Unsupported URL').category, 'unsupported_url')
  assert.equal(classifyYtDlpFailure('HTTP Error 403: Forbidden').category, 'access_restricted')
  assert.equal(classifyYtDlpFailure('HTTP Error 503: Service Unavailable').category, 'transient_network')
  assert.equal(classifyYtDlpFailure('curl: (6) Could not resolve host: www.instagram.com').category, 'transient_network')
  assert.equal(classifyYtDlpFailure('yt-dlp: error: no such option: --no-netrc').category, 'local_configuration')
})

test('yt-dlp failure diagnostics retain exit code and redact URL credentials and tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-retrieval-diagnostic-'))
  try {
    const executable = path.join(root, 'yt-dlp-fails')
    await writeFile(executable, '#!/bin/sh\necho "ImportError pyexpat https://example.test/reel?token=secret cookie=private" >&2\nexit 7\n')
    await chmod(executable, 0o755)
    await assert.rejects(runProcess(executable, [], {}), error => {
      assert.equal(error.exitCode, 7)
      assert.equal(error.category, 'local_dependency')
      assert.equal(error.signal, null)
      assert.match(error.diagnostic, /ImportError pyexpat/)
      assert.doesNotMatch(error.diagnostic, /secret|private|example\.test/)
      assert.match(error.diagnostic, /\[url\]/)
      return true
    })
    assert.ok(sanitizeYtDlpDiagnostic('x'.repeat(1000)).length <= 500)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('spawn failure records the OS error code and message when no stderr exists', async () => {
  await assert.rejects(runProcess('/definitely/missing/recall-yt-dlp', [], {}), error => {
    assert.equal(error.category, 'local_dependency')
    assert.equal(error.errorCode, 'ENOENT')
    assert.match(error.errorMessage, /spawn .* ENOENT/i)
    assert.equal(error.exitCode, null)
    assert.match(error.diagnostic, /ENOENT/)
    return true
  })
})

test('non-zero process exit captures stdout fallback and termination signal metadata', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("provider stdout context");process.exit(9)'], {}).catch(error => error)
  assert.equal(result.exitCode, 9)
  assert.equal(result.signal, null)
  assert.match(result.diagnostic, /provider stdout context/)
})

test('successful subprocess waits for close and returns captured stdout, stderr, and exit code', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("path-output");process.stderr.write("warning-output")'], {})
  assert.deepEqual(result, { stdout: 'path-output', stderr: 'warning-output', exitCode: 0, signal: null })
})

test('empty stderr still produces a clear diagnostic and never becomes an empty provider error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-empty-output-'))
  try {
    const workDir = await mkdtemp(path.join(root, 'job-'))
    await assert.rejects(retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' },
      env: { YTDLP_PATH: '/fixture/yt-dlp' },
      workDir,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null }),
    }), error => {
      assert.equal(error.category, 'empty_process_result')
      assert.equal(error.exitCode, 0)
      assert.match(error.diagnostic, /exited successfully but emitted no filepath/)
      return true
    })
    await assert.rejects(retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' },
      env: { YTDLP_PATH: '/fixture/yt-dlp' },
      workDir,
      run: async () => undefined,
    }), error => error.category === 'missing_process_result' && error.diagnostic.length > 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a successful yt-dlp process skip is classified with its stderr reason', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-filtered-output-'))
  try {
    const workDir = await mkdtemp(path.join(root, 'job-'))
    await assert.rejects(retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' },
      env: { YTDLP_PATH: '/fixture/yt-dlp' },
      workDir,
      run: async () => ({ stdout: '', stderr: '[download] item does not pass filter (duration > 600)', exitCode: 0, signal: null }),
    }), error => {
      assert.equal(error.category, 'filtered_item')
      assert.equal(error.exitCode, 0)
      assert.match(error.stderrDiagnostic, /does not pass filter/)
      assert.match(error.diagnostic, /does not pass filter/)
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('diagnostic mode disables yt-dlp quiet output and classifies max-filesize skips', async () => {
  const args = ytdlpArguments({ url: 'https://instagram.com/reel/abc/', outputTemplate: '/tmp/job/download.%(ext)s', maxBytes: 1000, maxDurationSeconds: 60, diagnostic: true })
  assert.ok(args.includes('--no-quiet'))
  assert.ok(args.includes('--verbose'))
  assert.ok(args.includes('--no-simulate'))
  assert.equal(args.includes('--match-filter'), false)
  assert.ok(args.includes('--max-filesize'))
  assert.deepEqual(args.slice(args.indexOf('--print'), args.indexOf('--print') + 2), ['--print', 'after_move:filepath'])
  const productionArgs = ytdlpArguments({ url: 'https://instagram.com/reel/abc/', outputTemplate: '/tmp/job/download.%(ext)s', maxBytes: 1000, maxDurationSeconds: 60 })
  assert.equal(productionArgs.includes('--match-filter'), false)
  assert.ok(productionArgs.includes('--max-filesize'))

  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-size-filtered-output-'))
  try {
    const workDir = await mkdtemp(path.join(root, 'job-'))
    await assert.rejects(retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' },
      env: { YTDLP_PATH: '/fixture/yt-dlp' }, workDir, diagnostic: true,
      run: async (_command, invokedArgs) => {
        assert.ok(invokedArgs.includes('--no-quiet'))
        assert.ok(invokedArgs.includes('--verbose'))
        return { stdout: '', stderr: '[download] File is larger than max-filesize', exitCode: 0, signal: null }
      },
    }), error => error.category === 'filtered_item' && /max-filesize/.test(error.diagnostic))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('diagnostic invocation receives a normalized plain URL and preserves separate print arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-normalized-diagnostic-'))
  try {
    const workDir = await mkdtemp(path.join(root, 'job-'))
    let capturedArgs
    await assert.rejects(retrieveMediaFile({
      job: { source_url: '[watch](https://instagram.com/reel/abc123/)' },
      env: { YTDLP_PATH: '/fixture/yt-dlp' }, workDir, diagnostic: true,
      run: async (_command, args) => {
        capturedArgs = args
        return { stdout: '', stderr: '[download] item does not pass filter', exitCode: 0, signal: null }
      },
    }), error => error.category === 'filtered_item')
    assert.equal(capturedArgs.at(-1), 'https://www.instagram.com/reel/abc123/')
    assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf('--print'), capturedArgs.indexOf('--print') + 2), ['--print', 'after_move:filepath'])
    assert.equal(capturedArgs.includes('--match-filter'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('successful download without filepath output is distinguished and file is ffprobe validated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-missing-print-path-'))
  try {
    const workDir = await mkdtemp(path.join(root, 'job-'))
    const mediaPath = path.join(workDir, 'download.mp4')
    await writeFile(mediaPath, 'fixture media')
    const run = async command => command === '/fixture/yt-dlp'
      ? { stdout: '', stderr: '', exitCode: 0, signal: null }
      : { stdout: JSON.stringify({ format: { duration: '12' }, streams: [{ codec_type: 'video' }] }), stderr: '', exitCode: 0, signal: null }
    await assert.rejects(retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' },
      env: { YTDLP_PATH: '/fixture/yt-dlp' }, workDir, run,
    }), error => {
      assert.equal(error.category, 'missing_filepath_output')
      assert.match(error.message, /ffprobe-validated/)
      assert.match(error.diagnostic, /passed ffprobe validation/)
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Expat override reaches only the yt-dlp child process environment', async () => {
  const childEnv = { ...process.env, DYLD_LIBRARY_PATH: '/fixture/expat/lib' }
  const childOutput = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.DYLD_LIBRARY_PATH || "")'], { env: childEnv })
  assert.equal(childOutput.stdout, '/fixture/expat/lib')
  assert.notEqual(process.env.DYLD_LIBRARY_PATH, '/fixture/expat/lib')

  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-retrieval-env-'))
  try {
    const workDir = await mkdtemp(path.join(root, 'job-'))
    const mediaPath = path.join(workDir, 'download.mp4')
    await writeFile(mediaPath, 'video')
    let ytDlpEnv
    const run = async (command, args, options) => {
      if (command === '/fixture/yt-dlp') { ytDlpEnv = options.env; return { stdout: `${mediaPath}\n`, stderr: '', exitCode: 0, signal: null } }
      return { stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] }), stderr: '', exitCode: 0, signal: null }
    }
    await retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' },
      env: { YTDLP_PATH: '/fixture/yt-dlp', YTDLP_DYLD_LIBRARY_PATH: '/fixture/expat/lib' },
      workDir,
      run,
    })
    assert.equal(ytDlpEnv.DYLD_LIBRARY_PATH, '/fixture/expat/lib')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('worker loads this project .env.local before validating local retrieval settings', async () => {
  const worker = await readFile(new URL('../scripts/media-retrieval-worker.mjs', import.meta.url), 'utf8')
  assert.match(worker, /loadEnvConfig\(projectRoot\)/)
  assert.ok(worker.indexOf('loadEnvConfig(projectRoot)') < worker.indexOf('process.env.RECALL_YTDLP_ENABLED'))
})

test('unsupported and authorization-required jobs become terminal without retrying', async () => {
  const unsupportedQueue = new RetrievalQueueDouble()
  unsupportedQueue.job.source_url = 'https://www.instagram.com/stories/example/123/'
  const unsupported = await processOneRetrieval({
    client: unsupportedQueue,
    retrieve: options => retrieveMediaFile({ ...options, run: runProcess }),
  })
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupportedQueue.status, 'unsupported')

  const authQueue = new RetrievalQueueDouble()
  const auth = await processOneRetrieval({
    client: authQueue,
    retrieve: async () => { throw classifyYtDlpFailure('HTTP Error 403: private or login required') },
  })
  assert.equal(auth.status, 'requires_authorization')
  assert.equal(authQueue.status, 'requires_authorization')
  assert.equal(authQueue.job.attempts, 1)
})

test('yt-dlp receives allowlisted URL arguments without cookies, config, or playlist expansion', () => {
  const args = ytdlpArguments({ url: 'https://instagram.com/reel/abc/', outputTemplate: '/tmp/job/download.%(ext)s', maxBytes: 1000, maxDurationSeconds: 60 })
  assert.ok(args.includes('--no-playlist'))
  assert.ok(args.includes('--ignore-config'))
  assert.equal(args.includes('--no-netrc'), false)
  assert.ok(args.includes('--print') && args.includes('after_move:filepath'))
  assert.equal(args.some(value => /cookie|browser|proxy|netrc=/i.test(value)), false)
  assert.equal(args.at(-1), 'https://www.instagram.com/reel/abc/')
  assert.doesNotMatch(ytDlpArgumentNames(args), /instagram|abc/)
  assert.equal(args.includes('--no-warnings'), false)
})

test('retrieval worker depends on a provider contract instead of yt-dlp internals', () => {
  const provider = createMediaRetrievalProvider('yt-dlp')
  assert.equal(provider.id, 'yt-dlp')
  assert.equal(provider.canHandle('https://www.instagram.com/reels/abc123/'), true)
  assert.equal(provider.canHandle('https://example.com/video.mp4'), false)
  assert.throws(() => createMediaRetrievalProvider('unconfigured-provider'), /Unsupported media retrieval provider/)
})

async function createControlledExecutables(root, { ffprobe = { format: { duration: '12' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }, fileContents = 'fixture media bytes' } = {}) {
  const ytdlpPath = path.join(root, 'yt-dlp-fixture.mjs')
  const probePath = path.join(root, 'ffprobe-fixture.mjs')
  await writeFile(ytdlpPath, `#!/usr/bin/env node\nimport { writeFile } from 'node:fs/promises'\nconst args=process.argv.slice(2);const template=args[args.indexOf('--output')+1];const target=template.replace('%(ext)s','mp4');await writeFile(target,${JSON.stringify(fileContents)});console.log(target)\n`)
  await writeFile(probePath, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(ffprobe))})\n`)
  await chmod(ytdlpPath, 0o755)
  await chmod(probePath, 0o755)
  return { ytdlpPath, probePath }
}

class RetrievalQueueDouble {
  constructor() {
    this.job = { job_id: 'job-1', item_id: 'item-1', user_id: 'user-1', source_url: 'https://www.instagram.com/reel/abc/', source_version: 1, claim_token: 'lease-1', attempts: 0, max_attempts: 4 }
    this.status = 'queued'
    this.handoff = null
    this.lastError = null
  }
  async rpc(name, args) {
    if (name === 'claim_media_retrieval_job') {
      if (!['queued', 'retry_wait'].includes(this.status)) return { data: [], error: null }
      this.status = 'retrieving'
      this.job.attempts += 1
      this.job.claim_token = `lease-${this.job.attempts}`
      return { data: [{ ...this.job }], error: null }
    }
    if (name === 'complete_media_retrieval_job') {
      this.handoff = args
      this.status = 'retrieved'
      return { data: true, error: null }
    }
    if (name === 'fail_media_retrieval_job') {
      if (this.status !== 'retrieving') return { data: 'superseded', error: null }
      this.lastError = args.safe_error
      this.status = args.target_status === 'retry_wait' && this.job.attempts < this.job.max_attempts ? 'retry_wait' : args.target_status === 'retry_wait' ? 'failed' : args.target_status
      return { data: this.status, error: null }
    }
    throw new Error(`Unexpected RPC ${name}`)
  }
}

test('controlled yt-dlp executable produces validated media and hands it to the existing video queue RPC', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-retrieval-test-'))
  try {
    const { ytdlpPath, probePath } = await createControlledExecutables(root)
    const queue = new RetrievalQueueDouble()
    const dyldBefore = process.env.DYLD_LIBRARY_PATH
    let workDir
    const result = await processOneRetrieval({
      client: queue,
      env: { RECALL_MEDIA_DIR: root, YTDLP_PATH: ytdlpPath, FFPROBE_BIN: probePath, RECALL_VIDEO_MAX_BYTES: '1000', RECALL_VIDEO_MAX_DURATION_SECONDS: '60' },
      retrieve: options => { workDir = options.workDir; return retrieveMediaFile({ ...options, run: runProcess }) },
    })
    assert.equal(result.status, 'retrieved')
    assert.equal(queue.status, 'retrieved')
    assert.equal(queue.handoff.target_mime_type, 'video/mp4')
    assert.equal(queue.handoff.target_size_bytes, Buffer.byteLength('fixture media bytes'))
    assert.match(queue.handoff.target_storage_key, /^[0-9a-f-]{36}\.mp4$/)
    assert.equal(process.env.DYLD_LIBRARY_PATH, dyldBefore)
    const stored = path.join(root, queue.handoff.target_storage_key)
    assert.equal(await readFile(stored, 'utf8'), 'fixture media bytes')
    await assert.rejects(readFile(workDir))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unsupported media, oversized output, and invalid video streams fail without a video queue handoff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-retrieval-test-'))
  try {
    const tooLarge = await createControlledExecutables(root, { fileContents: 'this is much too large' })
    const tooLargeResult = await retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' }, env: { YTDLP_PATH: tooLarge.ytdlpPath, FFPROBE_BIN: tooLarge.probePath, RECALL_VIDEO_MAX_BYTES: '2' },
      workDir: await mkdtemp(path.join(root, 'large-')), run: runProcess,
    }).catch(error => error)
    assert.equal(tooLargeResult.status, 'failed')
    assert.match(tooLargeResult.message, /between 1 byte/)

    const invalid = await createControlledExecutables(root, { ffprobe: { format: { duration: '3' }, streams: [{ codec_type: 'audio' }] } })
    const invalidDir = await mkdtemp(path.join(root, 'invalid-'))
    const invalidResult = await retrieveMediaFile({
      job: { source_url: 'https://instagram.com/reel/abc/' }, env: { YTDLP_PATH: invalid.ytdlpPath, FFPROBE_BIN: invalid.probePath }, workDir: invalidDir, run: runProcess,
    }).catch(error => error)
    assert.equal(invalidResult.status, 'failed')
    assert.match(invalidResult.message, /video stream/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('retrieval process timeout is bounded and classified as retryable', async () => {
  const script = `setTimeout(() => {}, 5000)`
  await assert.rejects(runProcess(process.execPath, ['-e', script], { timeoutMs: 40 }), error => {
    assert.equal(error.status, 'retry_wait')
    assert.equal(error.category, 'process_timeout')
    assert.equal(error.timedOut, true)
    assert.equal(error.timeoutMs, 40)
    assert.match(error.message, /timed out/)
    return true
  })
})

test('queue survives a worker restart and retries transient failures with a bounded state transition', async () => {
  const queue = new RetrievalQueueDouble()
  const transient = async () => { const error = new Error('HTTP Error 503'); throw classifyYtDlpFailure(error.message) }
  const first = await processOneRetrieval({ client: queue, retrieve: transient })
  assert.equal(first.status, 'retry_wait')
  assert.equal(queue.status, 'retry_wait')
  const second = await processOneRetrieval({
    client: queue,
    retrieve: async ({ workDir }) => {
      const mediaPath = path.join(workDir, 'download.mp4')
      await writeFile(mediaPath, 'video')
      return { mediaPath, mimeType: 'video/mp4', sizeBytes: 5, durationSeconds: 1, hasAudio: false }
    },
  })
  assert.equal(second.status, 'retrieved')
  assert.equal(queue.job.attempts, 2)
})

test('claiming is duplicate-safe when two workers race for one job', async () => {
  const queue = new RetrievalQueueDouble()
  let finish
  const held = new Promise(resolve => { finish = resolve })
  const first = processOneRetrieval({ client: queue, retrieve: async () => { await held; throw classifyYtDlpFailure('HTTP Error 503') } })
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = await processOneRetrieval({ client: queue, retrieve: async () => { throw new Error('must not run') } })
  finish()
  const firstResult = await first
  assert.equal(second.processed, false)
  assert.equal(firstResult.status, 'retry_wait')
  assert.equal(queue.job.attempts, 1)
})

test('SQL migration keeps the queue private and prevents authenticated users from enabling retrieval directly', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202610240001_media_retrieval_queue.sql', import.meta.url), 'utf8')
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /revoke all on public\.media_retrieval_jobs from public,anon,authenticated/i)
  assert.match(sql, /revoke all on function public\.create_saved_item_with_retrieval\([^;]+from public,anon,authenticated/i)
  assert.ok(sql.includes("coalesce(auth.role(),'')<>'service_role'"))
  assert.match(sql, /pg_advisory_xact_lock\(746281903,1\)/)
  assert.match(sql, /on conflict\(item_id,media_version\) where status in \('queued','processing'\) do nothing/i)
  assert.doesNotMatch(sql, /drop table|truncate|delete from public\.saved_items/i)
})
