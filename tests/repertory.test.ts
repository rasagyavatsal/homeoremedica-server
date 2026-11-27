import { describe, expect, it, vi } from 'vitest'

import { ChatRequestSchema, type ChatRequest } from '../src/contracts.ts'
import { ProviderError } from '../src/errors.ts'
import {
  CombinedRubrics,
  QdrantRubrics,
  type Repertoriser,
  Repertory,
  type Rubric,
  decisive,
  distinctMatches,
  leadingRemedies,
  rankRemedies,
  standingOut,
} from '../src/repertory.ts'
import { ProductionRetriever, type SearchableRelease } from '../src/retrieval.ts'
import { fakeFetch, json } from './fakes.ts'

const rubric = (text: string, ...remedies: [string, number][]): Rubric => ({
  id: text,
  bookId: 'kent_repertory',
  chapter: text.split(':')[0]!,
  text,
  remedies,
})

const request = (message: string): ChatRequest => ChatRequestSchema.parse({ message })

describe('rankRemedies', () => {
  it('ranks by symptoms covered, then by grades', () => {
    const ranked = rankRemedies([
      { symptom: 'Mind: irritable', rubrics: [rubric('Mind: irritability', ['nux', 3], ['sulph', 1])] },
      { symptom: 'Stomach: thirstless', rubrics: [rubric('Stomach: thirstless', ['puls', 3], ['sulph', 1])] },
      { symptom: 'Sleep: waking at 3 a.m.', rubrics: [rubric('Sleep: waking, 3 a.m.', ['nux', 1], ['sulph', 2])] },
    ])

    expect(ranked).toEqual([
      { remedyId: 'sulph', symptoms: 3, grades: 4 },
      { remedyId: 'nux', symptoms: 2, grades: 4 },
      { remedyId: 'puls', symptoms: 1, grades: 3 },
    ])
  })

  it('counts a remedy once per symptom, at its best grade', () => {
    const ranked = rankRemedies([
      {
        symptom: 'Head: pain, morning',
        rubrics: [rubric('Head: pain, morning', ['bry', 1]), rubric('Head: pain, morning, rising', ['bry', 3])],
      },
    ])

    expect(ranked).toEqual([{ remedyId: 'bry', symptoms: 1, grades: 3 }])
  })
})

describe('decisive', () => {
  const symptoms = (count: number) => Array.from({ length: count }, (_, index) => ({ symptom: `Mind: ${index}`, rubrics: [] }))
  const remedies = (...covered: number[]) =>
    covered.map((symptoms, index) => ({ remedyId: `remedy-${index}`, symptoms, grades: symptoms }))

  it('is not when many remedies lead together on one symptom or under half of them', () => {
    expect(decisive({ symptoms: symptoms(1), remedies: remedies(1, 1, 1, 1, 1) })).toBe(false)
    expect(decisive({ symptoms: symptoms(7), remedies: remedies(3, 3, 3, 3, 3, 2) })).toBe(false)
    expect(decisive({ symptoms: [], remedies: [] })).toBe(false)
  })

  it('is when few remedies lead, or the lead covers half of the symptoms', () => {
    expect(decisive({ symptoms: symptoms(1), remedies: remedies(1, 1, 1, 1) })).toBe(true)
    expect(decisive({ symptoms: symptoms(7), remedies: remedies(3, 2, 2, 2, 2, 2) })).toBe(true)
    expect(decisive({ symptoms: symptoms(6), remedies: remedies(3, 3, 3, 3, 3, 3) })).toBe(true)
  })
})

