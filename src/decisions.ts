/** Decisions from a decision model through OpenRouter: rubrics that oppose a symptom, and a question's kind. */

import type { Cancellable, QuestionKind } from './contracts.ts'
import { ConfigurationError, ProviderError } from './errors.ts'
import { DEFAULT_OPENROUTER_BASE_URL } from './embeddings.ts'
import { type Fetch, isRecord, readJson, send } from './http.ts'
import type { CaseClassifier } from './repertory.ts'

/**
 * Liquid's d1.2-ultra removed fewer rubrics than Baseten's bison-1 on 19 cured cases, more of them
 * rightly, at under a third of the cost.
 */
export const DECISION_MODEL = 'liquid/d1.2-ultra'
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

  /** Each question's answer, in the order asked. */
  async answer(state: string, questions: readonly object[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const response = await send(
      this.#fetch,
      this.#url,
      {
        method: 'POST',
        headers: this.#headers,
        body: JSON.stringify({
          model: DECISION_MODEL,
          state,
          questions: Object.fromEntries(questions.map((question, index) => [`q${index}`, question])),
        }),
      },
      { label: LABEL, timeoutMs: this.#timeoutMs, signal },
    )
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

/** Asks in requests of at most MAX_DECISION_QUESTIONS, sent together. */
export class DecisionOpposites implements OppositeCheck {
  readonly #decisions: Decisions

  constructor(options: DecisionOptions) {
    this.#decisions = new Decisions(options)
  }

  async opposites(pairs: readonly SymptomRubric[]): Promise<boolean[]> {
    const batches: SymptomRubric[][] = []
    for (let start = 0; start < pairs.length; start += MAX_DECISION_QUESTIONS) {
      batches.push(pairs.slice(start, start + MAX_DECISION_QUESTIONS))
    }
    return (await Promise.all(batches.map((batch) => this.#decide(batch)))).flat()
  }

  async #decide(pairs: readonly SymptomRubric[]): Promise<boolean[]> {
    const answers = await this.#decisions.answer(
      'Symptoms of a homoeopathic case, each paired with a candidate rubric from a repertory.',
      pairs.map(({ symptom, rubric }) => ({
        type: 'noul',
        instructions: `Symptom: ${JSON.stringify(symptom)}. Rubric: ${JSON.stringify(rubric)}. Does the rubric state the opposite of the symptom?`,
      })),
    )
    return answers.map(({ noul }) => {
      if (typeof noul !== 'number') throw new ProviderError(`${LABEL} returned no answer for a question`)
      return noul >= OPPOSITE_CUTOFF
    })
  }
}

/**
 * Sorts a question with the decision model, which sorted 56 test questions as well as the chat model
 * in half the time; the fallback sorts it when the decision model fails.
 */
export class DecisionCaseClassifier implements CaseClassifier {
  readonly #decisions: Decisions
  readonly #fallback: CaseClassifier

  constructor({ fallback, ...options }: DecisionOptions & { fallback: CaseClassifier }) {
    this.#decisions = new Decisions(options)
    this.#fallback = fallback
  }

  async classify(text: string, options: Cancellable = {}): Promise<QuestionKind> {
    try {
      const [answer] = await this.#decisions.answer(
        `The latest questions a user put to a homoeopathic reference, oldest first: ${JSON.stringify(text)}`,
        [{ type: 'choice', instructions: 'What kind of message is the latest question?', criteria: KIND_CRITERIA }],
        options.signal,
      )
      const kind = answer?.choice
      if (kind === 'case' || kind === 'question' || kind === 'off-topic') return kind
      throw new ProviderError(`${LABEL} returned no answer for a question`)
    } catch (error) {
      if (options.signal?.aborted) throw error
      console.error('Sorting the question with the decision model failed; asking the chat model', error)
      return this.#fallback.classify(text, options)
    }
  }
}
