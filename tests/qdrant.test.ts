import { describe, expect, it } from 'vitest'

import { VOYAGE_DIMENSIONS, VoyageQueryEmbedder } from '../src/embeddings.ts'
import { BOOKS, CorpusError, QdrantCorpus } from '../src/qdrant.ts'
import { ProviderTimeoutError } from '../src/errors.ts'
import { fakeFetch, json, timeout } from './fakes.ts'

const PAYLOAD = {
  chunk_id: 'clarke-00042',
  source: 'clarke',
  source_title: 'Clarke, A Dictionary of Practical Materia Medica',
  author: 'John Henry Clarke',
  remedy: 'Nux Vomica',
  section_group: 'Symptoms',
  sections: ['Mind', 'Head'],
  chunk_index: 3,
  content: 'Irritable, oversensitive to noise.',
  text: 'Clarke > Nux Vomica > Mind; Head\n\nIrritable, oversensitive to noise.',
}

type RankedPoint = [id: string | number, score: number]
const ranked = (...points: RankedPoint[]) => ({ points: points.map(([id, score]) => ({ id, score })) })
const rankings = (dense: RankedPoint[], sparse: RankedPoint[]) =>
  json({ result: [ranked(...dense), ranked(...sparse)], status: 'ok' })
const records = (...points: [id: string | number, payload: Record<string, unknown>][]) =>
  json({ result: points.map(([id, payload]) => ({ id, payload })), status: 'ok' })

const corpus = (fetch: ReturnType<typeof fakeFetch>, bookIds = ['clarke_mm']) =>
  new QdrantCorpus({ url: 'https://qdrant.example/', apiKey: 'qdrant-key', bookIds, fetch })

/** Search one book whose only match has the given payload. */
const searchOne = (payload: Record<string, unknown>) =>
  corpus(fakeFetch(rankings([['p', 0.5]], []), records(['p', payload]))).search('question', [1.0], { limit: 1 })

describe('Qdrant corpus', () => {
  it("gives each book's best passages, its dense and BM25 rankings fused, book by book", async () => {
    const replies: Record<string, Response> = {
      'clarke_mm/points/query/batch': rankings([['c1', 0.9], ['c2', 0.5], ['c3', 0.4]], [['c2', 3]]),
      'kent_lectures/points/query/batch': rankings([['k1', 0.7]], []),
      'clarke_mm/points': records(['c1', { ...PAYLOAD, chunk_id: 'clarke-00001' }], ['c2', PAYLOAD]),
      'kent_lectures/points': records(['k1', { ...PAYLOAD, chunk_id: 'kent-00001', source_title: 'Kent', remedy: 'Sulphur' }]),
    }
    // The books are searched at once, so each request gets its collection's reply.
    const recorder = fakeFetch(...Object.keys(replies).map(() => json({})))
    const fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        await recorder(url, init)
        return replies[String(url).replace('https://qdrant.example/collections/', '')]!
      },
      { calls: recorder.calls },
    )

    const sources = await corpus(fetch, ['clarke_mm', 'kent_lectures']).search('irritability', [0.1, 0.2], { limit: 2 })

    expect(fetch.calls.map((call) => call.url.replace('https://qdrant.example/collections/', '')).sort()).toEqual(
      Object.keys(replies).sort(),
    )
    expect(fetch.calls.every((call) => call.method === 'POST' && call.headers['api-key'] === 'qdrant-key')).toBe(true)
    expect(fetch.calls.find((call) => call.url.endsWith('clarke_mm/points/query/batch'))?.body).toEqual({
      searches: [
        { query: [0.1, 0.2], using: 'dense', limit: 16, with_payload: false, with_vector: false },
        {
          query: { text: 'irritability', model: 'qdrant/bm25' },
          using: 'bm25',
          limit: 16,
          with_payload: false,
          with_vector: false,
        },
      ],
    })
    expect(fetch.calls.find((call) => call.url.endsWith('clarke_mm/points'))?.body).toEqual({
      ids: ['c2', 'c1'],
      with_payload: true,
      with_vector: false,
    })
    // c2 is second in Clarke's dense ranking and tops its BM25 one; c3 is cut.
    expect(sources.map((source) => [source.bookId, source.chunkId, source.score])).toEqual([
      ['clarke_mm', 'clarke-00042', 1 / 62 + 1 / 61],
      ['clarke_mm', 'clarke-00001', 1 / 61],
      ['kent_lectures', 'kent-00001', 1 / 61],
    ])
    expect(sources[0]).toEqual({
      chunkId: 'clarke-00042',
      bookId: 'clarke_mm',
      bookTitle: 'Clarke, A Dictionary of Practical Materia Medica',
      author: 'John Henry Clarke',
      remedyName: 'Nux Vomica',
      sectionTitle: 'Symptoms: Mind; Head',
      passageIndexes: [3],
      text: 'Irritable, oversensitive to noise.',
      score: 1 / 62 + 1 / 61,
    })
  })

  it('gives nothing for a book with no match, without fetching passages', async () => {
    const fetch = fakeFetch(rankings([], []))

    expect(await corpus(fetch).search('question', [1.0], { limit: 2 })).toEqual([])
    expect(fetch.calls).toHaveLength(1)
  })

  it.each([
    [{ section_group: 'Mind', sections: ['Mind'] }, 'Mind'],
    [{ section_group: null, sections: ['Mind', 'Head'] }, 'Mind; Head'],
    [{ section_group: null, sections: null }, ''],
    [{ section_group: 'Organon of Medicine', sections: [], aphorisms: [28, 29] }, 'Organon of Medicine: §§ 28–29'],
    [{ section_group: 'Organon of Medicine', sections: [], aphorisms: [5] }, 'Organon of Medicine: § 5'],
    [{ section_group: null, sections: ['Notes'], aphorisms: [3, 7] }, 'Notes; §§ 3, 7'],
  ])('builds section titles from %j', async (sections, title) => {
    const [source] = await searchOne({ ...PAYLOAD, ...sections })

    expect(source?.sectionTitle).toBe(title)
  })

  it('accepts passages without a remedy', async () => {
    const [source] = await searchOne({ ...PAYLOAD, remedy: null })

    expect(source?.remedyName).toBeNull()
  })

  it('rejects points without required payload fields', async () => {
    const { chunk_id: _, ...payload } = PAYLOAD

    await expect(searchOne(payload)).rejects.toThrow(/chunk_id/)
  })

  it('rejects ranked points that have no stored payload', async () => {
    const fetch = fakeFetch(rankings([['p', 0.5]], []), records())

    await expect(corpus(fetch).search('question', [1.0], { limit: 1 })).rejects.toThrow(/no payload/)
  })

  it('raises corpus errors without the response body', async () => {
    const fetch = fakeFetch(new Response('provider secret', { status: 500 }))

    const error = await corpus(fetch)
      .search('question', [1.0], { limit: 1 })
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(CorpusError)
    expect(String(error)).not.toContain('provider secret')
  })

  it('leaves a search timeout as a timeout', async () => {
    await expect(corpus(fakeFetch(timeout())).search('question', [1.0], { limit: 1 })).rejects.toThrow(
      ProviderTimeoutError,
    )
  })

  it('searches every book by default', () => {
    expect(BOOKS.map((book) => book.bookId)).toEqual([
      'allen_keynotes',
      'allen_nosodes',
      'boericke_mm',
      'clarke_mm',
      'hahnemann_mm_pura',
      'hahnemann_organon',
      'kent_lectures',
    ])
  })

  it('verifies that every book collection exists', async () => {
    const fetch = fakeFetch(json({ result: { exists: true } }), json({ result: { exists: true } }))

    await corpus(fetch, ['clarke_mm', 'kent_lectures']).verify()

    expect(fetch.calls.map((call) => call.url)).toEqual([
      'https://qdrant.example/collections/clarke_mm/exists',
      'https://qdrant.example/collections/kent_lectures/exists',
    ])
  })

  it.each([
    [[json({ result: { exists: true } }), json({ result: { exists: false } })], '"kent_lectures" do not exist'],
    [[new TypeError('secret host')], 'could not reach'],
    [[json({ result: { exists: true } }), new Response('secret host', { status: 403 })], 'could not reach'],
  ])('reports missing or unreachable collections', async (responses, message) => {
    const error = await corpus(fakeFetch(...responses), ['clarke_mm', 'kent_lectures'])
      .verify()
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(CorpusError)
    expect(String(error)).toContain(message)
    expect(String(error)).not.toContain('secret host')
  })
})

