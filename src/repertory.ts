/**
 * Repertorisation of a described case against Kent's Repertory, and optionally Boericke's, each
 * ranking remedies on its own.
 *
 * The case is split into symptoms in the user's own words by a decision model, each symptom is
 * matched to its nearest rubrics by voyage-4 embedding, less those a decision model finds state its opposite, and
 * remedies are ranked the way a homoeopath works a repertory:
 * by how many of the case's symptoms they cover, then by their grades. A ranking that many remedies
 * lead together at a low score is left out of the answer. The rubrics are the
 * `kent_repertory` and `boericke_repertory` Qdrant collections, which the homeoremedica-private
 * repository builds with `scripts/rubrics.py` and `scripts/embed.py`.
 */

import {
  type BookSummary,
  type Cancellable,
  MAX_SYMPTOMS,
  type QuestionKind,
  type RankedRemedy,
  type RetrievedSource,
} from './contracts.ts'
import type { OppositeCheck } from './decisions.ts'
import { ProviderError } from './errors.ts'
import { type Fetch, isRecord, readJson, send } from './http.ts'

export const REPERTORY_COLLECTION = 'kent_repertory'
/** Boericke's clinical repertory, whose headings are often the names of diseases. */
export const BOERICKE_COLLECTION = 'boericke_repertory'
/** More rubrics per symptom adds loosely related ones, which made the ranking worse. */
export const RUBRICS_PER_SYMPTOM = 3
/** The nearest rubrics of each repertory checked for opposites, so RUBRICS_PER_SYMPTOM are usually left. */
export const CANDIDATE_RUBRICS = 5
export { MAX_SYMPTOMS }
/** A ranking that this many remedies lead together, at a low score, does not tell them apart. */
export const INDECISIVE_TIES = 5
/** The extraction model reasons first, and its reasoning counts against this. */
export const EXTRACTION_MAX_OUTPUT_TOKENS = 16_000
/** How many of a ranking's remedies an answer names, unless a few more tie with the last of them. */
export const LEADING_REMEDIES = 3
/** How many remedies an answer names at most, when those past LEADING_REMEDIES tie with the last it names. */
export const MAX_LEADING_REMEDIES = INDECISIVE_TIES - 1
/** How many rubrics of each repertory an answer can cite for its leading remedies; with the passages, as many as a saved answer keeps. */
export const MAX_RUBRIC_SOURCES = 8
/** How many of a rubric's remedies its source lists. */
export const MAX_RUBRIC_REMEDIES = 40
const MAX_RUBRIC_TITLE_CHARS = 500
const LABEL = 'Qdrant repertory'

// Book IDs are the repertories' Qdrant collection names.
export const REPERTORIES: readonly BookSummary[] = [
  { bookId: REPERTORY_COLLECTION, title: 'Kent, Repertory of the Homoeopathic Materia Medica', author: 'James Tyler Kent' },
  { bookId: BOERICKE_COLLECTION, title: 'Boericke, Repertory', author: 'Oscar E. Boericke' },
]

export interface Rubric {
  id: string
  /** The repertory's Qdrant collection. */
  bookId: string
  chapter: string
  /** The rubric as one line, such as `Head: pain, hammering, morning`. */
  text: string
  /** Remedy ids and their grades, from 1 (plain) to 3 (bold); Boericke's are 1 or 2 (italic). */
  remedies: readonly (readonly [remedyId: string, grade: number])[]
}

export interface SymptomMatch {
  symptom: string
  rubrics: readonly Rubric[]
}

export interface RemedyCandidate {
  remedyId: string
  /** How many of the case's symptoms some matched rubric lists the remedy under. */
  symptoms: number
  /** The remedy's best grade for each symptom it covers, summed. */
  grades: number
}

export interface Repertorisation {
  symptoms: readonly SymptomMatch[]
  /** Best first; empty when the question describes no patient. */
  remedies: readonly RemedyCandidate[]
}

export interface Repertoriser {
  /** Whether the text describes a patient, decided before its symptoms are read. */
  kind(text: string, options?: Cancellable): Promise<QuestionKind>
  /** Ranks remedies for the symptoms of the case the text describes. */
  repertorise(text: string): Promise<Repertorisation>
}

export interface SymptomExtractor {
  extractSymptoms(text: string, options?: Cancellable): Promise<string[]>
}

export interface CaseClassifier {
  classify(text: string, options?: Cancellable): Promise<QuestionKind>
}

