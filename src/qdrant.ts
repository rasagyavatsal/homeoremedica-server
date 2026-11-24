/**
 * Hybrid search over the Qdrant materia medica collections, one collection per book.
 *
 * The collections are built by the homeoremedica-private repository: each chunk has a
 * voyage-4 dense vector and a BM25 sparse vector. Rankings are fused with reciprocal-rank fusion
 * the same way as that repository's `scripts/search.py`, which its retrieval evaluation measures.
 * Qdrant encodes the BM25 query itself with the same model that indexed the collections.
 *
 * Each book is searched on its own and gives its best passages, so an answer can give every book
 * a section of its own.
 */

import type { BookSummary, RetrievedSource } from './contracts.ts'
import { ProviderError, isTimeout } from './errors.ts'
import { type Fetch, isRecord, readJson, send } from './http.ts'

export const DENSE_VECTOR = 'dense'
export const SPARSE_VECTOR = 'bm25'
export const SPARSE_MODEL = 'qdrant/bm25'
// Each ranking contributes this many candidates per requested passage before fusion: 16 for the
// two passages each book gives an answer.
export const PREFETCH_MULTIPLIER = 8
// The standard reciprocal-rank fusion constant: a ranking adds 1 / (RRF_K + rank) to each point.
export const RRF_K = 60
export const QDRANT_TIMEOUT_MS = 30_000
const LABEL = 'Qdrant'

export interface SearchOptions {
  /** How many passages each book gives. */
  limit: number
}

// Book IDs are the books' Qdrant collection names.
export const BOOKS: readonly BookSummary[] = [
  { bookId: 'allen_keynotes', title: 'Allen, Keynotes and Characteristics', author: 'H. C. Allen' },
  { bookId: 'allen_nosodes', title: 'Allen, The Materia Medica of the Nosodes', author: 'H. C. Allen' },
  { bookId: 'boericke_mm', title: 'Boericke, Homoeopathic Materia Medica', author: 'William Boericke' },
  { bookId: 'clarke_mm', title: 'Clarke, A Dictionary of Practical Materia Medica', author: 'John Henry Clarke' },
  { bookId: 'hahnemann_mm_pura', title: 'Hahnemann, Materia Medica Pura', author: 'Samuel Hahnemann' },
  { bookId: 'hahnemann_organon', title: 'Hahnemann, Organon of Medicine', author: 'Samuel Hahnemann' },
  { bookId: 'kent_lectures', title: 'Kent, Lectures on Homoeopathic Materia Medica', author: 'James Tyler Kent' },
]

/** A Qdrant collection is missing or unreachable, or a search of the collections failed. */
export class CorpusError extends Error {
  override name = 'CorpusError'
}

type PointId = string | number

interface Candidate {
  id: PointId
  score: number
}

export class QdrantCorpus {
  readonly #baseUrl: string
  readonly #bookIds: readonly string[]
  readonly #headers: Record<string, string>
  readonly #fetch: Fetch
  readonly #timeoutMs: number

  constructor({
    url,
    apiKey,
    bookIds = BOOKS.map((book) => book.bookId),
    fetch: fetchImpl = fetch,
    timeoutMs = QDRANT_TIMEOUT_MS,
  }: {
    url: string
    apiKey?: string | undefined
    bookIds?: readonly string[]
    fetch?: Fetch
    timeoutMs?: number
  }) {
    this.#baseUrl = `${url.replace(/\/+$/, '')}/collections/`
    this.#bookIds = bookIds
    this.#headers = { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) }
    this.#fetch = fetchImpl
    this.#timeoutMs = timeoutMs
  }

