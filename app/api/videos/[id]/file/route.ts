import { NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to open this video.' }, { status: 401 })
  const { id } = await params
  const { data: item, error } = await supabase.from('saved_items')
    .select('media_storage_key,media_mime_type,title')
    .eq('id', id).single()
  if (error || !item?.media_storage_key || !/^[0-9a-f-]{36}\.(mp4|mov|webm)$/.test(item.media_storage_key)) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 })
  }
  const filePath = path.join(path.resolve(process.env.RECALL_MEDIA_DIR || '.local-media'), item.media_storage_key)
  try {
    const info = await stat(filePath)
    const headers = {
      'Content-Type': item.media_mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${id}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    }
    const range = request.headers.get('range')
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/)
      const start = match?.[1] ? Number(match[1]) : 0
      const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
      if (!match || start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
      const stream = createReadStream(filePath, { start, end })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${info.size}` },
      })
    }
    const stream = createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { ...headers, 'Content-Length': String(info.size) } })
  } catch {
    return NextResponse.json({ error: 'The local video file is unavailable on this machine.' }, { status: 404 })
  }
}
