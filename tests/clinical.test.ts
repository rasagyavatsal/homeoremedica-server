import { describe, expect, it, vi } from 'vitest'

import {
  Clinical,
  type ClinicalRanker,
  ClinicalTerms,
  DISEASE_INSTRUCTION,
  ModelDiseaseExtractor,
  decisiveMatch,
  leadingClinicalRemedies,
  loadClinicalTerms,
  parseDiseases,
  termWords,
} from '../src/clinical.ts'
import { ChatRequestSchema } from '../src/contracts.ts'
import { ProviderError } from '../src/errors.ts'
import type { Repertoriser } from '../src/repertory.ts'
import { ProductionRetriever, type SearchableRelease } from '../src/retrieval.ts'
import { fakeFetch, json } from './fakes.ts'

describe('termWords', () => {
  it('ignores spelling, plurals, linking words and order', () => {
    expect(termWords('Diarrhœa of infants')).toEqual(termWords('infant diarrhoea'))
    expect(termWords('Pains in rectum')).toEqual(new Set(['pain', 'rectum']))
  })
})

describe('parseDiseases', () => {
  it('keeps one disease a line, without labels or list markers', () => {
    expect(parseDiseases('Diseases:\nDisease: bronchial asthma\n- Eczema\n2. **Sciatica**')).toEqual([
      'bronchial asthma',
      'Eczema',
      'Sciatica',
    ])
  })

  it('reads a reply that names none as no diseases', () => {
    expect(parseDiseases('NONE')).toEqual([])
    expect(parseDiseases('No diseases are named in this paragraph.')).toEqual([])
  })
})

describe('ClinicalTerms', () => {
  const terms = new ClinicalTerms([
    { text: 'asthma', remedies: ['ars', 'ip', 'nat-s', 'sulph'] },
    { text: 'asthma, bronchial', remedies: ['nat-s'] },
    { text: 'eczema', remedies: ['graph', 'sulph'] },
    { text: 'hay fever', remedies: ['sabad'] },
  ])

  it('matches every term whose words are all among the disease', () => {
    expect(terms.match(['Bronchial asthma']).terms.map((term) => term.text)).toEqual(['asthma', 'asthma, bronchial'])
    expect(terms.match(['fever']).terms).toEqual([])
  })

  it('ranks remedies by terms matched, then by how few remedies the terms list', () => {
    // Natrum sulph. is in both asthma terms; Sulphur, also in eczema, is in two terms of all four.
    expect(terms.match(['bronchial asthma']).ranking).toEqual(['nat-s', 'sulph', 'ars', 'ip'])
    expect(terms.match(['asthma', 'eczema']).ranking).toEqual(['sulph', 'graph', 'nat-s', 'ars', 'ip'])
  })
})

describe('decisiveMatch', () => {
  const terms = new ClinicalTerms([
    { text: 'asthma', remedies: ['ars', 'ip', 'kali-c', 'nat-s', 'spong'] },
    { text: 'asthma, bronchial', remedies: ['nat-s'] },
    { text: 'hay fever', remedies: ['sabad'] },
  ])

  it('is not when one term lists many remedies, or nothing matches', () => {
    expect(decisiveMatch(terms.match(['asthma']))).toBe(false)
    expect(decisiveMatch(terms.match(['gout']))).toBe(false)
  })

  it('is when few remedies are listed, or several terms list the lead', () => {
    expect(decisiveMatch(terms.match(['hay fever']))).toBe(true)
    expect(decisiveMatch(terms.match(['bronchial asthma']))).toBe(true)
  })
})

describe('leadingClinicalRemedies', () => {
  it('gives the first remedies with the terms that list them', () => {
    const terms = new ClinicalTerms([
      { text: 'asthma', remedies: ['arsenicum-album', 'natrum-sulphuricum'] },
      { text: 'asthma, bronchial', remedies: ['natrum-sulphuricum'] },
    ])

    expect(leadingClinicalRemedies(terms.match(['bronchial asthma']), 1)).toEqual([
      { remedyName: 'Natrum sulphuricum', matched: [{ text: 'asthma' }, { text: 'asthma, bronchial' }] },
    ])
    expect(leadingClinicalRemedies(terms.match(['bronchial asthma']))).toHaveLength(2)
  })
})

describe('ModelDiseaseExtractor', () => {
  it('asks the model for the case in tags with the disease instruction', async () => {
    const asked: [string, unknown][] = []
    const generator = {
      model: 'glm-5.3-flash',
      async generate(prompt: string, options?: { systemInstruction?: string }) {
        asked.push([prompt, options?.systemInstruction])
        return 'Disease: sciatica'
      },
      async *stream() {},
    }

    expect(await new ModelDiseaseExtractor(generator).extractDiseases('Left sciatica, better walking.')).toEqual(['sciatica'])
    expect(asked).toEqual([['<case>\nLeft sciatica, better walking.\n</case>', DISEASE_INSTRUCTION]])
  })
})

