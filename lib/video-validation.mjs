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

const normalizeOcrText = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function textSimilarity(left, right) {
  const a = normalizeOcrText(left)
  const b = normalizeOcrText(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLength = Math.max(a.length, b.length)
  if (maxLength > 1200) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return 1 - previous[b.length] / maxLength
}

export function deduplicateOcrFrames(frames, { maxGapSeconds = 4, similarityThreshold = 0.9 } = {}) {
  const accepted = []
  for (const frame of frames) {
    const text = String(frame.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const repeated = [...accepted].reverse().some(previous => {
      const gap = Number(frame.time) - Number(previous.time)
      return gap >= 0 && gap <= maxGapSeconds && textSimilarity(previous.text, text) >= similarityThreshold
    })
    if (repeated) continue
    accepted.push({ ...frame, text })
  }
  return accepted
}

export function parseTesseractTsv(tsv, { minConfidence = 80, minWordHeight = 0 } = {}) {
  const [header, ...rows] = String(tsv || '').split(/\r?\n/).filter(Boolean)
  if (!header) return { words: [], lines: [], acceptedText: '' }
  const columns = header.split('\t')
  const indexes = Object.fromEntries(columns.map((name, index) => [name, index]))
  const groups = new Map()
  const words = []
  for (const row of rows) {
    const cells = row.split('\t')
    if (cells.length < columns.length || cells[indexes.level] !== '5') continue
    const text = String(cells[indexes.text] || '').trim()
    const confidence = Number(cells[indexes.conf])
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue
    const visible = Array.from(text.replace(/\s/g, ''))
    const alphanumeric = text.match(/[\p{L}\p{N}]/gu) || []
    const quality = visible.length ? alphanumeric.length / visible.length : 0
    const wordHeight = Number(cells[indexes.height])
    const accepted = confidence >= minConfidence && wordHeight >= minWordHeight && quality >= 0.75
    const word = {
      text,
      confidence: Math.round(confidence * 10) / 10,
      box: { left: Number(cells[indexes.left]), top: Number(cells[indexes.top]), width: Number(cells[indexes.width]), height: Number(cells[indexes.height]) },
      accepted,
      rejectedReason: accepted ? null : confidence < minConfidence ? 'low_confidence' : wordHeight < minWordHeight ? 'too_small' : 'mostly_non_text_characters',
    }
    words.push(word)
    if (!accepted) continue
    const key = [cells[indexes.page_num], cells[indexes.block_num], cells[indexes.par_num], cells[indexes.line_num]].join(':')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(word)
  }
  const lines = [...groups.values()].map(lineWords => ({
    text: lineWords.map(word => word.text).join(' '),
    meanConfidence: Math.round(lineWords.reduce((sum, word) => sum + word.confidence, 0) / lineWords.length * 10) / 10,
  })).filter(line => line.text)
  return { words, lines, acceptedText: lines.map(line => line.text).join('\n') }
}
