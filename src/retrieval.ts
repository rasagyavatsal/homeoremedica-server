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
import { type MessageRewriter, type Rewrite, splitCase, unrewritten } from './rewrite.ts'

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

  async retrieve(request: ChatRequest, { limit }: { limit: number }): Promise<Retrieval> {
    const abandoned = new AbortController()
    const rewriting = this.#rewrite(request, abandoned.signal)
    // Answers are left out of the sort: they are long enough to drown the questions.
    const kind: QuestionKind = this.#repertory ? await this.#repertory.kind(questions(request)) : 'question'
    if (kind === 'off-topic') {
      abandoned.abort()
      return { sources: [], repertories: [] }
    }
    const { query, caseMessages, symptoms } = await rewriting
    // A case is searched in the user's own words, which a rewrite could lose.
    const caseText = caseMessages.join('\n')
    const searched = kind === 'case' ? caseText.slice(-MAX_RETRIEVAL_QUERY_CHARS) : query
    const [passages, repertorisation] = await Promise.all([
      this.#embedder.embedQuery(searched).then((embedding) => this.#corpus.search(searched, embedding, { limit })),
      kind === 'case' ? this.#repertorisation(symptoms.length ? symptoms : splitCase(caseText)) : undefined,
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

  /** The rewrite of the latest message or, when it fails, the message as it was sent. */
  async #rewrite(request: ChatRequest, signal: AbortSignal): Promise<Rewrite> {
    if (!this.#rewriter) return unrewritten(request)
    try {
      return await this.#rewriter.rewrite(request, { signal })
    } catch (error) {
      if (!signal.aborted) console.error('Rewriting the message failed; searching it as it was sent', error)
      return unrewritten(request)
    }
  }

  /** The repertorisation of the case's symptoms. */
  async #repertorisation(symptoms: readonly string[]): Promise<Repertorisation | undefined> {
    if (!this.#repertory) return undefined
    try {
      return await this.#repertory.repertorise(symptoms)
    } catch (error) {
      // The ranking is only a section of the answer; without it the books still answer.
      console.error('Repertorisation failed; searching without it', error)
      return undefined
    }
  }
}

/** Every question of the chat, oldest first, as the question is sorted. */
function questions(request: ChatRequest): string {
  const earlier = request.history.filter((turn) => turn.role === 'user').map((turn) => turn.content)
  return [...earlier, request.message].join('\n').slice(-MAX_RETRIEVAL_QUERY_CHARS)
}