  async verify(): Promise<void> {
    const missing: string[] = []
    try {
      await Promise.all(
        this.#bookIds.map(async (bookId) => {
          const parsed = await readJson(await this.#request(bookId, '/exists', { method: 'GET' }), LABEL)
          if (!(isRecord(parsed) && isRecord(parsed.result) && parsed.result.exists === true)) missing.push(bookId)
        }),
      )
    } catch (error) {
      throw new CorpusError(`could not reach Qdrant: ${error instanceof Error ? error.name : 'error'}`, {
        cause: error,
      })
    }
    if (missing.length) {
      throw new CorpusError(`Qdrant collections ${missing.sort().map((name) => JSON.stringify(name)).join(', ')} do not exist`)
    }
  }

  /**
   * The best `limit` passages of each book, book by book. The repertories' and Clarke's rankings are
   * not weighed in: an answer gives them sections of their own, so the passages stay the books' own
   * view of the case.
   */
  async search(query: string, embedding: readonly number[], { limit }: SearchOptions): Promise<RetrievedSource[]> {
    try {
      const books = await Promise.all(this.#bookIds.map((bookId) => this.#passages(bookId, query, embedding, limit)))
      return books.flat()
    } catch (error) {
      // A failed search is not the chat provider's failure, so it is not reported as one.
      if (isTimeout(error)) throw error
      throw new CorpusError(`Qdrant search failed: ${error instanceof Error ? error.message : 'error'}`, { cause: error })
    }
  }

  /** One book's best `limit` passages, its dense and BM25 rankings fused. */
  async #passages(bookId: string, query: string, embedding: readonly number[], limit: number): Promise<RetrievedSource[]> {
    const fused = new Map<PointId, number>()
    for (const ranking of await this.#rank(bookId, query, embedding, limit * PREFETCH_MULTIPLIER)) {
      for (const [position, { id }] of ranking.entries()) fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + position + 1))
    }
    const best = [...fused].sort((a, b) => b[1] - a[1]).slice(0, limit)
    if (!best.length) return []
    const payloads = await this.#payloads(bookId, best.map(([id]) => id))
    return best.map(([id, score]) => {
      const payload = payloads.get(id)
      if (!payload) throw new ProviderError('Qdrant returned no payload for a query point')
      return toSource(bookId, payload, score)
    })
  }

  /** One collection's dense and BM25 candidates, best first. */
  async #rank(
    bookId: string,
    query: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<[Candidate[], Candidate[]]> {
    const response = await this.#request(bookId, '/points/query/batch', {
      method: 'POST',
      body: JSON.stringify({
        searches: [
          { query: embedding, using: DENSE_VECTOR, limit, with_payload: false, with_vector: false },
          {
            query: { text: query, model: SPARSE_MODEL },
            using: SPARSE_VECTOR,
            limit,
            with_payload: false,
            with_vector: false,
          },
        ],
      }),
    })
    const parsed = await readJson(response, LABEL)
    const results = isRecord(parsed) ? parsed.result : undefined
    if (!Array.isArray(results) || results.length !== 2) throw new ProviderError('Qdrant returned no query points')
    const [dense, sparse] = results.map((result) => {
      const points = isRecord(result) ? result.points : undefined
      if (!Array.isArray(points)) throw new ProviderError('Qdrant returned no query points')
      return points.map((point) => {
        if (!isRecord(point) || !isPointId(point.id) || typeof point.score !== 'number') {
          throw new ProviderError('Qdrant returned an invalid point')
        }
        return { id: point.id, score: point.score }
      })
    })
    return [dense!, sparse!]
  }

  /** The payloads of one collection's given points, by id. */
  async #payloads(bookId: string, ids: readonly PointId[]): Promise<Map<PointId, Record<string, unknown>>> {
    const response = await this.#request(bookId, '/points', {
      method: 'POST',
      body: JSON.stringify({ ids, with_payload: true, with_vector: false }),
    })
    const parsed = await readJson(response, LABEL)
    const points = isRecord(parsed) ? parsed.result : undefined
    if (!Array.isArray(points)) throw new ProviderError('Qdrant returned no points')
    const payloads = new Map<PointId, Record<string, unknown>>()
    for (const point of points) {
      if (!isRecord(point) || !isPointId(point.id)) throw new ProviderError('Qdrant returned an invalid point')
      payloads.set(point.id, isRecord(point.payload) ? point.payload : {})
    }
    return payloads
  }

  async #request(bookId: string, path: string, init: RequestInit): Promise<Response> {
    const response = await send(
      this.#fetch,
      this.#baseUrl + encodeURIComponent(bookId) + path,
      { ...init, headers: this.#headers },
      { label: LABEL, timeoutMs: this.#timeoutMs },
    )
    if (!response.ok) throw new ProviderError(`${LABEL} request failed with status ${response.status}`)
    return response
  }
}

function isPointId(value: unknown): value is PointId {
  return typeof value === 'string' || Number.isInteger(value)
}

function toSource(bookId: string, payload: Record<string, unknown>, score: number): RetrievedSource {
  const group = typeof payload.section_group === 'string' ? payload.section_group : ''
  const sections = [
    ...(Array.isArray(payload.sections) ? payload.sections : []).filter(
      (section): section is string => typeof section === 'string' && section !== group,
    ),
    ...aphorismLabel(payload.aphorisms),
  ].join('; ')
  return {
    chunkId: requiredText(payload, 'chunk_id'),
    bookId,
    bookTitle: requiredText(payload, 'source_title'),
    author: typeof payload.author === 'string' ? payload.author : null,
    // The Organon describes principles, not remedies, so its chunks have none.
    remedyName: typeof payload.remedy === 'string' ? payload.remedy : null,
    sectionTitle: group && sections ? `${group}: ${sections}` : group || sections,
    passageIndexes: [requiredInteger(payload, 'chunk_index')],
    text: requiredText(payload, 'content'),
    score,
  }
}

/** `§ 5` or `§§ 28–29` for the Organon aphorisms a chunk covers. */
function aphorismLabel(value: unknown): string[] {
  const aphorisms = (Array.isArray(value) ? value : []).filter((number) => Number.isInteger(number)) as number[]
  if (!aphorisms.length) return []
  if (aphorisms.length === 1) return [`§ ${aphorisms[0]}`]
  const consecutive = aphorisms.every((number, index) => index === 0 || number === aphorisms[index - 1]! + 1)
  return [`§§ ${consecutive ? `${aphorisms[0]}–${aphorisms.at(-1)}` : aphorisms.join(', ')}`]
}

function requiredText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  throw new ProviderError(`Qdrant point payload has no ${key}`)
}

function requiredInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  if (Number.isInteger(value)) return value as number
  throw new ProviderError(`Qdrant point payload has no integer ${key}`)
}
