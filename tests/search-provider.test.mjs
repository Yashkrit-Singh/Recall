import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNomicWorkerEnabled } from '../scripts/embedding-worker.mjs'

test('legacy Nomic worker refuses to create vectors when EmbeddingGemma is selected by default', () => {
  assert.throws(() => assertNomicWorkerEnabled('embeddinggemma2'), /inactive.*worker:multimodal/i)
})

test('legacy Nomic worker runs only when Nomic is explicitly selected', () => {
  assert.doesNotThrow(() => assertNomicWorkerEnabled('nomic'))
})

test('unsupported search providers fail closed', () => {
  assert.throws(() => assertNomicWorkerEnabled('unknown'), /must be either/i)
})
