import { describe, expect, it } from 'vitest'

import {
  DecisionCaseClassifier,
  DecisionOpposites,
  KIND_CRITERIA,
  DECISION_TIMEOUT_MS,
  MAX_DECISION_QUESTIONS,
  SORT_TIMEOUT_MS,
} from '../src/decisions.ts'
import { ProviderError, ProviderTimeoutError } from '../src/errors.ts'
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

  it('asks d1.2-ultra again, a little later each time, while it is busy', async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => void waits.push(ms)
    const fetch = fakeFetch(new Response('busy', { status: 429 }), new Response('', { status: 503 }), answers(0.9))

    const opposite = await new DecisionOpposites({ apiKey: 'key', fetch, sleep }).opposites([{ symptom: 'Thirstless', rubric: 'Stomach: thirst' }])

    expect(opposite).toEqual([true])
    expect(fetch.calls.map((call) => (call.body as { model: string }).model)).toEqual(Array(3).fill('liquid/d1.2-ultra'))
    expect(waits).toEqual([1_000, 2_000])
  })

  it('fails after three busy replies, and at once for a request it rejects', async () => {
    const sleep = async () => {}
    const busy = fakeFetch(...Array.from({ length: 3 }, () => new Response('provider secret', { status: 429 })))
    const rejected = fakeFetch(new Response('provider secret', { status: 400 }))
    const pair = [{ symptom: 'Thirstless', rubric: 'Stomach: thirst' }]

    await expect(new DecisionOpposites({ apiKey: 'key', fetch: busy, sleep }).opposites(pair)).rejects.toThrow(/status 429/)
    await expect(new DecisionOpposites({ apiKey: 'key', fetch: rejected, sleep }).opposites(pair)).rejects.toThrow(/status 400/)
    expect(busy.calls).toHaveLength(3)
    expect(rejected.calls).toHaveLength(1)
  })

  it.each([
    [new Response('provider secret', { status: 400 }), /status 400/],
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

  it('asks the decision model to choose the kind of the latest question', async () => {
    const fetch = fakeFetch(choice('off-topic'))

    const kind = await new DecisionCaseClassifier({ apiKey: 'key', fetch }).classify('What is 17 times 23?')

    expect(kind).toBe('off-topic')
    expect(fetch.calls[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(fetch.calls[0]?.body).toMatchObject({
      model: 'liquid/d1.2-ultra',
      state: 'The latest questions a user put to a homoeopathic reference, oldest first: "What is 17 times 23?"',
      questions: { q0: { type: 'choice', criteria: KIND_CRITERIA } },
    })
  })

  it.each([
    ['fails', new Response('provider secret', { status: 400 })],
    ['gives no choice', json({ answers: { q0: { type: 'choice' } } })],
    ['chooses another kind', choice('remedy')],
  ])('fails when the decision model %s', async (_, response) => {
    const error = await new DecisionCaseClassifier({ apiKey: 'key', fetch: fakeFetch(response) }).classify('What is Sulphur?').catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ProviderError)
    expect(String(error)).not.toContain('provider secret')
  })

  it('fails when sorting the question takes too long', async () => {
    const fetch: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))

    await expect(new DecisionCaseClassifier({ apiKey: 'key', fetch, timeoutMs: 10 }).classify('What is Sulphur?')).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    )
    expect(SORT_TIMEOUT_MS).toBeLessThan(DECISION_TIMEOUT_MS)
  })

  it('fails once the question is cancelled', async () => {
    const stop = new AbortController()
    stop.abort()
    const fetch: Fetch = async (_url, init) => {
      init?.signal?.throwIfAborted()
      return choice('question')
    }

    const error = await new DecisionCaseClassifier({ apiKey: 'key', fetch }).classify('What is Sulphur?', stop).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ProviderError)
  })

  it('requires a key', () => {
    expect(() => new DecisionCaseClassifier({ apiKey: undefined })).toThrow(/OPENROUTER_API_KEY/)
  })
})
