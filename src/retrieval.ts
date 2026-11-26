/** Production query embedding and corpus search. */

import {
  type Cancellable,
  type ChatRequest,
  MAX_RETRIEVAL_QUERY_CHARS,
  type QuestionKind,
  type RepertoryRanking,
  type Retrieval,
  type RetrievedSource,
  type Retriever,
} from './contracts.ts'
import { REPERTORIES, type Repertoriser, decisive, inRepertory, leadingRemedies } from './repertory.ts'
import { type MessageRewriter, type Rewrite, unrewritten } from './rewrite.ts'

export interface QueryEmbedder {
  embedQuery(text: string, options?: Cancellable): Promise<readonly number[]>
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
  readonly #rewriter: MessageRewriter | undefined

  /**
   * Every book is searched for passages of its own. With a repertory, the question is sorted by every
   * question of the chat while the rewriter reads it with the conversation: an off-topic one is not
   * searched for, one that describes no patient is searched by its rewrite as a standalone query, and
   * for one that describes a patient the books are searched by the user's own messages about that
   * patient, and remedies are ranked by its symptoms too, each repertory apart. The rankings do not
   * reorder the passages: an answer gives each its own section, and weighing them into the search
   * named their polychrests a second time in place of the remedies the books found. A ranking that
   * many remedies lead together at a low score is left out. The leading remedies of each ranking are
   * returned with the passages, and the rubrics behind the repertories' as further sources.
   */
  constructor(
    corpus: SearchableRelease,
    embedder: QueryEmbedder,
    { repertory, rewriter }: { repertory?: Repertoriser | undefined; rewriter?: MessageRewriter | undefined } = {},
  ) {
    this.#corpus = corpus
    this.#embedder = embedder
    this.#repertory = repertory
    this.#rewriter = rewriter
  }

  async retrieve(request: ChatRequest, { limit, signal }: { limit: number } & Cancellable): Promise<Retrieval> {
    // Stops the requests still running when the question turns out off-topic, a step fails or the user stops.
    const abandoned = new AbortController()
    const stopped = signal ? AbortSignal.any([signal, abandoned.signal]) : abandoned.signal
    try {
      return await this.#search(request, limit, stopped, abandoned)
    } catch (error) {
      abandoned.abort()
      throw error
    }
  }

  async #search(request: ChatRequest, limit: number, stopped: AbortSignal, abandoned: AbortController): Promise<Retrieval> {
    const rewriting = this.#rewrite(request, stopped)
    // A rewrite left behind by a failed sort is stopped, not awaited.
    rewriting.catch(() => {})
    // Answers are left out of the sort: they are long enough to drown the questions.
    const kind: QuestionKind = this.#repertory ? await this.#repertory.kind(questions(request), { signal: stopped }) : 'question'
    if (kind === 'off-topic') {
      abandoned.abort()
      return { sources: [], repertories: [] }
    }
    const { query, caseMessages, symptoms } = await rewriting
    // A case is searched in the user's own words, which a rewrite could lose.
    const caseText = caseMessages.join('\n')
    const searched = kind === 'case' ? caseText.slice(-MAX_RETRIEVAL_QUERY_CHARS) : query
    // A case whose symptoms the rewrite could not find in the user's words gets no ranking.
    const ranking = kind === 'case' && symptoms.length ? this.#repertory : undefined
    const [passages, repertorisation] = await Promise.all([
      this.#embedder.embedQuery(searched, { signal: stopped }).then((embedding) => this.#corpus.search(searched, embedding, { limit })),
      ranking?.repertorise(symptoms, { signal: stopped }),
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

  /** The rewrite of the latest message, or the message as it was sent without a rewriter. */
  async #rewrite(request: ChatRequest, signal: AbortSignal): Promise<Rewrite> {
    return this.#rewriter ? this.#rewriter.rewrite(request, { signal }) : unrewritten(request)
  }
}

/** Every question of the chat, oldest first, as the question is sorted. */
function questions(request: ChatRequest): string {
  const earlier = request.history.filter((turn) => turn.role === 'user').map((turn) => turn.content)
  return [...earlier, request.message].join('\n').slice(-MAX_RETRIEVAL_QUERY_CHARS)
}
