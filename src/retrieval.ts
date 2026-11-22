/** Production query embedding and corpus search. */

import {
  type Cancellable,
  type ChatRequest,
  MAX_RETRIEVAL_QUERY_CHARS,
  type QuestionKind,
  type Retrieval,
  type RetrievedSource,
  type Retriever,
} from './contracts.ts'
import { type ClinicalMatch, type ClinicalRanker, decisiveMatch, leadingClinicalRemedies } from './clinical.ts'
import { type Repertorisation, type Repertoriser, decisive, leadingRemedies } from './repertory.ts'

const PREVIOUS_QUESTIONS = 2

export interface QueryEmbedder {
  embedQuery(text: string): Promise<readonly number[]>
}

export interface SearchableRelease {
  search(
    query: string,
    embedding: readonly number[],
    options: { limit: number },
  ): Promise<readonly RetrievedSource[]>
}

export class ProductionRetriever implements Retriever {
  readonly #corpus: SearchableRelease
  readonly #embedder: QueryEmbedder
  readonly #repertory: Repertoriser | undefined
  readonly #clinical: ClinicalRanker | undefined

  /**
   * The whole corpus is searched. With a repertory, it also ranks remedies for the symptoms of a
   * question that describes a patient, and with `clinical`, Clarke's remedies for the diseases the
   * case names are ranked too. The rankings do not reorder the passages: an answer gives each its
   * own section, and weighing them into the search named their polychrests a second time in place
   * of the remedies the books found. A ranking that many remedies lead together at a low score is
   * left out. The leading remedies of each ranking are returned with the passages, and the rubrics
   * behind the repertories' as further sources.
   */
  constructor(
    corpus: SearchableRelease,
    embedder: QueryEmbedder,
    { repertory, clinical }: { repertory?: Repertoriser | undefined; clinical?: ClinicalRanker | undefined } = {},
  ) {
    this.#corpus = corpus
    this.#embedder = embedder
    this.#repertory = repertory
    this.#clinical = clinical
  }

  async retrieve(request: ChatRequest, { limit }: { limit: number }): Promise<Retrieval> {
    // Earlier questions resolve follow-ups such as "what about its mental symptoms?". Answers are
    // left out: they are long enough to drown the question in both rankings.
    const query = searchQuery(request)
    // The books are searched by the symptoms and diseases a user confirmed, in place of the
    // question they were read from, so they answer for the case as the user corrected it.
    const confirmed = [...(request.symptoms ?? []), ...(request.diseases ?? [])]
    const searched = confirmed.length ? confirmed.join('\n').slice(0, MAX_RETRIEVAL_QUERY_CHARS) : query
    const [passages, repertorisation, match] = await Promise.all([
      this.#embedder.embedQuery(searched).then((embedding) => this.#corpus.search(searched, embedding, { limit })),
      this.#repertorisation(query, request.symptoms),
      this.#clinicalMatch(query, request.diseases),
    ])
    const { remedies, rubrics } = repertorisation
      ? leadingRemedies(repertorisation, { firstSource: passages.length + 1 })
      : { remedies: [], rubrics: [] }
    return {
      sources: [...passages, ...rubrics],
      repertory: remedies,
      clinical: match ? leadingClinicalRemedies(match) : [],
    }
  }

  async kind(request: ChatRequest, options?: Cancellable): Promise<QuestionKind> {
    return this.#repertory ? this.#repertory.kind(searchQuery(request), options) : 'question'
  }

  async symptoms(request: ChatRequest, options?: Cancellable): Promise<string[]> {
    return this.#repertory ? this.#repertory.symptoms(searchQuery(request), options) : []
  }

  async diseases(request: ChatRequest, options?: Cancellable): Promise<string[]> {
    return this.#clinical ? this.#clinical.diseases(searchQuery(request), options) : []
  }

  /**
   * Clarke's remedies for the diseases the query names, if they tell remedies apart; for
   * `diseases` when the user confirmed them.
   */
  async #clinicalMatch(query: string, diseases: readonly string[] | undefined): Promise<ClinicalMatch | undefined> {
    if (!this.#clinical) return undefined
    try {
      const match = await this.#clinical.rank(query, diseases)
      return decisiveMatch(match) ? match : undefined
    } catch (error) {
      // Like the repertory's, Clarke's ranking is only a section of the answer.
      console.error("Matching Clarke's clinical terms failed; searching without them", error)
      return undefined
    }
  }

  /**
   * The repertorisation of the case the query describes, if it describes one and tells remedies
   * apart; of `symptoms` when the user confirmed them.
   */
  async #repertorisation(query: string, symptoms: readonly string[] | undefined): Promise<Repertorisation | undefined> {
    if (!this.#repertory) return undefined
    try {
      const repertorisation = await this.#repertory.repertorise(query, symptoms)
      return decisive(repertorisation) ? repertorisation : undefined
    } catch (error) {
      // The ranking is only a section of the answer; without it the books still answer.
      console.error('Repertorisation failed; searching without it', error)
      return undefined
    }
  }
}

/** The question with the ones before it, as the books and the repertories are searched. */
function searchQuery(request: ChatRequest): string {
  const questions = request.history.filter((turn) => turn.role === 'user').slice(-PREVIOUS_QUESTIONS)
  return [...questions.map((turn) => turn.content), request.message].join('\n').slice(-MAX_RETRIEVAL_QUERY_CHARS)
}