describe('voyage query embedder', () => {
  const embedder = (fetch: ReturnType<typeof fakeFetch>) =>
    new VoyageQueryEmbedder({ apiKey: 'key', fetch, sleep: async () => {} })

  it('requests voyage query vectors and retries transient failures', async () => {
    const vector = Array(VOYAGE_DIMENSIONS).fill(0.5)
    const fetch = fakeFetch(json({}, 429), json({ data: [{ index: 0, embedding: vector }] }))

    const embedding = await embedder(fetch).embedQuery('question')

    expect(embedding).toEqual(vector)
    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls[0]?.url).toBe('https://openrouter.ai/api/v1/embeddings')
    expect(fetch.calls[0]?.headers.Authorization).toBe('Bearer key')
    expect(fetch.calls[0]?.body).toEqual({
      model: 'voyageai/voyage-4',
      input: ['question'],
      input_type: 'query',
      dimensions: VOYAGE_DIMENSIONS,
      encoding_format: 'float',
    })
  })

  it('embeds several queries in one request, in input order', async () => {
    const [first, second] = [Array(VOYAGE_DIMENSIONS).fill(0.1), Array(VOYAGE_DIMENSIONS).fill(0.2)]
    const fetch = fakeFetch(json({ data: [{ index: 1, embedding: second }, { index: 0, embedding: first }] }))

    expect(await embedder(fetch).embedQueries(['one', 'two'])).toEqual([first, second])
    expect(fetch.calls[0]?.body).toMatchObject({ input: ['one', 'two'] })
  })

  it('rejects a missing embedding', async () => {
    const fetch = fakeFetch(json({ data: [{ index: 0, embedding: Array(VOYAGE_DIMENSIONS).fill(0.1) }] }))

    await expect(embedder(fetch).embedQueries(['one', 'two'])).rejects.toThrow(/one embedding per input/)
  })

  it('gives up after three attempts', async () => {
    const fetch = fakeFetch(json({}, 503), json({}, 503), json({}, 503))

    await expect(embedder(fetch).embedQuery('question')).rejects.toThrow(/status 503/)
    expect(fetch.calls).toHaveLength(3)
  })

  it('rejects wrong dimensions', async () => {
    const fetch = fakeFetch(json({ data: [{ embedding: [0.1, 0.2] }] }))

    await expect(embedder(fetch).embedQuery('question')).rejects.toThrow(/1024 dimensions/)
  })

  it('classifies timeouts without exposing details', async () => {
    const error = await embedder(fakeFetch(timeout()))
      .embedQuery('question')
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ProviderTimeoutError)
    expect(String(error)).not.toContain('timeout secret')
  })

  it('requires a key', () => {
    expect(() => new VoyageQueryEmbedder({ apiKey: undefined })).toThrow(/OPENROUTER_API_KEY/)
  })
})