describe('distinctMatches', () => {
  it('counts a rubric under the first symptom that matched it and drops a symptom left with none', () => {
    const sciatica = rubric('Extremities: pain, sciatica', ['coloc', 3])
    const night = rubric('Extremities: pain, sciatica, night', ['ars', 2])
    const matches = [
      { symptom: 'Extremities: sciatica', rubrics: [sciatica] },
      { symptom: 'Extremities: sciatic pain', rubrics: [sciatica] },
      { symptom: 'Extremities: sciatica, worse at night', rubrics: [night, sciatica] },
      { symptom: 'Extremities: sciatica', rubrics: [{ ...sciatica, bookId: 'boericke_repertory' }] },
    ]

    const distinct = distinctMatches(matches)

    expect(distinct.map(({ symptom, rubrics }) => [symptom, rubrics.map((found) => found.bookId + ' ' + found.id)])).toEqual([
      ['Extremities: sciatica', ['kent_repertory Extremities: pain, sciatica']],
      ['Extremities: sciatica, worse at night', ['kent_repertory Extremities: pain, sciatica, night']],
      ['Extremities: sciatica', ['boericke_repertory Extremities: pain, sciatica']],
    ])
    expect(rankRemedies(distinct)[0]).toEqual({ remedyId: 'coloc', symptoms: 2, grades: 6 })
  })
})

describe('standingOut', () => {
  const scored = (...scores: [symptoms: number, grades: number][]) =>
    scores.map(([symptoms, grades], index) => ({ remedyId: `remedy-${index}`, symptoms, grades }))
  const ids = (...scores: [number, number][]) => standingOut(scored(...scores), 3).map((remedy) => remedy.remedyId)

  it('gives the first remedies when the next one scores lower, or there is none', () => {
    expect(ids([4, 9], [3, 6], [3, 5], [3, 4])).toEqual(['remedy-0', 'remedy-1', 'remedy-2'])
    expect(ids([4, 9], [3, 6])).toEqual(['remedy-0', 'remedy-1'])
    expect(ids([2, 4], [2, 4], [2, 4])).toEqual(['remedy-0', 'remedy-1', 'remedy-2'])
  })

  it('names the remedies that tie past the limit when they make at most four in all', () => {
    expect(ids([4, 9], [3, 6], [3, 5], [3, 5])).toEqual(['remedy-0', 'remedy-1', 'remedy-2', 'remedy-3'])
    expect(ids([5, 8], [5, 8], [5, 8], [5, 8], [5, 7])).toEqual(['remedy-0', 'remedy-1', 'remedy-2', 'remedy-3'])
  })

  it('leaves out the remedies that score the same as one past the limit when more tie', () => {
    expect(ids([4, 9], [3, 6], [3, 5], [3, 5], [3, 5])).toEqual(['remedy-0', 'remedy-1'])
    expect(ids([4, 9], [3, 5], [3, 5], [3, 5], [3, 5])).toEqual(['remedy-0'])
    expect(ids([3, 5], [3, 5], [3, 5], [3, 5], [3, 5])).toEqual([])
  })
})

