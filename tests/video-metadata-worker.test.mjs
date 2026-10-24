import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import {
  analyzeVisualSegments,
  generateVideoMetadata,
  parseSceneChangeTimestamps,
  planTimelineSamples,
  probeVideo,
  processOneMetadataJob,
  sampleTimelineFrames,
  validateGeneratedMetadata,
} from '../scripts/video-metadata-worker.mjs'
import { transcribeAudioTrack } from '../scripts/video-worker.mjs'

const generated = {
  title: 'A baker prepares bread in a home kitchen',
  summary: 'A baker mixes dough and kneads it on a counter. The loaf is shaped and placed into an oven.',
  notes: 'The clip shows dough preparation, kneading, shaping, and baking.',
  tags: ['baking', 'bread', 'recipe'],
  transcript_summary: '',
  visual_summary: 'The sequence moves from mixing dough to kneading, shaping, and baking.',
  analysis_warnings: [],
}

test('plans bounded full-duration samples and includes distributed scene changes', () => {
  const samples = planTimelineSamples(120, [5, 10, 25, 39, 60, 88, 112], {
    VIDEO_METADATA_MAX_FRAMES: '20', VIDEO_METADATA_SAMPLE_INTERVAL_SECONDS: '4',
  })
  assert.ok(samples.length >= 20)
  assert.ok(samples.length <= 20)
  assert.equal(samples[0].time, 0)
  assert.ok(samples.at(-1).time > 115)
  assert.ok(samples.some(sample => sample.scene))
  assert.ok(samples.every((sample, index) => index === 0 || sample.time > samples[index - 1].time))
})

test('scene-change parser ignores invalid and out-of-duration timestamps', () => {
  assert.deepEqual(parseSceneChangeTimestamps('pts_time:1.2 pts_time:6.5 pts_time:-1 pts_time:99', 10), [1.2, 6.5])
})

test('probes the full media stream inventory and identifies silent video', async () => {
  const result = await probeVideo('/private/clip.mp4', {
    runCommand: async (_command, args) => {
      assert.ok(args.find(value => String(value).includes('stream=index,codec_type,codec_name,duration,width,height,sample_rate,channels')))
      return { stdout: JSON.stringify({ format: { duration: '30' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 }] }) }
    },
  })
  assert.equal(result.durationSeconds, 30)
  assert.equal(result.hasAudio, false)
})

