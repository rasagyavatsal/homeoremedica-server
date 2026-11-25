/** Production query embedding and corpus search. */

import {
  type ChatRequest,
  MAX_RETRIEVAL_QUERY_CHARS,
  type QuestionKind,
  type RepertoryRanking,
  type Retrieval,
  type RetrievedSource,
  type Retriever,
} from './contracts.ts'
import { REPERTORIES, type Repertorisation, type Repertoriser, decisive, inRepertory, leadingRemedies } from './repertory.ts'

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

  /**
   * Every book is searched for passages of its own. With a repertory, the question is sorted first:
   * an off-topic one is not searched for, and for one that describes a patient remedies are ranked
   * by its symptoms too, each repertory apart. The rankings do not reorder
   * the passages: an answer gives each its own section, and weighing them into the search named
   * their polychrests a second time in place of the remedies the books found. A ranking that many
   * remedies lead together at a low score is left out. The leading remedies of each ranking are
   * returned with the passages, and the rubrics behind the repertories' as further sources.
   */
  constructor(
    corpus: SearchableRelease,
    embedder: QueryEmbedder,
    { repertory }: { repertory?: Repertoriser | undefined } = {},
  ) {
    this.#corpus = corpus
    this.#embedder = embedder
    this.#repertory = repertory
  }

  async retrieve(request: ChatRequest, { limit }: { limit: number }): Promise<Retrieval> {
    // Earlier questions resolve follow-ups such as "what about its mental symptoms?". Answers are
    // left out: they are long enough to drown the question in both rankings.
    const query = searchQuery(request)
    // An off-topic question has nothing in the books, and only a case has symptoms to search the
    // repertories by.
    const kind: QuestionKind = this.#repertory ? await this.#repertory.kind(query) : 'question'
    if (kind === 'off-topic') return { sources: [], repertories: [] }
    const [passages, repertorisation] = await Promise.all([
      this.#embedder.embedQuery(query).then((embedding) => this.#corpus.search(query, embedding, { limit })),
      kind === 'case' ? this.#repertorisation(query) : undefined,
    ])
    // Each repertory ranks the remedies on its own, for an answer section of its own.
    const repertories: RepertoryRanking[] = []
    const rubrics: RetrievedSource[] = []
    for (const { bookId, title } of repertorisation ? REPERTORIES : []) {
      const ranked = inRepertory(repertorisation!, bookId)
      if (!decisive(ranked)) continue
      const leading = leadingRemedies(ranked, { firstSource: passages.length + rubrics.length + 1 })
      if (!leading.remedies.length) continue
      repertories.push({ bookTitle: title, remedies: leading.remedies })
      rubrics.push(...leading.rubrics)
    }
    return { sources: [...passages, ...rubrics], repertories }
  }

  /** The repertorisation of the case the query describes. */
  async #repertorisation(query: string): Promise<Repertorisation | undefined> {
    if (!this.#repertory) return undefined
    try {
      return await this.#repertory.repertorise(query)
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