export interface QueriesEmbedder {
  embedQueries(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

export interface RubricSearch {
  /** The `limit` nearest rubrics to each embedding, nearest first. */
  search(embeddings: readonly (readonly number[])[], options: { limit: number }): Promise<Rubric[][]>
}

export class Repertory implements Repertoriser {
  readonly #classifier: CaseClassifier
  readonly #extractor: SymptomExtractor
  readonly #embedder: QueriesEmbedder
  readonly #rubrics: RubricSearch
  readonly #opposites: OppositeCheck | undefined

  constructor({
    classifier,
    extractor,
    embedder,
    rubrics,
    opposites,
  }: {
    classifier: CaseClassifier
    extractor: SymptomExtractor
    embedder: QueriesEmbedder
    rubrics: RubricSearch
    opposites?: OppositeCheck | undefined
  }) {
    this.#classifier = classifier
    this.#extractor = extractor
    this.#embedder = embedder
    this.#rubrics = rubrics
    this.#opposites = opposites
  }

  kind(text: string, options?: Cancellable): Promise<QuestionKind> {
    return this.#classifier.classify(text, options)
  }

  symptoms(text: string, options?: Cancellable): Promise<string[]> {
    return this.#extractor.extractSymptoms(text, options)
  }

  async repertorise(text: string): Promise<Repertorisation> {
    const symptoms = await this.symptoms(text)
    if (!symptoms.length) return { symptoms: [], remedies: [] }
    const embeddings = await this.#embedder.embedQueries(symptoms)
    const found = await this.#rubrics.search(embeddings, {
      limit: this.#opposites ? CANDIDATE_RUBRICS : RUBRICS_PER_SYMPTOM,
    })
    const candidates = await this.#withoutOpposites(symptoms.map((symptom, index) => ({ symptom, rubrics: found[index] ?? [] })))
    const matches = distinctMatches(
      candidates.map(({ symptom, rubrics }) => ({ symptom, rubrics: nearestOfEach(rubrics, RUBRICS_PER_SYMPTOM) })),
    )
    return { symptoms: matches, remedies: rankRemedies(matches) }
  }

  /**
   * The matches without the rubrics that state the opposite of their symptom, such as `Stomach:
   * thirst` for a thirstless patient. Nearest embeddings often mean the opposite: they read what a
   * rubric is about more than which way it goes. Without the check, or when it fails, every rubric
   * is kept.
   */
  async #withoutOpposites(matches: readonly SymptomMatch[]): Promise<readonly SymptomMatch[]> {
    if (!this.#opposites) return matches
    const pairs = matches.flatMap(({ symptom, rubrics }) => rubrics.map((rubric) => ({ symptom, rubric: rubric.text })))
    let opposite: boolean[]
    try {
      opposite = await this.#opposites.opposites(pairs)
    } catch (error) {
      console.error('Checking rubrics for opposites failed; keeping them all', error)
      return matches
    }
    let at = 0
    return matches.map(({ symptom, rubrics }) => ({ symptom, rubrics: rubrics.filter(() => !opposite[at++]) }))
  }
}

/** The first `limit` rubrics of each repertory, in order. */
function nearestOfEach(rubrics: readonly Rubric[], limit: number): Rubric[] {
  const counts = new Map<string, number>()
  return rubrics.filter((rubric) => {
    const count = counts.get(rubric.bookId) ?? 0
    counts.set(rubric.bookId, count + 1)
    return count < limit
  })
}

/**
 * The matches with each rubric under the first symptom that matched it, and without the symptoms
 * that are left with none. The model sometimes gives a symptom twice in different words; both
 * wordings match the same rubrics, which would otherwise count twice.
 */
export function distinctMatches(matches: readonly SymptomMatch[]): SymptomMatch[] {
  const seen = new Set<string>()
  const distinct: SymptomMatch[] = []
  for (const { symptom, rubrics } of matches) {
    const fresh = rubrics.filter((rubric) => {
      const key = `${rubric.bookId}\n${rubric.id}`
      return !seen.has(key) && Boolean(seen.add(key))
    })
    if (fresh.length) distinct.push({ symptom, rubrics: fresh })
  }
  return distinct
}

/**
 * Remedies by how many symptoms they cover, then by their grades. A remedy counts once per symptom,
 * at its best grade among that symptom's rubrics. Summing grades alone favours the remedies that
 * are in nearly every rubric, so grades only break ties.
 */
export function rankRemedies(matches: readonly SymptomMatch[]): RemedyCandidate[] {
  const totals = new Map<string, RemedyCandidate>()
  for (const { rubrics } of matches) {
    const best = new Map<string, number>()
    for (const rubric of rubrics) {
      for (const [remedyId, grade] of rubric.remedies) best.set(remedyId, Math.max(best.get(remedyId) ?? 0, grade))
    }
    for (const [remedyId, grade] of best) {
      const total = totals.get(remedyId) ?? { remedyId, symptoms: 0, grades: 0 }
      totals.set(remedyId, { remedyId, symptoms: total.symptoms + 1, grades: total.grades + grade })
    }
  }
  return [...totals.values()].sort(
    (a, b) => b.symptoms - a.symptoms || b.grades - a.grades || a.remedyId.localeCompare(b.remedyId),
  )
}

