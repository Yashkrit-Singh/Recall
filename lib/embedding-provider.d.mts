export type EmbeddingPurpose = 'document' | 'query'
export type EmbeddingProvider = 'ollama' | 'openai'

export function getEmbeddingProvider(): EmbeddingProvider
export function getEmbeddingModel(): string
export const EMBEDDING_MODEL: string
export function embeddingSetupMessage(): string
export function savedItemEmbeddingText(item: { title: string; notes: string; tags: string[] }): string
export function createEmbeddings(inputs: string[], purpose?: EmbeddingPurpose): Promise<number[][]>
export function createEmbedding(input: string, purpose?: EmbeddingPurpose): Promise<number[]>
export function vectorLiteral(vector: number[]): string
