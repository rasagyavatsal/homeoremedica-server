import { describe, expect, it } from 'vitest'

import { DecisionOpposites, MAX_DECISION_QUESTIONS } from '../src/decisions.ts'
import { ProviderError } from '../src/errors.ts'
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
