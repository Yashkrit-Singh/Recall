const EMBEDDING_DIMENSIONS = 768

/** @typedef {'document' | 'query'} EmbeddingPurpose */
/** @typedef {'ollama' | 'openai'} EmbeddingProvider */

/** @returns {EmbeddingProvider} */
export function getEmbeddingProvider() {
  const value = (process.env.EMBEDDING_PROVIDER ?? 'ollama').trim().toLowerCase()
  if (value === 'ollama' || value === 'openai') return value
  throw new Error('EMBEDDING_PROVIDER must be either "ollama" or "openai".')
}

export function getEmbeddingModel() {
  return getEmbeddingProvider() === 'ollama'
    ? (process.env.OLLAMA_EMBEDDING_MODEL?.trim() || 'nomic-embed-text')
    : 'text-embedding-3-small'
}

export const EMBEDDING_MODEL = getEmbeddingModel()

export function embeddingSetupMessage() {
  if (getEmbeddingProvider() === 'ollama') return ''
  return process.env.OPENAI_API_KEY
    ? ''
    : 'Add OPENAI_API_KEY to .env.local when EMBEDDING_PROVIDER=openai.'
}

/** @param {{title: string, notes: string, tags: string[], extracted_text?: string | null}} item */
export function savedItemEmbeddingText(item) {
  return [
    `Title: ${item.title.trim()}`,
    `Description: ${item.notes.trim()}`,
    `Tags: ${item.tags.join(', ')}`,
    item.extracted_text?.trim() ? `Extracted video content: ${item.extracted_text.trim()}` : '',
  ].filter(Boolean).join('\n').slice(0, 24_000)
}

/** @param {string[]} inputs @param {EmbeddingPurpose} purpose */
async function createOllamaEmbeddings(inputs, purpose) {
  const baseUrl = (process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434').replace(/\/+$/, '')
  const model = getEmbeddingModel()
  const prefixedInputs = inputs.map(input => `${purpose === 'query' ? 'search_query' : 'search_document'}: ${input}`)
  let response
  try {
    response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: prefixedInputs, truncate: true }),
      cache: 'no-store',
      signal: AbortSignal.timeout(120_000),
    })
  } catch {
    throw new Error(`Could not reach Ollama at ${baseUrl}. Start Ollama and make sure it is listening on port 11434.`)
  }

  if (!response.ok) {
    const details = await response.json().catch(() => null)
    if (response.status === 404 || details?.error?.toLowerCase().includes('model')) {
      throw new Error(`Ollama model "${model}" is not installed. Run: ollama pull ${model}`)
    }
    throw new Error(`Ollama could not generate embeddings (HTTP ${response.status}). ${details?.error ?? 'Check that Ollama is running and the model is available.'}`)
  }

  const payload = await response.json()
  const vectors = payload.embeddings
  if (!vectors || vectors.length !== inputs.length || vectors.some(vector => vector.length !== EMBEDDING_DIMENSIONS || vector.some(value => !Number.isFinite(value)))) {
    throw new Error(`Ollama returned an unexpected embedding. The selected model must produce ${EMBEDDING_DIMENSIONS} dimensions for the current Supabase schema.`)
  }
  return vectors
}

/** @param {string[]} inputs */
async function createOpenAIEmbeddings(inputs) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Add OPENAI_API_KEY to .env.local when EMBEDDING_PROVIDER=openai.')
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: inputs, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' }),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`The embedding service could not process this request (HTTP ${response.status}).`)
  const payload = await response.json()
  const vectors = payload.data?.map(item => item.embedding)
  if (!vectors || vectors.length !== inputs.length || vectors.some(vector => !vector || vector.length !== EMBEDDING_DIMENSIONS || vector.some(value => !Number.isFinite(value)))) {
    throw new Error('The embedding service returned an unexpected vector.')
  }
  return vectors
}

/** @param {string[]} inputs @param {EmbeddingPurpose} [purpose] */
export async function createEmbeddings(inputs, purpose = 'document') {
  if (!inputs.length) return []
  return getEmbeddingProvider() === 'ollama'
    ? createOllamaEmbeddings(inputs, purpose)
    : createOpenAIEmbeddings(inputs)
}

/** @param {string} input @param {EmbeddingPurpose} [purpose] */
export async function createEmbedding(input, purpose = 'document') {
  return (await createEmbeddings([input], purpose))[0]
}

/** @param {number[]} vector */
export function vectorLiteral(vector) {
  return `[${vector.join(',')}]`
}
