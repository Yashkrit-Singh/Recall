import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationPath = new URL('../supabase/migrations/202610230007_fix_video_job_claim_ambiguity.sql', import.meta.url)
const workerPath = new URL('../scripts/video-worker.mjs', import.meta.url)

test('video claim migration qualifies media_version and preserves the worker RPC contract', async () => {
  const [migration, worker] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(workerPath, 'utf8'),
  ])
  const functionMatch = migration.match(/create or replace function public\.claim_video_processing_job\(worker_name text\)([\s\S]*?)\$\$;/i)
  assert.ok(functionMatch, 'migration must replace the existing claim RPC')
  const definition = functionMatch[1]
  const returnMatch = definition.match(/returns table\(([\s\S]*?)\)\s*language/i)
  assert.ok(returnMatch, 'claim RPC must retain its table return type')
  const returnedFields = returnMatch[1].split(',').map(field => field.trim().split(/\s+/)[0])
  assert.deepEqual(returnedFields, ['job_id', 'item_id', 'user_id', 'media_version', 'storage_key', 'claim_token', 'attempts', 'max_attempts'])

  for (const field of ['job_id', 'item_id', 'media_version', 'storage_key', 'claim_token']) {
    assert.match(worker, new RegExp(`job\\.${field}\\b`), `worker must consume the ${field} result field`)
  }

  assert.match(definition, /where s\.id\s*=\s*picked\.item_id\s+and s\.media_version\s*=\s*picked\.media_version/i)
  assert.doesNotMatch(definition, /\bwhere\s+(?:id|media_version)\s*=/i, 'table columns in predicates must not be unqualified')
  assert.match(definition, /for update skip locked/i, 'claim must retain concurrent-worker locking')
  assert.match(definition, /attempts\s*=\s*j\.attempts\s*\+\s*1/i, 'claim must continue incrementing attempts')
  assert.match(definition, /locked_until\s*=\s*now\(\)\s*\+\s*interval\s+'15 minutes'/i, 'claim must retain its lease')
})