describe('leadingRemedies', () => {
  const matches = [
    {
      symptom: 'Mind: weeps easily',
      rubrics: [rubric('Mind: weeping', ['pulsatilla', 3], ['natrum-muriaticum', 2]), rubric('Mind: weeping, alone', ['natrum-muriaticum', 3])],
    },
    { symptom: 'Stomach: no thirst', rubrics: [rubric('Stomach: thirstless', ['pulsatilla', 3], ['gelsemium', 2])] },
  ]
  const repertorisation = { symptoms: matches, remedies: rankRemedies(matches) }

  it('gives the first remedies with their symptoms and the rubric that grades each highest', () => {
    const { remedies, rubrics } = leadingRemedies(repertorisation, { firstSource: 6, limit: 2 })

    expect(remedies).toEqual([
      { remedyName: 'Pulsatilla', matched: [{ text: 'Mind: weeps easily', source: 6 }, { text: 'Stomach: no thirst', source: 8 }] },
      { remedyName: 'Natrum muriaticum', matched: [{ text: 'Mind: weeps easily', source: 7 }] },
    ])
    expect(rubrics.map((source) => [source.bookTitle, source.sectionTitle, source.text])).toEqual([
      ['Kent, Repertory of the Homoeopathic Materia Medica', 'Mind: weeping', 'Remedies and their grades: Pulsatilla (3), Natrum muriaticum (2)'],
      ['Kent, Repertory of the Homoeopathic Materia Medica', 'Mind: weeping, alone', 'Remedies and their grades: Natrum muriaticum (3)'],
      ['Kent, Repertory of the Homoeopathic Materia Medica', 'Stomach: thirstless', 'Remedies and their grades: Pulsatilla (3), Gelsemium (2)'],
    ])
    expect(rubrics[0]).toMatchObject({ chunkId: 'Mind: weeping', bookId: 'kent_repertory', remedyName: null, passageIndexes: [] })
  })

  it('names three remedies and cites no more rubrics than it may', () => {
    const { remedies, rubrics } = leadingRemedies(repertorisation, { firstSource: 1, maxRubrics: 1 })

    expect(remedies.map((remedy) => remedy.remedyName)).toEqual(['Pulsatilla', 'Natrum muriaticum', 'Gelsemium'])
    expect(remedies[1]?.matched).toEqual([{ text: 'Mind: weeps easily' }])
    expect(rubrics).toHaveLength(1)
  })

  it('names no remedy that ties with one it leaves out', () => {
    const tied = [{ symptom: 'Mind: anxious', rubrics: [rubric('Mind: anxiety', ['aconitum', 3], ['apis', 1], ['arsenicum', 1], ['mezereum', 1], ['thuja', 1])] }]

    const { remedies, rubrics } = leadingRemedies({ symptoms: tied, remedies: rankRemedies(tied) }, { firstSource: 1 })

    expect(remedies.map((remedy) => remedy.remedyName)).toEqual(['Aconitum'])
    expect(rubrics[0]?.text).toBe('Remedies and their grades: Aconitum (3), Apis (1), Arsenicum (1), Mezereum (1), Thuja (1)')
  })

  it("lists the leading remedies first in a long rubric's source, then the rest by grade", () => {
    const many = Array.from({ length: 45 }, (_, index): [string, number] => [`remedy-${index}`, index === 44 ? 3 : 1])
    const long = [{ symptom: 'Mind: anxious', rubrics: [rubric('Mind: anxiety', ...many, ['sulphur', 1])] }]

    const { rubrics } = leadingRemedies(
      { symptoms: long, remedies: [{ remedyId: 'sulphur', symptoms: 1, grades: 1 }] },
      { firstSource: 1 },
    )

    expect(rubrics[0]?.text).toMatch(/^Remedies and their grades: Sulphur \(1\), Remedy 44 \(3\), Remedy 0 \(1\), .*, and 6 more$/)
  })
})

