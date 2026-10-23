import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { validateVideoUpload } from '@/lib/video-validation.mjs'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
const runFile = promisify(execFile)
const maxBytes = Number(process.env.RECALL_VIDEO_MAX_BYTES || 100 * 1024 * 1024)
const maxDuration = Number(process.env.RECALL_VIDEO_MAX_DURATION_SECONDS || 600)

function formRedirect(request: Request, key: 'uploaded' | 'error', value: string) {
  const url = new URL('/saved', request.url)
  url.searchParams.set(key, value)
  return NextResponse.redirect(url, { status: 303 })
}

export async function POST(request: Request) {
  const browserForm = request.headers.get('accept')?.includes('text/html') ?? false
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return browserForm
    ? formRedirect(request, 'error', 'Sign in to upload a video.')
    : NextResponse.json({ error: 'Sign in to upload a video.' }, { status: 401 })

  let filePath: string | undefined
  let tempPath: string | undefined
  try {
    const form = await request.formData()
    const file = form.get('video')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a video file to upload.' }, { status: 400 })
    const extension = validateVideoUpload({ filename: file.name, mimeType: file.type, size: file.size, maxBytes })
    const id = randomUUID()
    const storageKey = `${id}${extension}`
    const directory = path.resolve(process.env.RECALL_MEDIA_DIR || '.local-media')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    tempPath = path.join(directory, `${id}.upload`)
    filePath = path.join(directory, storageKey)
    const bytes = Buffer.from(await file.arrayBuffer())
    await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 })
    const { stdout } = await runFile(process.env.FFPROBE_BIN || 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', tempPath,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 })
    const mediaInfo = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> }
    const duration = Number(mediaInfo.format?.duration)
    if (!mediaInfo.streams?.some(stream => stream.codec_type === 'video')) {
      await rm(tempPath, { force: true })
      return NextResponse.json({ error: 'The selected file does not contain a video stream.' }, { status: 400 })
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > maxDuration) {
      await rm(tempPath, { force: true })
      return NextResponse.json({ error: `Video duration must be under ${Math.floor(maxDuration / 60)} minutes.` }, { status: 400 })
    }
    await rename(tempPath, filePath)
    tempPath = undefined

    const title = String(form.get('title') || '').trim().slice(0, 180) || path.basename(file.name, path.extname(file.name)).slice(0, 180) || 'Uploaded video'
    const description = String(form.get('description') || '').trim().slice(0, 8000)
    const tags = String(form.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20)
    const { data: itemId, error } = await supabase.rpc('create_saved_video_with_job', {
      target_source_url: 'http://recall.local/uploaded-video',
      target_title: title,
      target_notes: description,
      target_tags: tags,
      target_storage_key: storageKey,
      target_original_name: path.basename(file.name).slice(0, 255),
      target_mime_type: file.type,
      target_size_bytes: file.size,
      target_duration_seconds: duration,
    })
    if (error || !itemId) throw new Error('Could not queue the uploaded video. Confirm the Stage 3 database migration is applied.')
    return browserForm
      ? formRedirect(request, 'uploaded', '1')
      : NextResponse.json({ id: itemId, status: 'pending' }, { status: 201 })
  } catch (error) {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined)
    if (filePath) await rm(filePath, { force: true }).catch(() => undefined)
    const message = error instanceof Error ? error.message : 'Video upload failed.'
    const safeMessage = message.includes('ENOENT') ? 'FFprobe is unavailable. Install FFmpeg and make sure ffprobe is on PATH.' : message
    return browserForm
      ? formRedirect(request, 'error', safeMessage)
      : NextResponse.json({ error: safeMessage }, { status: 400 })
  }
}
