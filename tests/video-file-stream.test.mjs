import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createFileWebStream } from '../lib/local-file-stream.mjs'

test('file web stream sends the complete file and supports range reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-file-stream-'))
  try {
    const filename = path.join(root, 'clip.mp4')
    const content = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
    await writeFile(filename, content)
    const full = await new Response(createFileWebStream(filename)).arrayBuffer()
    assert.deepEqual(Buffer.from(full), content)
    const range = await new Response(createFileWebStream(filename, { start: 5, end: 13 })).arrayBuffer()
    assert.deepEqual(Buffer.from(range), content.subarray(5, 14))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('canceling a file response stops its reader without closing an already canceled controller', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-file-cancel-'))
  try {
    const filename = path.join(root, 'clip.mp4')
    await writeFile(filename, Buffer.alloc(4 * 1024 * 1024, 42))
    const reader = createFileWebStream(filename, { highWaterMark: 16 * 1024 }).getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    await reader.cancel('browser disconnected')
    await new Promise(resolve => setTimeout(resolve, 30))
  } finally { await rm(root, { recursive: true, force: true }) }
})