/** The repertorisation by one repertory alone: the symptoms its rubrics match and the remedies they rank. */
export function inRepertory({ symptoms }: Repertorisation, bookId: string): Repertorisation {
  const matches = symptoms
    .map(({ symptom, rubrics }) => ({ symptom, rubrics: rubrics.filter((rubric) => rubric.bookId === bookId) }))
    .filter(({ rubrics }) => rubrics.length)
  return { symptoms: matches, remedies: rankRemedies(matches) }
}

/**
 * Whether a repertorisation tells the remedies apart. It does not when its leading remedy covers
 * only one symptom, or fewer than half of the case's, and INDECISIVE_TIES or more remedies cover
 * as many.
 */
export function decisive({ symptoms, remedies }: Repertorisation): boolean {
  const lead = remedies[0]?.symptoms
  if (!lead) return false
  if (lead > 1 && lead * 2 >= symptoms.length) return true
  return remedies.filter((remedy) => remedy.symptoms === lead).length < INDECISIVE_TIES
}

/** A remedy's name from its id: `Natrum muriaticum` for `natrum-muriaticum`. */
export function remedyName(remedyId: string): string {
  const name = remedyId.replaceAll('-', ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * The ranking's first `limit` remedies. Those that score the same as the remedy past the limit are
 * only ordered by name, so naming some of them and not the others says nothing: when the remedies
 * up to the end of that tie are at most `max`, all of them are named, and otherwise the tied ones
 * are left out.
 */
export function standingOut(remedies: readonly RemedyCandidate[], limit: number, max = MAX_LEADING_REMEDIES): RemedyCandidate[] {
  const next = remedies[limit]
  const leaders = remedies.slice(0, limit)
  const ties = (remedy: RemedyCandidate) => remedy.symptoms === next?.symptoms && remedy.grades === next.grades
  if (!next || !leaders.some(ties)) return leaders
  let end = limit
  while (remedies[end] && ties(remedies[end]!)) end++
  if (end <= max) return remedies.slice(0, end)
  return leaders.filter((remedy) => !ties(remedy))
}

/**
 * The ranking's leading remedies, as standingOut gives them, each with the case's
 * symptoms it covers, and the rubrics that list them, as sources an answer can cite. A covered symptom points to the rubric that
 * grades the remedy highest for it; `firstSource` is the place, from 1, of the first rubric among
 * the answer's sources.
 */
export function leadingRemedies(
  { symptoms, remedies }: Repertorisation,
  { firstSource, limit = LEADING_REMEDIES, maxRubrics = MAX_RUBRIC_SOURCES }: { firstSource: number; limit?: number; maxRubrics?: number },
): { remedies: RankedRemedy[]; rubrics: RetrievedSource[] } {
  const leaders = standingOut(remedies, limit).map((remedy) => remedy.remedyId)
  const matched = leaders.map((): { text: string; source?: number }[] => [])
  const cited: Rubric[] = []
  for (const { symptom, rubrics } of symptoms) {
    for (const [index, remedyId] of leaders.entries()) {
      let best: Rubric | undefined
      for (const rubric of rubrics) {
        if (gradeIn(rubric, remedyId) > (best ? gradeIn(best, remedyId) : 0)) best = rubric
      }
      if (!best) continue
      let at = cited.findIndex((rubric) => rubric.bookId === best.bookId && rubric.id === best.id)
      if (at < 0 && cited.length < maxRubrics) at = cited.push(best) - 1
      matched[index]!.push(at < 0 ? { text: symptom } : { text: symptom, source: firstSource + at })
    }
  }
  return {
    remedies: leaders.map((remedyId, index) => ({ remedyName: remedyName(remedyId), matched: matched[index]! })),
    rubrics: cited.map((rubric) => rubricSource(rubric, leaders)),
  }
}

function gradeIn(rubric: Rubric, remedyId: string): number {
  return rubric.remedies.find(([listed]) => listed === remedyId)?.[1] ?? 0
}

/** A rubric as a source: its remedies with their grades, the leading ones first, then by grade. */
function rubricSource(rubric: Rubric, leaders: readonly string[]): RetrievedSource {
  const book = REPERTORIES.find(({ bookId }) => bookId === rubric.bookId)
  const place = (remedyId: string) => (leaders.indexOf(remedyId) + 1 || leaders.length + 1)
  const ordered = [...rubric.remedies].sort((a, b) => place(a[0]) - place(b[0]) || b[1] - a[1])
  const listed = ordered.slice(0, MAX_RUBRIC_REMEDIES).map(([remedyId, grade]) => `${remedyName(remedyId)} (${grade})`)
  const more = ordered.length - listed.length
  return {
    chunkId: rubric.id,
    bookId: rubric.bookId,
    bookTitle: book?.title ?? rubric.bookId,
    author: book?.author ?? null,
    remedyName: null,
    sectionTitle: rubric.text.slice(0, MAX_RUBRIC_TITLE_CHARS),
    passageIndexes: [],
    text: `Remedies and their grades: ${listed.join(', ')}${more ? `, and ${more} more` : ''}`,
    score: 0,
  }
}

/** A reply's lines without their list markers or emphasis; headings, blank lines and a bare `None` are dropped. */
export function replyLines(reply: string): string[] {
  return reply
    .split('\n')
    .map((line) => line.replace(/^[\s*\-•#]*(\d+[.)])?\s*/, '').replace(/\*\*|__/g, '').trim())
    .filter((line) => line && !line.endsWith(':') && !/^none\W*$/i.test(line))
}

/** Each symptom's nearest rubrics in every one of several repertories, one repertory after another. */
export class CombinedRubrics implements RubricSearch {
  readonly #searches: readonly RubricSearch[]

  constructor(searches: readonly RubricSearch[]) {
    this.#searches = searches
  }

  async search(embeddings: readonly (readonly number[])[], options: { limit: number }): Promise<Rubric[][]> {
    const found = await Promise.all(this.#searches.map((search) => search.search(embeddings, options)))
    return embeddings.map((_, index) => found.flatMap((rubrics) => rubrics[index] ?? []))
  }
}

/** Nearest-rubric search over the repertory's Qdrant collection. */
export class QdrantRubrics implements RubricSearch {
  readonly #collection: string
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #fetch: Fetch
  readonly #timeoutMs: number

  constructor({
    url,
    apiKey,
    collection = REPERTORY_COLLECTION,
    fetch: fetchImpl = fetch,
    timeoutMs = 30_000,
  }: {
    url: string
    apiKey?: string | undefined
    collection?: string
    fetch?: Fetch
    timeoutMs?: number
  }) {
    this.#collection = collection
    this.#url = `${url.replace(/\/+$/, '')}/collections/${encodeURIComponent(collection)}`
    this.#headers = { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) }
    this.#fetch = fetchImpl
    this.#timeoutMs = timeoutMs
  }

  /** Whether the collection exists. */
  async exists(): Promise<boolean> {
    const parsed = await readJson(await this.#request('/exists', { method: 'GET' }), LABEL)
    return isRecord(parsed) && isRecord(parsed.result) && parsed.result.exists === true
  }

  async search(embeddings: readonly (readonly number[])[], { limit }: { limit: number }): Promise<Rubric[][]> {
    if (!embeddings.length) return []
    const response = await this.#request('/points/query/batch', {
      method: 'POST',
      body: JSON.stringify({
        searches: embeddings.map((embedding) => ({
          query: embedding,
          using: 'dense',
          limit,
          with_payload: ['id', 'chapter', 'text', 'remedies'],
          with_vector: false,
        })),
      }),
    })
    const parsed = await readJson(response, LABEL)
    const results = isRecord(parsed) ? parsed.result : undefined
    if (!Array.isArray(results) || results.length !== embeddings.length) {
      throw new ProviderError('Qdrant returned no rubrics')
    }
    return results.map((result) => {
      const points = isRecord(result) ? result.points : undefined
      if (!Array.isArray(points)) throw new ProviderError('Qdrant returned no rubrics')
      return points.map((point) => toRubric(this.#collection, isRecord(point) ? point.payload : undefined))
    })
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const response = await send(
      this.#fetch,
      this.#url + path,
      { ...init, headers: this.#headers },
      { label: LABEL, timeoutMs: this.#timeoutMs },
    )
    if (!response.ok) throw new ProviderError(`${LABEL} request failed with status ${response.status}`)
    return response
  }
}

function toRubric(bookId: string, payload: unknown): Rubric {
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'string' ||
    typeof payload.chapter !== 'string' ||
    typeof payload.text !== 'string' ||
    !Array.isArray(payload.remedies)
  ) {
    throw new ProviderError('Qdrant returned an invalid rubric')
  }
  const remedies = payload.remedies.map((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Number.isInteger(entry[1])) {
      throw new ProviderError('Qdrant returned an invalid rubric')
    }
    return [entry[0], entry[1] as number] as const
  })
  return { id: payload.id, bookId, chapter: payload.chapter, text: payload.text, remedies }
}