describe('Repertory', () => {
  const classifier = { classify: async () => 'case' as const }

  it('matches each symptom to its rubrics and ranks the remedies', async () => {
    const searched: unknown[] = []
    const repertory = new Repertory({
      classifier,
      embedder: { embedQueries: async (texts) => texts.map((_, index) => [index]) },
      rubrics: {
        async search(embeddings, { limit }) {
          searched.push(embeddings, limit)
          return [[rubric('Mind: weeping', ['puls', 3])], [rubric('Stomach: thirstless', ['puls', 2], ['gels', 2])]]
        },
      },
    })

    const result = await repertory.repertorise(['Mind: weeping', 'Stomach: thirstless'])

    expect(searched).toEqual([[[0], [1]], 3])
    expect(result.symptoms.map((match) => [match.symptom, match.rubrics.map((found) => found.text)])).toEqual([
      ['Mind: weeping', ['Mind: weeping']],
      ['Stomach: thirstless', ['Stomach: thirstless']],
    ])
    expect(result.remedies.map((remedy) => remedy.remedyId)).toEqual(['puls', 'gels'])
  })

  it('drops the rubrics that state the opposite of their symptom, then keeps the nearest of each repertory', async () => {
    const searched: number[] = []
    const asked: unknown[] = []
    const boericke = { ...rubric('Stomach: thirst, thirstlessness', ['puls', 2]), bookId: 'boericke_repertory' }
    const repertory = new Repertory({
      classifier,
      embedder: { embedQueries: async (texts) => texts.map(() => [0]) },
      rubrics: {
        async search(_embeddings, { limit }) {
          searched.push(limit)
          const kent = ['Stomach: thirst', 'Stomach: thirstless', 'Stomach: thirstless, heat, during', 'Chill: thirstless']
          return [[...kent.map((text) => rubric(text, ['puls', 1])), boericke]]
        },
      },
      opposites: {
        async opposites(pairs) {
          asked.push(...pairs)
          return pairs.map(({ rubric }) => rubric === 'Stomach: thirst')
        },
      },
    })

    const result = await repertory.repertorise(['Thirstless'])

    expect(searched).toEqual([5])
    expect(asked).toHaveLength(5)
    expect(asked[0]).toEqual({ symptom: 'Thirstless', rubric: 'Stomach: thirst' })
    expect(result.symptoms[0]?.rubrics.map((found) => found.text)).toEqual([
      'Stomach: thirstless',
      'Stomach: thirstless, heat, during',
      'Chill: thirstless',
      'Stomach: thirst, thirstlessness',
    ])
  })

  it('fails when the opposite check fails', async () => {
    const cause = new ProviderError('OpenRouter decision request failed with status 500')
    const repertory = new Repertory({
      classifier,
      embedder: { embedQueries: async (texts) => texts.map(() => [0]) },
      rubrics: {
        search: async () => [['Stomach: thirst', 'Stomach: thirstless', 'Chill: thirstless', 'Throat: dryness'].map((text) => rubric(text, ['puls', 1]))],
      },
      opposites: {
        opposites: async () => {
          throw cause
        },
      },
    })

    await expect(repertory.repertorise(['Thirstless'])).rejects.toBe(cause)
  })

  it('searches nothing without symptoms', async () => {
    const embedQueries = vi.fn()
    const repertory = new Repertory({
      classifier,
      embedder: { embedQueries },
      rubrics: { search: vi.fn() },
    })

    expect(await repertory.repertorise([])).toEqual({ symptoms: [], remedies: [] })
    expect(embedQueries).not.toHaveBeenCalled()
  })
})

describe('CombinedRubrics', () => {
  it("takes each symptom's nearest rubrics from every repertory, one after another", async () => {
    const kent = { search: vi.fn(async () => [[rubric('Mind: weeping', ['puls', 3])], [rubric('Stomach: thirstless', ['puls', 2])]]) }
    const boericke = { search: vi.fn(async () => [[rubric('Mind: weeping, from music', ['nat-s', 1])], []]) }

    const found = await new CombinedRubrics([kent, boericke]).search([[0], [1]], { limit: 3 })

    expect(kent.search).toHaveBeenCalledWith([[0], [1]], { limit: 3 })
    expect(boericke.search).toHaveBeenCalledWith([[0], [1]], { limit: 3 })
    expect(found.map((rubrics) => rubrics.map((found) => found.text))).toEqual([
      ['Mind: weeping', 'Mind: weeping, from music'],
      ['Stomach: thirstless'],
    ])
  })
})

describe('Qdrant rubrics', () => {
  const rubrics = (fetch: ReturnType<typeof fakeFetch>) =>
    new QdrantRubrics({ url: 'https://qdrant.example/', apiKey: 'qdrant-key', fetch })
  const point = (payload: Record<string, unknown>) => ({ id: 'p', score: 0.7, payload })
  const PAYLOAD = { id: 'kent_repertory-00002', chapter: 'Mind', text: 'Mind: absent minded', remedies: [['nux', 2]] }

  it('searches the nearest rubrics of every embedding in one request', async () => {
    const fetch = fakeFetch(json({ result: [{ points: [point(PAYLOAD)] }, { points: [] }], status: 'ok' }))

    const found = await rubrics(fetch).search([[0.1], [0.2]], { limit: 3 })

    expect(fetch.calls[0]?.url).toBe('https://qdrant.example/collections/kent_repertory/points/query/batch')
    expect(fetch.calls[0]?.headers['api-key']).toBe('qdrant-key')
    expect(fetch.calls[0]?.body).toEqual({
      searches: [[0.1], [0.2]].map((query) => ({
        query,
        using: 'dense',
        limit: 3,
        with_payload: ['id', 'chapter', 'text', 'remedies'],
        with_vector: false,
      })),
    })
    expect(found).toEqual([[{ id: 'kent_repertory-00002', bookId: 'kent_repertory', chapter: 'Mind', text: 'Mind: absent minded', remedies: [['nux', 2]] }], []])
  })

  it('rejects malformed rubrics', async () => {
    const fetch = fakeFetch(json({ result: [{ points: [point({ ...PAYLOAD, remedies: [['nux', 'bold']] })] }] }))

    await expect(rubrics(fetch).search([[0.1]], { limit: 3 })).rejects.toThrow(ProviderError)
  })

  it('reports whether the collection exists', async () => {
    const fetch = fakeFetch(json({ result: { exists: false } }))

    expect(await rubrics(fetch).exists()).toBe(false)
    expect(fetch.calls[0]?.url).toBe('https://qdrant.example/collections/kent_repertory/exists')
  })
})