test('full-track transcription preserves timestamped segments when Whisper is configured', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'recall-full-audio-'))
  try {
    const result = await transcribeAudioTrack({
      inputPath: '/private/clip.mp4', workDir, enabled: true,
      env: { WHISPER_MODEL_PATH: '/models/ggml-small.bin', WHISPER_LANGUAGE: 'auto' },
      runCommand: async (command, args) => {
        if (command === 'ffmpeg') {
          assert.ok(args.includes('-vn'), 'audio extraction must span the full input, not a short crop')
          assert.ok(args.includes('-ar') && args[args.indexOf('-ar') + 1] === '16000')
          await writeFile(args.at(-2), 'wave')
          return { stdout: '', stderr: '' }
        }
        assert.ok(args.includes('-f'))
        assert.ok(args.includes(path.join(workDir, 'audio.wav')))
        await writeFile(`${path.join(workDir, 'transcript')}.json`, JSON.stringify({ transcription: [
          { timestamps: { from: '00:00:01.000', to: '00:00:02.000' }, text: ' Mix flour and water.' },
          { timestamps: { from: '00:01:14.000', to: '00:01:17.000' }, text: ' Let it rest.' },
        ] }))
        return { stdout: '', stderr: '' }
      },
    })
    assert.equal(result.status, 'transcribed')
    assert.deepEqual(result.segments.map(segment => segment.start), [1, 74])
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test('transcription handles silent clips and a missing local Whisper model without failing visual analysis', async () => {
  assert.deepEqual(await transcribeAudioTrack({ inputPath: 'clip.mp4', workDir: '/tmp', audioAvailable: false, enabled: true }), {
    segments: [], status: 'no_audio', warning: 'The video has no audio stream.',
  })
  const missing = await transcribeAudioTrack({ inputPath: 'clip.mp4', workDir: '/tmp', enabled: true, env: {} })
  assert.equal(missing.status, 'unavailable')
  assert.match(missing.warning, /WHISPER_MODEL_PATH/)
})

test('samples the timeline into private frames and reports gaps if extraction fails', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'recall-timeline-'))
  try {
    let count = 0
    const result = await sampleTimelineFrames({
      inputPath: '/private/clip.mp4', durationSeconds: 24, sceneTimes: [7.5, 16], workDir,
      env: { VIDEO_METADATA_MAX_FRAMES: '6', VIDEO_METADATA_SAMPLE_INTERVAL_SECONDS: '4' },
      runCommand: async (_command, args) => {
        count += 1
        if (count === 3) throw new Error('frame unavailable')
        await writeFile(args.at(-1), `frame-${count}`)
        return { stdout: '', stderr: '' }
      },
    })
    assert.ok(result.frames.length >= 5)
    assert.ok(result.frames.length <= 6)
    assert.ok(result.frames.every(frame => typeof frame.image === 'string'))
    assert.equal(result.coverageComplete, false)
    assert.match(result.warnings.join(' '), /samples failed|incomplete/)
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test('analyzes timestamped image batches in chronological order instead of pretending the model accepts video', async () => {
  const requests = []
  const frames = Array.from({ length: 5 }, (_, index) => ({ time: index * 10, scene: index === 2, image: `image-${index}` }))
  const result = await analyzeVisualSegments({
    frames, model: 'llava:7b', env: { VIDEO_METADATA_FRAMES_PER_SEGMENT: '2' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      return new Response(JSON.stringify({ message: { content: `Observed sequence ${requests.length}.` } }), { status: 200 })
    },
  })
  assert.equal(result.length, 3)
  assert.deepEqual(requests.map(request => request.messages[1].images), [['image-0', 'image-1'], ['image-2', 'image-3'], ['image-4']])
  assert.ok(requests.every(request => request.options.num_ctx === 8192))
  assert.match(requests[1].messages[1].content, /00:20\.0.*detected scene change/)
})

test('validates structured output, preserves short tags, and rejects unsupported transcript claims', () => {
  assert.deepEqual(validateGeneratedMetadata({
    ...generated, tags: ['R2D2', 'AI', 'ai', 'bread'],
  }), { ...generated, tags: ['R2D2', 'AI', 'bread'] })
  assert.throws(() => validateGeneratedMetadata({ ...generated, summary: 'A baker kneads dough.' }), /2–4 sentence/)
  assert.throws(() => validateGeneratedMetadata({ ...generated, transcript_summary: 'A person says hello.' }), /no transcript/)
  assert.throws(() => validateGeneratedMetadata({ ...generated, tags: Array(11).fill('tag') }), /tags and analysis warnings/)
})

test('consolidation includes spoken evidence, visual timeline, OCR as supporting evidence, and untrusted-input warning', async () => {
  let requestBody
  const metadata = { ...generated, transcript_summary: 'The baker says to let the dough rest.' }
  const result = await generateVideoMetadata({
    transcript: '[00:10.0] Let the dough rest.',
    visualSegments: [{ start: 0, end: 20, text: 'Dough is mixed then kneaded.' }],
    ocrText: '[00:05.0] 180 C', analysisWarnings: ['Some samples were missed.'], model: 'llava:7b',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return new Response(JSON.stringify({ message: { content: JSON.stringify(metadata) } }), { status: 200 })
    },
  })
  const prompt = requestBody.messages.map(message => message.content).join('\n')
  assert.match(prompt, /Untrusted timestamped transcript/)
  assert.match(prompt, /Supporting on-screen OCR only/)
  assert.match(prompt, /Some samples were missed/)
  assert.match(prompt, /never as instructions/)
  assert.equal(requestBody.options.num_ctx, 8192)
  assert.equal(result.transcript_summary, metadata.transcript_summary)
  assert.ok(result.analysis_warnings.includes('Some samples were missed.'))
})