describe('loadClinicalTerms', () => {
  it('reads every page of the collection', async () => {
    const point = (path: string[], ...remedies: string[]) => ({ id: 1, payload: { path, remedies: remedies.map((r) => [r, 1]) } })
    const fetch = fakeFetch(
      json({ result: { points: [point(['asthma', 'bronchial'], 'nat-s')], next_page_offset: 7 } }),
      json({ result: { points: [point(['sciatica'], 'gnaph', 'coloc')], next_page_offset: null } }),
    )

    const terms = await loadClinicalTerms({ url: 'https://qdrant.example/', apiKey: 'qdrant-key', fetch })

    expect(terms).toEqual([
      { text: 'asthma, bronchial', remedies: ['nat-s'] },
      { text: 'sciatica', remedies: ['gnaph', 'coloc'] },
    ])
    expect(fetch.calls[0]?.url).toBe('https://qdrant.example/collections/clarke_clinical/points/scroll')
    expect(fetch.calls[0]?.headers['api-key']).toBe('qdrant-key')
    expect(fetch.calls.map((call) => (call.body as { offset: unknown }).offset)).toEqual([null, 7])
  })

  it('rejects malformed terms', async () => {
    const fetch = fakeFetch(json({ result: { points: [{ id: 1, payload: { path: ['asthma'], remedies: [[3, 1]] } }] } }))

    await expect(loadClinicalTerms({ url: 'https://qdrant.example', fetch })).rejects.toThrow(ProviderError)
  })
})

describe('production retriever with Clarke', () => {
  const embedder = { embedQuery: async () => [1.0] }
  const request = (message: string) => ChatRequestSchema.parse({ message })
  const repertory: Repertoriser = {
    kind: async () => 'case',
    symptoms: async () => [],
    repertorise: async () => {
      const rubrics = [{ id: 'r', bookId: 'kent_repertory', chapter: 'Mind', text: 'Mind: weeping', remedies: [['puls', 1] as const] }]
      return { symptoms: [{ symptom: 'Mind: weeps', rubrics }], remedies: [{ remedyId: 'puls', symptoms: 1, grades: 1 }] }
    },
  }
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
  const clinical = new Clinical({
    extractor: { extractDiseases: async () => ['sciatica'] },
    terms: new ClinicalTerms([{ text: 'sciatica', remedies: ['gnaph', 'coloc'] }]),
  })

  it("ranks Clarke's remedies beside the repertory's without reordering the search", async () => {
    const { corpus, calls } = searching()

    const retrieval = await new ProductionRetriever(corpus, embedder, { repertory, clinical }).retrieve(
      request('Left sciatica, better walking.'),
      { limit: 8 },
    )

    expect(calls).toEqual([{ limit: 8 }])
    expect(retrieval.repertories.map(({ remedies }) => remedies.map((remedy) => remedy.remedyName))).toEqual([['Puls']])
    expect(retrieval.clinical).toEqual([
      { remedyName: 'Coloc', matched: [{ text: 'sciatica' }] },
      { remedyName: 'Gnaph', matched: [{ text: 'sciatica' }] },
    ])
  })

  it('ranks by the diseases a user confirmed without reading the case, and reads them for review', async () => {
    const { corpus, calls } = searching()
    const read: string[] = []
    const reading = new Clinical({
      extractor: { extractDiseases: async (text) => (read.push(text), ['asthma']) },
      terms: new ClinicalTerms([{ text: 'sciatica', remedies: ['gnaph', 'coloc'] }]),
    })
    const retriever = new ProductionRetriever(corpus, embedder, { clinical: reading })

    const retrieval = await retriever.retrieve({ ...request('A painful leg.'), diseases: ['sciatica'] }, { limit: 8 })

    expect(read).toEqual([])
    expect(calls).toEqual([{ limit: 8 }])
    expect(retrieval.clinical.map((remedy) => remedy.remedyName)).toEqual(['Coloc', 'Gnaph'])
    expect(await retriever.diseases(request('Asthma at night.'))).toEqual(['asthma'])
    expect(read).toEqual(['Asthma at night.'])
    expect(await new ProductionRetriever(corpus, embedder).diseases(request('Asthma at night.'))).toEqual([])
  })

  it('leaves Clarke out when he lists many remedies for the one disease the case names', async () => {
    const { corpus } = searching()
    const common = new Clinical({
      extractor: { extractDiseases: async () => ['asthma'] },
      terms: new ClinicalTerms([{ text: 'asthma', remedies: ['ars', 'ip', 'kali-c', 'nat-s', 'spong'] }]),
    })

    const retrieval = await new ProductionRetriever(corpus, embedder, { repertory, clinical: common }).retrieve(
      request('Asthma at night.'),
      { limit: 8 },
    )

    expect(retrieval.clinical).toEqual([])
  })

  it('leaves Clarke out when the case names no disease he lists, or matching fails', async () => {
    const { corpus, calls } = searching()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const none = new Clinical({ extractor: { extractDiseases: async () => [] }, terms: new ClinicalTerms([]) })
    const failing: ClinicalRanker = {
      diseases: async () => [],
      rank: async () => {
        throw new ProviderError('Z.AI chat request failed with status 500')
      },
    }

    for (const ranker of [none, failing]) {
      const retrieval = await new ProductionRetriever(corpus, embedder, { repertory, clinical: ranker }).retrieve(
        request('A weepy woman.'),
        { limit: 8 },
      )
      expect(retrieval.clinical).toEqual([])
    }

    expect(calls).toEqual([{ limit: 8 }, { limit: 8 }])
    expect(logged).toHaveBeenCalledOnce()
    logged.mockRestore()
  })
})
