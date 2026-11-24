import { describe, expect, it } from 'vitest'

import type { QuestionKind } from '../src/contracts.ts'
import {
  DecisionCaseClassifier,
  DecisionOpposites,
  FALLBACK_DECISION_MODEL,
  KIND_CRITERIA,
  MAX_DECISION_QUESTIONS,
} from '../src/decisions.ts'
import { ProviderError } from '../src/errors.ts'
import type { Fetch } from '../src/http.ts'
import { fakeFetch, json } from './fakes.ts'

const answers = (...probabilities: number[]) =>
  json({ answers: Object.fromEntries(probabilities.map((noul, index) => [`q${index}`, { type: 'noul', noul }])) })

describe('decision opposites', () => {
  it('asks the decision model whether each rubric states the opposite of its symptom', async () => {
    const fetch = fakeFetch(answers(0.88, 0.69, 0.7))

    const opposite = await new DecisionOpposites({ apiKey: 'key', fetch }).opposites([
      { symptom: 'Thirstless', rubric: 'Stomach: thirst' },
      { symptom: 'Thirstless', rubric: 'Stomach: thirstless' },
      { symptom: 'Better in the open air', rubric: 'Generalities: walking, in open air agg' },
    ])

    expect(opposite).toEqual([true, false, true])
    expect(fetch.calls[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(fetch.calls[0]?.headers.Authorization).toBe('Bearer key')
    expect(fetch.calls[0]?.body).toMatchObject({
      model: 'liquid/d1.2-ultra',
      questions: {
        q0: {
          type: 'noul',
          instructions: 'Symptom: "Thirstless". Rubric: "Stomach: thirst". Does the rubric state the opposite of the symptom?',
        },
      },
    })
  })

  it('asks in requests of at most MAX_DECISION_QUESTIONS, in order', async () => {
    const pairs = Array.from({ length: MAX_DECISION_QUESTIONS + 2 }, (_, index) => ({ symptom: 'Thirstless', rubric: `r${index}` }))
    const fetch = fakeFetch(answers(...Array(MAX_DECISION_QUESTIONS).fill(0.1)), answers(0.1, 0.9))

    const opposite = await new DecisionOpposites({ apiKey: 'key', fetch }).opposites(pairs)

    expect(fetch.calls.map((call) => Object.keys((call.body as { questions: object }).questions).length)).toEqual([
      MAX_DECISION_QUESTIONS,
      2,
    ])
    expect(opposite.slice(-3)).toEqual([false, false, true])
  })

  it('asks d1.2 when d1.2-ultra is at capacity', async () => {
    const atCapacity = new Response('model at capacity', { status: 429 })
    const fetch = fakeFetch(atCapacity, answers(0.9))

    const opposite = await new DecisionOpposites({ apiKey: 'key', fetch }).opposites([{ symptom: 'Thirstless', rubric: 'Stomach: thirst' }])

    expect(opposite).toEqual([true])
    expect(fetch.calls.map((call) => (call.body as { model: string }).model)).toEqual(['liquid/d1.2-ultra', FALLBACK_DECISION_MODEL])
    expect(fetch.calls[1]?.body).toMatchObject({ questions: (fetch.calls[0]?.body as { questions: object }).questions })
  })

  it('fails when d1.2 is at capacity too, and only asks d1.2 for a 429', async () => {
    const twice = fakeFetch(new Response('', { status: 429 }), new Response('provider secret', { status: 429 }))
    const once = fakeFetch(new Response('provider secret', { status: 503 }))
    const pair = [{ symptom: 'Thirstless', rubric: 'Stomach: thirst' }]

    await expect(new DecisionOpposites({ apiKey: 'key', fetch: twice }).opposites(pair)).rejects.toThrow(/status 429/)
    await expect(new DecisionOpposites({ apiKey: 'key', fetch: once }).opposites(pair)).rejects.toThrow(/status 503/)
    expect(twice.calls).toHaveLength(2)
    expect(once.calls).toHaveLength(1)
  })

  it.each([
    [new Response('provider secret', { status: 500 }), /status 500/],
    [json({ answers: { q0: { type: 'noul' } } }), /no answer/],
  ])('fails without the response body when the model gives no answer', async (response, message) => {
    const error = await new DecisionOpposites({ apiKey: 'key', fetch: fakeFetch(response) })
      .opposites([{ symptom: 'Thirstless', rubric: 'Stomach: thirst' }])
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ProviderError)
    expect(String(error)).toMatch(message)
    expect(String(error)).not.toContain('provider secret')
  })

  it('requires a key', () => {
    expect(() => new DecisionOpposites({ apiKey: undefined })).toThrow(/OPENROUTER_API_KEY/)
  })
})

describe('decision case classifier', () => {
  const choice = (kind: string) => json({ answers: { q0: { type: 'choice', choice: kind } } })
  const fallback = (kind: QuestionKind) => {
    const calls: string[] = []
    return { calls, async classify(text: string) { calls.push(text); return kind } }
  }

  it('asks the decision model to choose the kind of the latest question', async () => {
    const fetch = fakeFetch(choice('off-topic'))
    const backup = fallback('case')
    const stop = new AbortController()

    const kind = await new DecisionCaseClassifier({ apiKey: 'key', fetch, fallback: backup }).classify('What is 17 times 23?', stop)

    expect(kind).toBe('off-topic')
    expect(backup.calls).toEqual([])
    expect(fetch.calls[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(fetch.calls[0]?.body).toMatchObject({
      model: 'liquid/d1.2-ultra',
      state: 'The latest questions a user put to a homoeopathic reference, oldest first: "What is 17 times 23?"',
      questions: { q0: { type: 'choice', criteria: KIND_CRITERIA } },
    })
  })

  it.each([
    ['fails', new Response('provider secret', { status: 500 })],
    ['gives no choice', json({ answers: { q0: { type: 'choice' } } })],
    ['chooses another kind', choice('remedy')],
  ])('asks the fallback when the decision model %s', async (_, response) => {
    const backup = fallback('question')

    const kind = await new DecisionCaseClassifier({ apiKey: 'key', fetch: fakeFetch(response), fallback: backup }).classify('What is Sulphur?')

    expect(kind).toBe('question')
    expect(backup.calls).toEqual(['What is Sulphur?'])
  })

  it('does not ask the fallback once the question is cancelled', async () => {
    const stop = new AbortController()
    stop.abort()
    const backup = fallback('question')
    const fetch: Fetch = async (_url, init) => {
      init?.signal?.throwIfAborted()
      return choice('case')
    }

    const error = await new DecisionCaseClassifier({ apiKey: 'key', fetch, fallback: backup })
      .classify('What is Sulphur?', stop)
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ProviderError)
    expect(backup.calls).toEqual([])
  })

  it('requires a key', () => {
    expect(() => new DecisionCaseClassifier({ apiKey: undefined, fallback: fallback('case') })).toThrow(/OPENROUTER_API_KEY/)
  })
})
