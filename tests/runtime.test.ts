import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadCorpus, loadSettings } from '../src/runtime.ts'
import { ConfigurationError, ProviderError, ProviderTimeoutError, TokenExhaustionError } from '../src/errors.ts'
import { DEFAULT_OPENROUTER_BASE_URL } from '../src/embeddings.ts'
import { OpenRouterChatClient } from '../src/generation.ts'
import { fakeFetch, json, sse, stream, timeout } from './fakes.ts'

describe('settings', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'homeoremedica-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('defaults to GPT-6 Luna and reads provider keys', () => {
    const settings = loadSettings(
      { OPENROUTER_API_KEY: 'openrouter-key', QDRANT_URL: 'https://qdrant.example', QDRANT_API_KEY: 'qdrant-key' },
      directory,
    )

    expect(settings).toEqual({
      qdrantUrl: 'https://qdrant.example',
      qdrantApiKey: 'qdrant-key',
      model: 'openai/gpt-6-luna',
      maxOutputTokens: 8_192,
      openrouterApiKey: 'openrouter-key',
      firebaseProjectId: undefined,
      firebaseApiKey: undefined,
      firebaseAuthDomain: undefined,
      webOrigins: [],
      minAndroidVersionCode: 0,
    })
  })

  it('prefers the environment, then .env.local, then .env', () => {
    writeFileSync(join(directory, '.env'), 'RAG_MODEL=from-env-file\nOPENROUTER_API_KEY=file-key\nQDRANT_URL=\n')
    writeFileSync(join(directory, '.env.local'), 'export RAG_MODEL="from-local"\nRAG_MAX_OUTPUT_TOKENS=1024\n')

    const settings = loadSettings({ OPENROUTER_API_KEY: 'env-key' }, directory)

    expect(settings.model).toBe('from-local')
    expect(settings.maxOutputTokens).toBe(1_024)
    expect(settings.openrouterApiKey).toBe('env-key')
    expect(settings.qdrantUrl).toBeUndefined()
  })

  it('reads the web origins as a comma-separated list', () => {
    const settings = loadSettings({ WEB_ORIGINS: 'https://homeoremedica.com, https://homeoremedica.web.app,' }, directory)

    expect(settings.webOrigins).toEqual(['https://homeoremedica.com', 'https://homeoremedica.web.app'])
  })

  it('reads the oldest Android build the API serves', () => {
    expect(loadSettings({ MIN_ANDROID_VERSION_CODE: '42' }, directory).minAndroidVersionCode).toBe(42)
    for (const code of ['-1', '4.2', 'latest', '9999999999']) {
      expect(() => loadSettings({ MIN_ANDROID_VERSION_CODE: code }, directory)).toThrow(/MIN_ANDROID_VERSION_CODE/)
    }
  })

  it.each(['0', '8193', 'many', '12.5'])('rejects RAG_MAX_OUTPUT_TOKENS=%s', (value) => {
    expect(() => loadSettings({ RAG_MAX_OUTPUT_TOKENS: value }, directory)).toThrow(ConfigurationError)
  })

  it('requires a Qdrant URL to load the corpus', () => {
    expect(() => loadCorpus(loadSettings({}, directory))).toThrow(/QDRANT_URL/)
  })
})

describe('OpenRouter chat client', () => {
  const client = (fetch: ReturnType<typeof fakeFetch>) =>
    new OpenRouterChatClient({ apiKey: 'openrouter-key', model: 'openai/gpt-6-luna', maxOutputTokens: 4_096, fetch })

  const delta = (content: string, extra: Record<string, unknown> = {}) => ({ choices: [{ delta: { content }, ...extra }] })

  it('streams a chat request with hidden reasoning', async () => {
    const fetch = fakeFetch(
      sse(delta('Grounded '), delta('answer.', { finish_reason: 'stop' }), { choices: [], usage: { cost: 0.001 } }),
    )
    const pieces: string[] = []

    const answer = await client(fetch).generate('Retrieved evidence', {
      systemInstruction: 'Use citations.',
      onText: (text) => pieces.push(text),
    })

    expect(answer).toBe('Grounded answer.')
    expect(pieces).toEqual(['Grounded ', 'answer.'])
    expect(fetch.calls).toEqual([
      {
        url: `${DEFAULT_OPENROUTER_BASE_URL}/chat/completions`,
        method: 'POST',
        headers: { Authorization: 'Bearer openrouter-key', 'Content-Type': 'application/json' },
        body: {
          model: 'openai/gpt-6-luna',
          messages: [
            { role: 'system', content: 'Use citations.' },
            { role: 'user', content: 'Retrieved evidence' },
          ],
          reasoning: { effort: 'medium', exclude: true },
          max_tokens: 4_096,
          stream: true,
        },
      },
    ])
  })

  it('reasons as little as it is asked to', async () => {
    const fetch = fakeFetch(sse(delta('Head: pain', { finish_reason: 'stop' })))
    const quick = new OpenRouterChatClient({
      apiKey: 'openrouter-key',
      model: 'openai/gpt-6-luna',
      maxOutputTokens: 4_096,
      reasoningEffort: 'low',
      fetch,
    })

    await quick.generate('prompt', { systemInstruction: 'instruction' })

    expect(fetch.calls[0]?.body).toMatchObject({ reasoning: { effort: 'low', exclude: true } })
  })

  it.each(['', 'The patient is bruised and sore, especially after an injury.'])(
    'rejects length-limited responses (%j)',
    async (content) => {
      const fetch = fakeFetch(sse(delta(content, { finish_reason: 'length' })))

      await expect(client(fetch).generate('prompt', { systemInstruction: 'instruction' })).rejects.toThrow(
        TokenExhaustionError,
      )
    },
  )

  it('reads events split across chunks and CRLF line endings', async () => {
    const fetch = fakeFetch(stream('data: {"choices":[{"delta":{"con', 'tent":"Split."}}]}\r\n\r\n', 'data: [DONE]\r\n'))

    expect(await client(fetch).generate('prompt', { systemInstruction: 'instruction' })).toBe('Split.')
  })

  it.each([
    sse({ choices: [] }),
    sse({ error: { message: 'provider secret' } }),
    sse(delta('Half an answer'), { error: { message: 'provider secret' }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] }),
    sse({ choices: 'none' }),
    sse(delta('  ')),
    stream('data: not json\n\n'),
    new Response(null, { status: 200 }),
  ])('rejects unusable responses', async (response) => {
    await expect(client(fakeFetch(response)).generate('prompt', { systemInstruction: 'instruction' })).rejects.toThrow(
      ProviderError,
    )
  })

  it('requires a key', () => {
    expect(
      () => new OpenRouterChatClient({ apiKey: undefined, model: 'openai/gpt-6-luna', maxOutputTokens: 4_096 }),
    ).toThrow(/OPENROUTER_API_KEY/)
  })

  it.each([timeout(), json({}, 504)])('classifies timeouts without exposing details', async (response) => {
    const error = await client(fakeFetch(response))
      .generate('prompt', { systemInstruction: 'instruction' })
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ProviderTimeoutError)
    expect(String(error)).toMatch(/timed out/)
    expect(String(error)).not.toContain('timeout secret')
  })

  it('does not include provider response bodies in errors', async () => {
    const fetch = fakeFetch(new Response('provider secret response', { status: 502 }))

    const error = await client(fetch)
      .generate('prompt', { systemInstruction: 'instruction' })
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ProviderError)
    expect(String(error)).toMatch(/status 502/)
    expect(String(error)).not.toContain('provider secret response')
  })
})
