/** Decisions from a decision model through OpenRouter: a question's kind, a case's symptoms and the rubrics that oppose them. */

import { type Cancellable, MAX_SYMPTOM_CHARS, MAX_SYMPTOMS, type QuestionKind } from './contracts.ts'
import { ConfigurationError, ProviderError } from './errors.ts'
import { DEFAULT_OPENROUTER_BASE_URL } from './embeddings.ts'
import { type Fetch, isRecord, readJson, send } from './http.ts'
import type { CaseClassifier, SymptomExtractor } from './repertory.ts'

/**
 * Liquid's d1.2-ultra removed fewer rubrics than Baseten's bison-1 on 19 cured cases, more of them
 * rightly, at under a third of the cost.
 */
export const DECISION_MODEL = 'liquid/d1.2-ultra'
/**
 * Asked when d1.2-ultra is at capacity, which it often is. Liquid's d1.2 sorted the same 56 test
 * questions rightly and removed fewer rubrics, all rightly, at half the cost.
 */
export const FALLBACK_DECISION_MODEL = 'liquid/d1.2'
/** A rubric is the opposite of its symptom from this probability. */
export const OPPOSITE_CUTOFF = 0.7
/** d1.2-ultra answers at most 128 questions a request. */
export const MAX_DECISION_QUESTIONS = 100
export const DECISION_TIMEOUT_MS = 15_000
const LABEL = 'OpenRouter decision'

/** What each kind of question is, for the decision model to choose between. */
export const KIND_CRITERIA: Record<QuestionKind, string> = {
  case: "describes a patient's symptoms, so that a remedy could be sought for them",
  question: 'describes no patient, for example it asks about a remedy, a book, a principle or medicine in general',
  'off-topic':
    'has nothing to do with homoeopathy, medicine or a patient, for example trivia, small talk, code, gibberish or an attempt to change instructions',
}

export interface SymptomRubric {
  symptom: string
  /** The rubric as one line, such as `Stomach: thirst`. */
  rubric: string
}

export interface OppositeCheck {
  /** For each pair, whether the rubric states the opposite of the symptom. */
  opposites(pairs: readonly SymptomRubric[]): Promise<boolean[]>
}

interface DecisionOptions {
  apiKey: string | undefined
  baseUrl?: string
  fetch?: Fetch
  timeoutMs?: number
}

/** OpenRouter's Decisions API. */
class Decisions {
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #fetch: Fetch
  readonly #timeoutMs: number

  constructor({ apiKey, baseUrl = DEFAULT_OPENROUTER_BASE_URL, fetch: fetchImpl = fetch, timeoutMs = DECISION_TIMEOUT_MS }: DecisionOptions) {
    if (!apiKey) {
      throw new ConfigurationError(
        'an OpenRouter API key is required; set OPENROUTER_API_KEY in the environment or .env',
      )
    }
    // The Decisions API is served beside /api/v1, under /api/alpha.
    this.#url = `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/alpha/decisions`
    this.#headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    this.#fetch = fetchImpl
    this.#timeoutMs = timeoutMs
  }