function mockClient({ item, job } = {}) {
  const calls = []
  const client = {
    calls,
    async rpc(name, args) {
      calls.push({ name, args })
      if (name === 'claim_saved_item_metadata_job') return { data: job ? [job] : [], error: null }
      if (name === 'complete_saved_item_metadata_job_v2') return { data: true, error: null }
      if (name === 'fail_saved_item_metadata_job') return { data: 'retry_wait', error: null }
      throw new Error(`Unexpected RPC ${name}`)
    },
    from(table) {
      assert.equal(table, 'saved_items')
      const builder = {
        select() { return builder },
        eq() { return builder },
        async single() { return { data: item, error: null } },
      }
      return builder
    },
  }
  return client
}

const sampleJob = {
  job_id: 'job-1', item_id: 'item-1', user_id: 'user-1', media_version: 2,
  metadata_version: 4, claim_token: 'claim-1', attempts: 1, max_attempts: 5,
}
const sampleItem = {
  id: 'item-1', user_id: 'user-1', media_storage_key: '123e4567-e89b-12d3-a456-426614174000.mp4',
  media_version: 2, metadata_generation_version: 4, transcript_segments: [], ocr_frames: [],
}

test('processes one complete video timeline, sends ordered images to local Ollama, and stores versioned metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-metadata-success-'))
  await writeFile(path.join(root, sampleItem.media_storage_key), 'fixture-video')
  const client = mockClient({ item: sampleItem, job: sampleJob })
  const imageCalls = []
  try {
    const result = await processOneMetadataJob({
      client,
      env: {
        RECALL_MEDIA_DIR: root, OLLAMA_METADATA_MODEL: 'llava:7b', OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        VIDEO_METADATA_TRANSCRIPTION_ENABLED: 'false', VIDEO_METADATA_MAX_FRAMES: '6', VIDEO_METADATA_SAMPLE_INTERVAL_SECONDS: '4',
      },
      runCommand: async (command, args) => {
        if (command === 'ffprobe') return { stdout: JSON.stringify({ format: { duration: '16' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 }, { codec_type: 'audio', codec_name: 'aac' }] }), stderr: '' }
        if (args.includes('showinfo')) return { stdout: '', stderr: 'pts_time:4.2 pts_time:11.7' }
        await writeFile(args.at(-1), `frame-${args.at(-1)}`)
        return { stdout: '', stderr: '' }
      },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body)
        if (body.messages[1].images) {
          imageCalls.push(body.messages[1].images)
          return new Response(JSON.stringify({ message: { content: 'Chronological visual events across the sampled segment.' } }), { status: 200 })
        }
        const final = { ...generated, analysis_warnings: ['Speech transcription is disabled.'] }
        return new Response(JSON.stringify({ message: { content: JSON.stringify(final) } }), { status: 200 })
      },
    })
    assert.equal(result.status, 'partially_ready', result.error)
    assert.ok(imageCalls.length > 0)
    assert.ok(imageCalls.flat().length >= 4)
    const completion = client.calls.find(call => call.name === 'complete_saved_item_metadata_job_v2')
    assert.equal(completion.args.generated_summary, generated.summary)
    assert.equal(completion.args.generated_visual_summary, generated.visual_summary)
    assert.ok(completion.args.analysis_warnings.includes('Speech transcription is disabled.'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a concurrent edit closes the obsolete job without running inference', async () => {
  const client = mockClient({ item: { ...sampleItem, metadata_generation_version: 5 }, job: sampleJob })
  let modelCalled = false
  const result = await processOneMetadataJob({ client, fetchImpl: async () => { modelCalled = true } })
  assert.equal(result.status, 'superseded')
  assert.equal(modelCalled, false)
  assert.equal(client.calls.find(call => call.name === 'complete_saved_item_metadata_job_v2').args.generated_summary, '')
})

