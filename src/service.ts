import {
  type AnswerGenerator,
  CORPUS_VERSION,
  type ChatOptions,
  type ChatRequest,
  type ChatResponse,
  type Citation,
  type CompactRequest,
  type CompactResponse,
  KEPT_TURNS,
  MAX_CITATION_TEXT_CHARS,
  MAX_GENERATED_ANSWER_CHARS,
  MAX_GENERATION_PROMPT_CHARS,
  MAX_TURN_CHARS,
  type Retrieval,
  type Retriever,
} from './contracts.ts'
import { shouldCompact } from './conversation.ts'
import { COMPACTION_INSTRUCTION, REPLY_INSTRUCTION, SYSTEM_INSTRUCTION, compactionPrompt, generationPrompt, replyPrompt } from './generation.ts'

/** How many passages of each book an answer is generated from. */
export const SOURCE_LIMIT = 2

/** Own the complete retrieve-and-generate sequence behind one narrow chat method. */
export class ChatService {
  readonly #retriever: Retriever
  readonly #generator: AnswerGenerator
  readonly #sourceLimit: number
  readonly #promptCharLimit: number

  // The default prompt limit, about 16,000 tokens at four characters per token, fits well within
  // the answer model's context window without needing a tokenizer in the serving container.
  constructor({
    retriever,
    generator,
    sourceLimit = SOURCE_LIMIT,
    promptCharLimit = MAX_GENERATION_PROMPT_CHARS,
  }: {
    retriever: Retriever
    generator: AnswerGenerator
    sourceLimit?: number
    promptCharLimit?: number
  }) {
    this.#retriever = retriever
    this.#generator = generator
    this.#sourceLimit = sourceLimit
    this.#promptCharLimit = promptCharLimit
  }

  get modelName(): string {
    return this.#generator.model
  }

  async chat(request: ChatRequest, { onSources, onText, signal }: ChatOptions = {}): Promise<ChatResponse> {
    // Condense a nearly full chat while the books are searched. When either fails, the other stops
    // and the question fails with the error that came first.
    const abandoned = new AbortController()
    const stopped = signal ? AbortSignal.any([signal, abandoned.signal]) : abandoned.signal
    let compactionFailure: unknown
    const compacting = shouldCompact(request)
      ? this.compact(request, { signal: stopped }).catch((error: unknown) => {
          compactionFailure ??= error
          abandoned.abort()
          throw error
        })
      : undefined
    // A compaction left behind by a failed search is stopped, not awaited.
    compacting?.catch(() => {})
    let retrieval: Retrieval
    try {
      retrieval = await this.#retriever.retrieve(request, { limit: this.#sourceLimit, signal: stopped })
      // Reject an unusable corpus before paying for an answer.
      if (retrieval.sources.some((source) => source.text.length > MAX_CITATION_TEXT_CHARS)) {
        throw new RangeError('citation text is too long')
      }
    } catch (error) {
      abandoned.abort()
      throw compactionFailure ?? error
    }
    const { sources } = retrieval

    const citations: Citation[] = sources.map((source) => ({
      id: `${CORPUS_VERSION}/${source.bookId}/${source.chunkId}`,
      bookId: source.bookId,
      bookTitle: source.bookTitle,
      author: source.author,
      remedyName: source.remedyName,
      sectionTitle: source.sectionTitle,
      passageIndexes: source.passageIndexes,
      text: source.text,
    }))
    onSources?.(citations)

    const compacted = await compacting
    // A message the books have nothing on, such as thanks or a question they do not cover, gets a
    // short reply instead of an answer.
    const [prompt, systemInstruction] = sources.length
      ? [generationPrompt({ ...request, ...compacted }, retrieval, { maxChars: this.#promptCharLimit }), SYSTEM_INSTRUCTION]
      : [replyPrompt(request), REPLY_INSTRUCTION]
    let streamed = 0
    let generatedAnswer = (
      await this.#generator.generate(prompt, {
        systemInstruction,
        signal,
        // Stream no more than the answer limit; the final answer is authoritative.
        onText:
          onText &&
          ((text) => {
            const piece = text.slice(0, MAX_GENERATED_ANSWER_CHARS - streamed)
            streamed += piece.length
            if (piece) onText(piece)
          }),
      })
    ).trim()
    if (generatedAnswer.length > MAX_GENERATED_ANSWER_CHARS) {
      generatedAnswer = `${generatedAnswer.slice(0, MAX_GENERATED_ANSWER_CHARS).trimEnd()}…`
    }
    return {
      answer: generatedAnswer,
      corpusVersion: CORPUS_VERSION,
      model: this.#generator.model,
      sources: citations,
      ...(compacted && { compacted }),
    }
  }

  /** Condense all but the latest exchange, and any earlier summary, into a new summary. */
  async compact({ history, summary }: CompactRequest, { signal }: { signal?: AbortSignal } = {}): Promise<CompactResponse> {
    const older = { history: history.slice(0, -KEPT_TURNS), summary }
    let condensed = (
      await this.#generator.generate(compactionPrompt(older, { maxChars: this.#promptCharLimit }), {
        systemInstruction: COMPACTION_INSTRUCTION,
        signal,
      })
    ).trim()
    if (condensed.length > MAX_TURN_CHARS) condensed = `${condensed.slice(0, MAX_TURN_CHARS - 1).trimEnd()}…`
    return { summary: condensed, history: history.slice(-KEPT_TURNS) }
  }
}