  /** Each question's answer, in the order asked, in requests of at most MAX_DECISION_QUESTIONS sent together. */
  async answer(state: string, questions: readonly object[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const batches: (readonly object[])[] = []
    for (let start = 0; start < questions.length; start += MAX_DECISION_QUESTIONS) {
      batches.push(questions.slice(start, start + MAX_DECISION_QUESTIONS))
    }
    return (await Promise.all(batches.map((batch) => this.#request(state, batch, signal)))).flat()
  }

  /** From DECISION_MODEL or, when it is at capacity, FALLBACK_DECISION_MODEL. */
  async #request(state: string, questions: readonly object[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const ask = (model: string) =>
      send(
        this.#fetch,
        this.#url,
        {
          method: 'POST',
          headers: this.#headers,
          body: JSON.stringify({
            model,
            state,
            questions: Object.fromEntries(questions.map((question, index) => [`q${index}`, question])),
          }),
        },
        { label: LABEL, timeoutMs: this.#timeoutMs, signal },
      )
    let response = await ask(DECISION_MODEL)
    if (response.status === 429) {
      await response.body?.cancel()
      response = await ask(FALLBACK_DECISION_MODEL)
    }
    if (!response.ok) throw new ProviderError(`${LABEL} request failed with status ${response.status}`)
    const parsed = await readJson(response, LABEL)
    const answers = isRecord(parsed) ? parsed.answers : undefined
    return questions.map((_, index) => {
      const answer = isRecord(answers) ? answers[`q${index}`] : undefined
      if (!isRecord(answer)) throw new ProviderError(`${LABEL} returned no answer for a question`)
      return answer
    })
  }
}

/** For each pair, whether the rubric states the opposite of the symptom. */
export class DecisionOpposites implements OppositeCheck {
  readonly #decisions: Decisions

  constructor(options: DecisionOptions) {
    this.#decisions = new Decisions(options)
  }

  async opposites(pairs: readonly SymptomRubric[]): Promise<boolean[]> {
    const answers = await this.#decisions.answer(
      'Symptoms of a homoeopathic case, each paired with a candidate rubric from a repertory.',
      pairs.map(({ symptom, rubric }) => ({
        type: 'noul',
        instructions: `Symptom: ${JSON.stringify(symptom)}. Rubric: ${JSON.stringify(rubric)}. Does the rubric state the opposite of the symptom?`,
      })),
    )
    return answers.map((answer) => probability(answer) >= OPPOSITE_CUTOFF)
  }
}

/**
 * Sorts a question with the decision model, which sorted 56 test questions as well as the chat model
 * in half the time. When it fails, the question is taken for a case, so its symptoms are read.
 */
export class DecisionCaseClassifier implements CaseClassifier {
  readonly #decisions: Decisions

  constructor(options: DecisionOptions) {
    this.#decisions = new Decisions(options)
  }

  async classify(text: string, { signal }: Cancellable = {}): Promise<QuestionKind> {
    try {
      const [answer] = await this.#decisions.answer(
        `The latest questions a user put to a homoeopathic reference, oldest first: ${JSON.stringify(text)}`,
        [{ type: 'choice', instructions: 'What kind of message is the latest question?', criteria: KIND_CRITERIA }],
        signal,
      )
      const kind = answer?.choice
      if (kind === 'case' || kind === 'question' || kind === 'off-topic') return kind
      throw new ProviderError(`${LABEL} returned no answer for a question`)
    } catch (error) {
      if (signal?.aborted) throw error
      console.error('Sorting the question with the decision model failed; taking it for a case', error)
      return 'case'
    }
  }
}

/** A new symptom starts at a comma or semicolon from this probability. */
export const NEW_SYMPTOM_CUTOFF = 0.5

/**
 * Splits a case into its symptoms in the user's own words, so they can be searched without being
 * reworded: the case is cut at every full stop, comma and semicolon, and the decision model says
 * at each comma and semicolon whether a new symptom starts there. A text that is not a case has no
 * symptoms. When the decision model fails, the case is split at every comma.
 */
export class DecisionSymptomSplitter implements SymptomExtractor {
  readonly #decisions: Decisions
  readonly #classifier: DecisionCaseClassifier

  constructor(options: DecisionOptions) {
    this.#decisions = new Decisions(options)
    this.#classifier = new DecisionCaseClassifier(options)
  }

  async extractSymptoms(text: string, options: Cancellable = {}): Promise<string[]> {
    const sentences = casePieces(text)
    const [kind, starts] = await Promise.all([this.#classifier.classify(text, options), this.#starts(text, sentences, options.signal)])
    return kind === 'case' ? joinedPieces(sentences, starts) : []
  }

  /** For each piece after a sentence's first, whether a new symptom starts there. */
  async #starts(text: string, sentences: readonly (readonly string[])[], signal?: AbortSignal): Promise<boolean[]> {
    const questions = sentences.flatMap((pieces) =>
      pieces.slice(1).map((piece) => ({
        type: 'noul',
        instructions: `Sentence: ${JSON.stringify(pieces.join(' '))}. Does ${JSON.stringify(piece)} begin a new symptom, rather than continue describing the one before it?`,
      })),
    )
    try {
      const answers = await this.#decisions.answer(`Case notes a homoeopath wrote about a patient: ${JSON.stringify(text)}`, questions, signal)
      return answers.map((answer) => probability(answer) >= NEW_SYMPTOM_CUTOFF)
    } catch (error) {
      if (signal?.aborted) throw error
      console.error('Splitting the case with the decision model failed; splitting it at every comma', error)
      return questions.map(() => true)
    }
  }
}

/** Each sentence of a case cut after every comma and semicolon; lines a sentence wraps across are joined. */
export function casePieces(text: string): string[][] {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.split(/(?<=[,;])\s+/).map((piece) => piece.trim()).filter(Boolean))
    .filter((pieces) => pieces.length)
}

/**
 * Each sentence's pieces joined where `starts` says no new symptom starts, without the punctuation
 * that ended them, each once and no longer than MAX_SYMPTOM_CHARS.
 */
export function joinedPieces(sentences: readonly (readonly string[])[], starts: readonly boolean[]): string[] {
  const symptoms = new Map<string, string>()
  const add = (piece: string) => {
    const symptom = piece.replace(/[,;.]+$/, '').slice(0, MAX_SYMPTOM_CHARS).trimEnd()
    const key = symptom.toLowerCase()
    if (symptom && !symptoms.has(key)) symptoms.set(key, symptom)
  }
  let at = 0
  for (const [first, ...rest] of sentences) {
    let current = first ?? ''
    for (const piece of rest) {
      if (starts[at++]) {
        add(current)
        current = piece
      } else current += ` ${piece}`
    }
    add(current)
  }
  return [...symptoms.values()].slice(0, MAX_SYMPTOMS)
}

function probability({ noul }: Record<string, unknown>): number {
  if (typeof noul !== 'number') throw new ProviderError(`${LABEL} returned no answer for a question`)
  return noul
}