describe('production retriever with a repertory', () => {
  const embedder = { embedQuery: async () => [1.0] }
  const searching = () => {
    const calls: unknown[] = []
    const corpus: SearchableRelease = {
      async search(_query, _embedding, options) {
        calls.push(options)
        return []
      },
    }
    return { corpus, calls }
  }
  const repertoryOf = (...remedyIds: string[]): Repertoriser => {
    const symptoms = [{ symptom: 'Mind: weeps', rubrics: [rubric('Mind: weeping', ...remedyIds.map((id): [string, number] => [id, 1]))] }]
    return {
      kind: async () => 'case',
      repertorise: async () => ({ symptoms, remedies: rankRemedies(symptoms) }),
    }
  }
  // Finds one symptom in every case.
  const rewriter = { rewrite: async ({ message }: ChatRequest) => ({ query: message, caseMessages: [message], symptoms: ['weepy'] }) }
  const names = ({ repertories }: { repertories: readonly { remedies: readonly { remedyName: string }[] }[] }) =>
    repertories.map(({ remedies }) => remedies.map((remedy) => remedy.remedyName))

  it('sorts by the latest message whole and as many earlier ones as fit, cutting the oldest first', async () => {
    const seen: (readonly string[])[] = []
    const [first, second, third] = ['a', 'b', 'c'].map((letter) => letter.repeat(4_000))
    const asked = ChatRequestSchema.parse({
      message: 'Latest?',
      history: [first, second, third].flatMap((content) => [
        { role: 'user', content },
        { role: 'assistant', content: 'Reply.' },
      ]),
    })

    await new ProductionRetriever(searching().corpus, embedder, {
      repertory: { kind: async (messages) => (seen.push(messages), 'question'), repertorise: vi.fn() },
    }).retrieve(asked, { limit: 8 })

    expect(seen).toEqual([['b'.repeat(8_000 - 4_000 - 'Latest?'.length), third, 'Latest?']])
  })

  it("searches the books without the repertory's ranking, which has its own section", async () => {
    const { corpus, calls } = searching()

    const retrieval = await new ProductionRetriever(corpus, embedder, {
      repertory: repertoryOf('puls', 'sep', 'nat-m'),
      rewriter,
    }).retrieve(request('A weepy, thirstless woman.'), { limit: 8 })

    expect(calls).toEqual([{ limit: 8 }])
    expect(names(retrieval)).toEqual([['Nat m', 'Puls', 'Sep']])
  })

  it("returns each repertory's leading remedies and their rubrics after the passages", async () => {
    const passage = { chunkId: 'chk_1', bookId: 'kent_lectures', bookTitle: "Kent's Lectures", author: null, remedyName: 'PULSATILLA', sectionTitle: 'MIND', passageIndexes: [1], text: 'Weeps.', score: 0.03 }
    const corpus: SearchableRelease = { search: async () => [passage] }
    const boericke = { ...rubric('Mind: tearful', ['ignatia', 2]), bookId: 'boericke_repertory' }
    const symptoms = [{ symptom: 'Mind: weeps easily', rubrics: [rubric('Mind: weeping', ['pulsatilla', 3]), boericke] }]
    const repertory: Repertoriser = {
      kind: async () => 'case',
      repertorise: async () => ({ symptoms, remedies: rankRemedies(symptoms) }),
    }

    const retrieval = await new ProductionRetriever(corpus, embedder, { repertory, rewriter }).retrieve(request('A weepy woman.'), { limit: 5 })

    expect(retrieval.sources.map((source) => source.chunkId)).toEqual(['chk_1', 'Mind: weeping', 'Mind: tearful'])
    expect(retrieval.repertories).toEqual([
      {
        bookTitle: 'Kent, Repertory of the Homoeopathic Materia Medica',
        remedies: [{ remedyName: 'Pulsatilla', matched: [{ text: 'Mind: weeps easily', source: 2 }] }],
      },
      { bookTitle: 'Boericke, Repertory', remedies: [{ remedyName: 'Ignatia', matched: [{ text: 'Mind: weeps easily', source: 3 }] }] },
    ])
  })

  it('leaves out a ranking that many remedies lead together at a low score', async () => {
    const { corpus, calls } = searching()

    const retrieval = await new ProductionRetriever(corpus, embedder, {
      repertory: repertoryOf('puls', 'sep', 'nat-m', 'ign', 'lach'),
      rewriter,
    }).retrieve(request('A weepy woman.'), { limit: 8 })

    expect(calls).toEqual([{ limit: 8 }])
    expect(retrieval.repertories).toEqual([])
  })

  it('searches the books but not the repertories when the question describes no patient', async () => {
    const { corpus, calls } = searching()
    const repertorise = vi.fn()

    const retrieval = await new ProductionRetriever(corpus, embedder, {
      repertory: { kind: async () => 'question', repertorise },
    }).retrieve(request('What is Sulphur?'), { limit: 8 })

    expect(calls).toEqual([{ limit: 8 }])
    expect(repertorise).not.toHaveBeenCalled()
    expect(retrieval.repertories).toEqual([])
  })

  it('searches nothing for an off-topic question', async () => {
    const { corpus, calls } = searching()
    const repertorise = vi.fn()

    const retrieval = await new ProductionRetriever(corpus, embedder, {
      repertory: { kind: async () => 'off-topic', repertorise },
    }).retrieve(request('What is the capital of France?'), { limit: 8 })

    expect(retrieval).toEqual({ sources: [], repertories: [] })
    expect(calls).toEqual([])
    expect(repertorise).not.toHaveBeenCalled()
  })

  it('sorts by every question of the chat, and searches a case by its messages and symptoms', async () => {
    const searched: string[] = []
    const corpus: SearchableRelease = { search: async (query) => (searched.push(query), []) }
    const seen: unknown[] = []
    const repertory: Repertoriser = {
      kind: async (text) => (seen.push(text), 'case'),
      repertorise: async (symptoms) => (seen.push(symptoms), { symptoms: [], remedies: [] }),
    }
    const rewriter = {
      rewrite: async () => ({
        query: 'Rewritten',
        caseMessages: ['A weepy woman.', 'She is thirstless.'],
        symptoms: ['weepy', 'thirstless'],
      }),
    }
    const asked = ChatRequestSchema.parse({
      message: 'She is thirstless.',
      history: [
        { role: 'user', content: 'A weepy woman.' },
        { role: 'assistant', content: 'Pulsatilla.' },
        { role: 'user', content: 'What is Sulphur?' },
        { role: 'assistant', content: 'A remedy.' },
      ],
    })

    await new ProductionRetriever(corpus, embedder, { repertory, rewriter }).retrieve(asked, { limit: 8 })

    expect(seen).toEqual([['A weepy woman.', 'What is Sulphur?', 'She is thirstless.'], ['weepy', 'thirstless']])
    expect(searched).toEqual(['A weepy woman.\nShe is thirstless.'])
  })

  it('ranks no remedies for a case whose symptoms the rewrite did not find', async () => {
    const { corpus, calls } = searching()
    const repertorise = vi.fn()
    const rewriter = { rewrite: async () => ({ query: 'q', caseMessages: ['A weepy woman.'], symptoms: [] }) }

    const retrieval = await new ProductionRetriever(corpus, embedder, {
      repertory: { kind: async () => 'case', repertorise },
      rewriter,
    }).retrieve(request('A weepy woman.'), { limit: 8 })

    expect(calls).toEqual([{ limit: 8 }])
    expect(repertorise).not.toHaveBeenCalled()
    expect(retrieval.repertories).toEqual([])
  })

  it('stops the rewrite of an off-topic question', async () => {
    const { corpus } = searching()
    let stopped: AbortSignal | undefined
    const rewriter = {
      rewrite: (_request: ChatRequest, { signal }: { signal?: AbortSignal } = {}) =>
        new Promise<never>((_resolve, reject) => {
          stopped = signal
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    }

    const retrieval = await new ProductionRetriever(corpus, embedder, {
      repertory: { kind: async () => 'off-topic', repertorise: vi.fn() },
      rewriter,
    }).retrieve(request('Tell me a joke.'), { limit: 8 })

    expect(retrieval).toEqual({ sources: [], repertories: [] })
    expect(stopped?.aborted).toBe(true)
  })

  it('fails when sorting the question fails, and stops the rewrite', async () => {
    const { corpus, calls } = searching()
    const cause = new ProviderError('OpenRouter decision request failed with status 500')
    let stopped: AbortSignal | undefined
    const rewriter = {
      rewrite: (_request: ChatRequest, { signal }: { signal?: AbortSignal | undefined } = {}) =>
        new Promise<never>((_resolve, reject) => {
          stopped = signal
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    }
    const repertory: Repertoriser = {
      kind: async () => {
        throw cause
      },
      repertorise: vi.fn(),
    }

    await expect(new ProductionRetriever(corpus, embedder, { repertory, rewriter }).retrieve(request('A weepy woman.'), { limit: 8 })).rejects.toBe(
      cause,
    )
    expect(stopped?.aborted).toBe(true)
    expect(calls).toEqual([])
  })

  it('stops every request it makes when the user stops', async () => {
    const { corpus } = searching()
    const signals: (AbortSignal | undefined)[] = []
    const repertory: Repertoriser = {
      kind: async (_text, options) => (signals.push(options?.signal), 'case'),
      repertorise: async (_symptoms, options) => (signals.push(options?.signal), { symptoms: [], remedies: [] }),
    }
    const rewriter = {
      rewrite: async (_request: ChatRequest, options?: { signal?: AbortSignal | undefined }) => (
        signals.push(options?.signal), { query: 'q', caseMessages: ['A weepy woman.'], symptoms: ['weepy'] }
      ),
    }
    const watched = { embedQuery: async (_text: string, options?: { signal?: AbortSignal | undefined }) => (signals.push(options?.signal), [1.0]) }
    const stop = new AbortController()

    await new ProductionRetriever(corpus, watched, { repertory, rewriter }).retrieve(request('A weepy woman.'), { limit: 8, signal: stop.signal })
    stop.abort()

    expect(signals).toHaveLength(4)
    expect(signals.every((signal) => signal?.aborted)).toBe(true)
  })

  it('fails when repertorisation fails, and stops the book search', async () => {
    const cause = new ProviderError('OpenRouter embedding request failed with status 500')
    let stopped: AbortSignal | undefined
    const corpus: SearchableRelease = { search: async () => [] }
    const waiting = {
      embedQuery: (_text: string, { signal }: { signal?: AbortSignal | undefined } = {}) =>
        new Promise<never>((_resolve, reject) => {
          stopped = signal
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    }
    const repertory: Repertoriser = {
      kind: async () => 'case',
      repertorise: async () => {
        throw cause
      },
    }

    await expect(new ProductionRetriever(corpus, waiting, { repertory, rewriter }).retrieve(request('A weepy woman.'), { limit: 8 })).rejects.toBe(cause)
    expect(stopped?.aborted).toBe(true)
  })
})
