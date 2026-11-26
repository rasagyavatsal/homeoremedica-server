import { describe, expect, it } from 'vitest'

import { ChatRequestSchema, MAX_SYMPTOM_CHARS } from '../src/contracts.ts'
import { ProviderError, ProviderTimeoutError } from '../src/errors.ts'
import { OpenRouterRewriter, REWRITE_INSTRUCTION, REWRITE_MODEL, rewriteFrom, rewritePrompt, splitCase } from '../src/rewrite.ts'
import { fakeFetch, json, timeout } from './fakes.ts'

const CHAT = ChatRequestSchema.parse({
  summary: 'They discussed Sepia.',
  history: [
    { role: 'user', content: 'Woman, 35, migraine over the left eye, worse from the sun.' },
    { role: 'assistant', content: "Kent's Repertory: Natrum muriaticum [1]." },
    { role: 'user', content: 'What are the keynotes of Sulphur?' },
    { role: 'assistant', content: 'Burning [2].' },
  ],
  message: 'Back to my patient: she also has cold feet and craves sweets.',
})

const reply = (content: unknown) => json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] })

describe('OpenRouter rewriter', () => {
  it('asks the model without reasoning for a JSON rewrite of the conversation', async () => {
    const fetch = fakeFetch(
      reply({ query: 'cold feet craves sweets', case: [1], symptoms: ['migraine over the left eye', 'worse from the sun', 'cold feet', 'craves sweets'] }),
    )

    const rewrite = await new OpenRouterRewriter({ apiKey: 'key', fetch }).rewrite(CHAT)

    expect(rewrite).toEqual({
      query: 'cold feet craves sweets',
      caseMessages: ['Woman, 35, migraine over the left eye, worse from the sun.', 'Back to my patient: she also has cold feet and craves sweets.'],
      symptoms: ['migraine over the left eye', 'worse from the sun', 'cold feet', 'craves sweets'],
    })
    expect(fetch.calls[0]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: 'Bearer key' },
      body: {
        model: REWRITE_MODEL,
        messages: [
          { role: 'system', content: REWRITE_INSTRUCTION },
          { role: 'user', content: rewritePrompt(CHAT) },
        ],
        reasoning: { enabled: false },
        response_format: { type: 'json_object' },
      },
    })
  })

  it('reads the JSON object out of surrounding text', async () => {
    const fetch = fakeFetch(reply('Here it is:\n```json\n{"query": "Sulphur", "case": [], "symptoms": []}\n```'))

    expect((await new OpenRouterRewriter({ apiKey: 'key', fetch }).rewrite(CHAT)).query).toBe('Sulphur')
  })

  it.each([
    [reply('no json here'), ProviderError],
    [json({ choices: [] }), ProviderError],
    [new Response('provider secret', { status: 500 }), ProviderError],
    [json({}, 504), ProviderTimeoutError],
    [timeout(), ProviderTimeoutError],
  ])('fails without the response body when it gets no rewrite', async (response, type) => {
    const error = await new OpenRouterRewriter({ apiKey: 'key', fetch: fakeFetch(response) }).rewrite(CHAT).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(type)
    expect(String(error)).not.toContain('provider secret')
  })

  it('requires a key', () => {
    expect(() => new OpenRouterRewriter({ apiKey: undefined })).toThrow(/OPENROUTER_API_KEY/)
  })
})

describe('rewritePrompt', () => {
  it("numbers the user's earlier messages and gives the summary first", () => {
    expect(rewritePrompt(CHAT)).toBe(
      [
        '<conversation>',
        '<summary>They discussed Sepia.</summary>',
        '<user number="1">Woman, 35, migraine over the left eye, worse from the sun.</user>',
        "<assistant>Kent's Repertory: Natrum muriaticum [1].</assistant>",
        '<user number="2">What are the keynotes of Sulphur?</user>',
        '<assistant>Burning [2].</assistant>',
        '<latest_user_message>Back to my patient: she also has cold feet and craves sweets.</latest_user_message>',
        '</conversation>',
      ].join('\n'),
    )
  })
})

describe('rewriteFrom', () => {
  it('keeps only the earlier messages that exist, in order', () => {
    expect(rewriteFrom(CHAT, { query: 'q', case: [2, 9, 0, '1', 1.5, 2] }).caseMessages).toEqual([
      'Woman, 35, migraine over the left eye, worse from the sun.',
      'What are the keynotes of Sulphur?',
      CHAT.message,
    ])
  })

  it("drops the symptoms with a word that is not in the case's messages", () => {
    const { symptoms } = rewriteFrom(CHAT, {
      query: 'q',
      case: [],
      symptoms: ['cold feet', 'icy cold feet', 'migraine over the left eye', 'craves sweets.', 'Craves sweets', 7],
    })

    // The migraine is in a message the model did not pick.
    expect(symptoms).toEqual(['cold feet', 'craves sweets'])
  })

  it('keeps an abbreviation that ends a symptom, and splits one too long to search', () => {
    const long = `Burning pain ${'and more burning, '.repeat(15)}worse at 4 p.m.`
    const request = ChatRequestSchema.parse({ message: `Wakes at 3 a.m. ${long}` })

    const { symptoms } = rewriteFrom(request, { query: 'q', case: [], symptoms: ['Wakes at 3 a.m.', long] })

    expect(long.length).toBeGreaterThan(MAX_SYMPTOM_CHARS)
    expect(symptoms).toEqual(['Wakes at 3 a.m.', 'Burning pain and more burning', 'and more burning', 'worse at 4 p.m.'])
  })

  it('searches the message as it was sent without a query', () => {
    expect(rewriteFrom(CHAT, { query: ' ' }).query).toBe(CHAT.message)
  })
})

describe('splitCase', () => {
  it('ends a symptom at a line break, a list bullet, a comma and a sentence', () => {
    expect(splitCase('- Weeps when telling her symptoms\n- Better from consolation, thirstless. Worse in a warm room.')).toEqual([
      'Weeps when telling her symptoms',
      'Better from consolation',
      'thirstless',
      'Worse in a warm room',
    ])
  })

  it('does not end a symptom at an abbreviation inside a sentence', () => {
    expect(splitCase('Wakes at 3 a.m. with palpitations; hungry at 11 a.m.')).toEqual(['Wakes at 3 a.m. with palpitations', 'hungry at 11 a.m.'])
  })

  it('splits text in any script', () => {
    expect(splitCase('रात में प्यास लगती है, बेचैनी होती है।')).toEqual(['रात में प्यास लगती है', 'बेचैनी होती है।'])
  })
})
