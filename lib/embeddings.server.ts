import 'server-only'

export {
  createEmbedding,
  createEmbeddings,
  embeddingSetupMessage,
  EMBEDDING_MODEL,
  getEmbeddingModel,
  getEmbeddingProvider,
  savedItemEmbeddingText,
  vectorLiteral,
} from './embedding-provider.mjs'
export type { EmbeddingProvider, EmbeddingPurpose } from './embedding-provider.mjs'