test('unavailable local model leaves saved item intact and records bounded retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-metadata-retry-'))
  await writeFile(path.join(root, sampleItem.media_storage_key), 'fixture-video')
  const client = mockClient({ item: sampleItem, job: sampleJob })
  try {
    const result = await processOneMetadataJob({
      client,
      env: { RECALL_MEDIA_DIR: root, OLLAMA_METADATA_MODEL: 'llava:7b', OLLAMA_BASE_URL: 'http://127.0.0.1:11434', VIDEO_METADATA_TRANSCRIPTION_ENABLED: 'false' },
      runCommand: async (command, args) => {
        if (command === 'ffprobe') return { stdout: JSON.stringify({ format: { duration: '8' }, streams: [{ codec_type: 'video' }] }), stderr: '' }
        if (args.includes('showinfo')) return { stdout: '', stderr: '' }
        await writeFile(args.at(-1), 'frame')
        return { stdout: '', stderr: '' }
      },
      fetchImpl: async () => { throw new Error('Ollama unavailable') },
    })
    assert.equal(result.status, 'retry_wait')
    assert.match(result.error, /Ollama unavailable/)
    assert.ok(client.calls.some(call => call.name === 'fail_saved_item_metadata_job'))
    assert.equal(client.calls.some(call => call.name === 'complete_saved_item_metadata_job_v2'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Ollama context rejection includes only its sanitized bounded error detail', async () => {
  await assert.rejects(generateVideoMetadata({
    transcript: '', visualSegments: [{ start: 0, end: 1, text: 'A simple visual scene.' }], model: 'local-vlm',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'request exceeds context size; token=abcdefghijklmnopqrstuvwxyz123456 and /Users/private/model' }), { status: 400 }),
  }), error => {
    assert.match(error.message, /HTTP 400/)
    assert.match(error.message, /exceeds context size/)
    assert.doesNotMatch(error.message, /abcdefghijklmnopqrstuvwxyz123456|\/Users\/private/)
    return true
  })
})

test('new migration is additive, preserves edit protection, and includes generated summary in EmbeddingGemma indexing', async () => {
  const migration = await readFile(new URL('../supabase/migrations/202610260002_video_timeline_analysis.sql', import.meta.url), 'utf8')
  const embeddingWorker = await readFile(new URL('../scripts/embeddinggemma2-worker.mjs', import.meta.url), 'utf8')
  assert.match(migration, /add column if not exists metadata_summary text not null default ''/)
  assert.match(migration, /complete_saved_item_metadata_job_v2/)
  assert.match(migration, /when not s\.metadata_title_user_edited then/)
  assert.match(migration, /row\(new\.title,new\.notes,new\.tags,new\.metadata_summary\)[\s\S]*?row\(old\.title,old\.notes,old\.tags,old\.metadata_summary\)/)
  assert.match(migration, /interval '90 minutes'/)
  assert.match(embeddingWorker, /metadata_summary/)
  assert.doesNotMatch(migration, /drop\s+table|delete\s+from\s+public\.saved_items/i)
})

test('UI and keyword-search status expose the generated timeline summary', async () => {
  const page = await readFile(new URL('../app/saved/page.tsx', import.meta.url), 'utf8')
  const library = await readFile(new URL('../app/saved/library.tsx', import.meta.url), 'utf8')
  const search = await readFile(new URL('../lib/saved-search.server.ts', import.meta.url), 'utf8')
  assert.match(page, /metadata_summary,metadata_transcript_summary,metadata_visual_summary/)
  assert.match(library, /item\.metadata_summary/)
  assert.match(library, /Visual timeline summary/)
  assert.match(search, /metadata_summary,metadata_transcript_summary,metadata_visual_summary/)
})
