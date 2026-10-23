export const VIDEO_TYPES = new Map([
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
])

export function validateVideoUpload({ filename, mimeType, size, maxBytes = 100 * 1024 * 1024 }) {
  const extension = VIDEO_TYPES.get(mimeType)
  if (!extension || !filename.toLowerCase().endsWith(extension)) {
    throw new Error('Upload an MP4, MOV, or WebM video file.')
  }
  if (!Number.isFinite(size) || size < 1 || size > maxBytes) {
    throw new Error(`Video must be smaller than ${Math.floor(maxBytes / 1024 / 1024)} MB.`)
  }
  return extension
}

export function deduplicateOcrFrames(frames) {
  const seen = new Set()
  return frames.filter(frame => {
    const normalized = String(frame.text || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!normalized || normalized.length < 2 || seen.has(normalized)) return false
    seen.add(normalized)
    frame.text = normalized
    return true
  })
}
