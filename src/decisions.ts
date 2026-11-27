/** Decisions from a decision model through OpenRouter: a question's kind and the rubrics that oppose a case's symptoms. */

import { type Cancellable, type QuestionKind } from './contracts.ts'
import { ConfigurationError, ProviderError, ProviderTimeoutError } from './errors.ts'
import { DEFAULT_OPENROUTER_BASE_URL } from './embeddings.ts'
import { type Fetch, INITIAL_BACKOFF_MS, MAX_ATTEMPTS, RETRYABLE_STATUS_CODES, delay, isRecord, readJson, send } from './http.ts'
import type { CaseClassifier } from './repertory.ts'

/**
 * Liquid's d1.2-ultra removed fewer rubrics than Baseten's bison-1 on 19 cured cases, more of them
 * rightly, at under a third of the cost. Liquid's d1.2 missed opposites that it found, and took a
 * question for a case, at the same speed.
 */
export const DECISION_MODEL = 'liquid/d1.2-ultra'
/** A rubric is the opposite of its symptom from this probability. */
export const OPPOSITE_CUTOFF = 0.7
/** d1.2-ultra answers at most 128 questions a request. */
export const MAX_DECISION_QUESTIONS = 100
export const DECISION_TIMEOUT_MS = 15_000
/** Each attempt to sort a question, as long as a rewrite may take: the books are not searched until it answers. */
export const SORT_TIMEOUT_MS = 8_000
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
  opposites(pairs: readonly SymptomRubric[], options?: Cancellable): Promise<boolean[]>
}

interface DecisionOptions {
  apiKey: string | undefined
  baseUrl?: string
  fetch?: Fetch
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** OpenRouter's Decisions API. */
class Decisions {
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #fetch: Fetch
  readonly #timeoutMs: number
  readonly #sleep: (ms: number) => Promise<void>

  constructor({
    apiKey,
    baseUrl = DEFAULT_OPENROUTER_BASE_URL,
    fetch: fetchImpl = fetch,
    timeoutMs = DECISION_TIMEOUT_MS,
    sleep = delay,
  }: DecisionOptions) {
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
    this.#sleep = sleep
  }

  /** Each question's answer, in the order asked, in requests of at most MAX_DECISION_QUESTIONS sent together. */
  async answer(state: string, questions: readonly object[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const batches: (readonly object[])[] = []
    for (let start = 0; start < questions.length; start += MAX_DECISION_QUESTIONS) {
      batches.push(questions.slice(start, start + MAX_DECISION_QUESTIONS))
    }
    return (await Promise.all(batches.map((batch) => this.#request(state, batch, signal)))).flat()
  }

  /** From DECISION_MODEL, asked again a little later while it is busy or failing, as embeddings are. */
  async #request(state: string, questions: readonly object[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const body = JSON.stringify({
      model: DECISION_MODEL,
      state,
      questions: Object.fromEntries(questions.map((question, index) => [`q${index}`, question])),
    })
    let backoff = INITIAL_BACKOFF_MS
    let response: Response
    for (let attempt = 1; ; attempt++) {
      response = await send(this.#fetch, this.#url, { method: 'POST', headers: this.#headers, body }, { label: LABEL, timeoutMs: this.#timeoutMs, signal })
      if (response.ok) break
      await response.body?.cancel()
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === MAX_ATTEMPTS) {
        if (response.status === 408 || response.status === 504) throw new ProviderTimeoutError(`${LABEL} request timed out`)
        throw new ProviderError(`${LABEL} request failed with status ${response.status}`)
      }
      await this.#sleep(backoff)
      backoff *= 2
    }
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

  async opposites(pairs: readonly SymptomRubric[], { signal }: Cancellable = {}): Promise<boolean[]> {
    const answers = await this.#decisions.answer(
      'Symptoms of a homoeopathic case, each paired with a candidate rubric from a repertory.',
      pairs.map(({ symptom, rubric }) => ({
        type: 'noul',
        instructions: `Symptom: ${JSON.stringify(symptom)}. Rubric: ${JSON.stringify(rubric)}. Does the rubric state the opposite of the symptom?`,
      })),
      signal,
    )
    return answers.map((answer) => probability(answer) >= OPPOSITE_CUTOFF)
  }
}

/** Sorts a question with the decision model, which sorted 56 test questions as well as the chat model in half the time. */
export class DecisionCaseClassifier implements CaseClassifier {
  readonly #decisions: Decisions

  constructor(options: DecisionOptions) {
    this.#decisions = new Decisions({ timeoutMs: SORT_TIMEOUT_MS, ...options })
  }

  async classify(messages: readonly string[], { signal }: Cancellable = {}): Promise<QuestionKind> {
    const [answer] = await this.#decisions.answer(
      // Each message apart, since a message's own line breaks would hide where the latest one starts.
      `The questions a user put to a homoeopathic reference. Earlier questions, oldest first: ${JSON.stringify(messages.slice(0, -1))}. ` +
        `Latest question: ${JSON.stringify(messages.at(-1) ?? '')}`,
      [{ type: 'choice', instructions: 'What kind of message is the latest question?', criteria: KIND_CRITERIA }],
      signal,
    )
    const kind = answer?.choice
    if (kind === 'case' || kind === 'question' || kind === 'off-topic') return kind
    throw new ProviderError(`${LABEL} returned no answer for a question`)
  }
}

function probability({ noul }: Record<string, unknown>): number {
  if (typeof noul !== 'number') throw new ProviderError(`${LABEL} returned no answer for a question`)
  return noul
}
