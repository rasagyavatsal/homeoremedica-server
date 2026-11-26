/** Build the production chat service from the Qdrant collections. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

import { type Accounts, firebaseAccounts } from './accounts.ts'
import { DecisionCaseClassifier, DecisionOpposites, type OppositeCheck } from './decisions.ts'
import { ConfigurationError } from './errors.ts'
import { OpenRouterChatClient } from './generation.ts'
import { ChatService } from './service.ts'
import { VoyageQueryEmbedder } from './embeddings.ts'
import { CorpusError, QdrantCorpus } from './qdrant.ts'
import {
  BOERICKE_COLLECTION,
  type CaseClassifier,
  CombinedRubrics,
  QdrantRubrics,
  REPERTORY_COLLECTION,
  Repertory,
} from './repertory.ts'
import { ProductionRetriever } from './retrieval.ts'
import { OpenRouterRewriter } from './rewrite.ts'

export const DEFAULT_MODEL = 'openai/gpt-6-luna'
export const MAX_OUTPUT_TOKENS = 8_192

export interface Settings {
  qdrantUrl: string | undefined
  qdrantApiKey: string | undefined
  model: string
  maxOutputTokens: number
  openrouterApiKey: string | undefined
  /** Accounts are offered only when both Firebase settings are set. */
  firebaseProjectId: string | undefined
  firebaseApiKey: string | undefined
  firebaseAuthDomain: string | undefined
  /** Origins of web pages served elsewhere that may call the API. */
  webOrigins: string[]
}

/**
 * Read settings from the process environment, then `.env.local`, then `.env`.
 * Empty values count as unset.
 */
export function loadSettings(
  env: Record<string, string | undefined> = process.env,
  directory: string = process.cwd(),
): Settings {
  const values: Record<string, string | undefined> = {
    ...readEnvFile(join(directory, '.env')),
    ...readEnvFile(join(directory, '.env.local')),
    ...env,
  }
  const value = (name: string) => values[name]?.trim() || undefined
  const maxOutputTokens = value('RAG_MAX_OUTPUT_TOKENS') ?? String(MAX_OUTPUT_TOKENS)
  if (!/^\d+$/.test(maxOutputTokens) || +maxOutputTokens < 1 || +maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw new ConfigurationError(`RAG_MAX_OUTPUT_TOKENS must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`)
  }
  return {
    qdrantUrl: value('QDRANT_URL'),
    qdrantApiKey: value('QDRANT_API_KEY'),
    model: value('RAG_MODEL') ?? DEFAULT_MODEL,
    maxOutputTokens: Number(maxOutputTokens),
    openrouterApiKey: value('OPENROUTER_API_KEY'),
    firebaseProjectId: value('FIREBASE_PROJECT_ID'),
    firebaseApiKey: value('FIREBASE_API_KEY'),
    firebaseAuthDomain: value('FIREBASE_AUTH_DOMAIN'),
    webOrigins: (value('WEB_ORIGINS') ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  }
}

function readEnvFile(path: string): Record<string, string> {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  return parseEnv(content) as Record<string, string>
}

export async function buildService(settings: Settings): Promise<ChatService> {
  const embedder = new VoyageQueryEmbedder({ apiKey: settings.openrouterApiKey })
  const generator = new OpenRouterChatClient({
    apiKey: settings.openrouterApiKey,
    model: settings.model,
    maxOutputTokens: settings.maxOutputTokens,
  })
  const corpus = loadCorpus(settings)
  await corpus.verify()
  // Every book is searched while Kent's and Boericke's Repertories rank the remedies for the case's
  // symptoms, each a section of the answer of its own.
  const repertory = await loadRepertory(settings, embedder, {
    collections: [REPERTORY_COLLECTION, BOERICKE_COLLECTION],
    opposites: new DecisionOpposites({ apiKey: settings.openrouterApiKey }),
  })
  const rewriter = new OpenRouterRewriter({ apiKey: settings.openrouterApiKey })
  return new ChatService({ retriever: new ProductionRetriever(corpus, embedder, { repertory, rewriter }), generator })
}

/**
 * Repertorisation, sorted by the decision model and checked to have its Qdrant collections. With several
 * collections, each symptom is matched to its nearest rubrics in each; with `opposites`, less those
 * that state its opposite.
 */
export async function loadRepertory(
  settings: Settings,
  embedder: VoyageQueryEmbedder,
  {
    collections = [REPERTORY_COLLECTION],
    classifier = caseClassifier(settings),
    opposites,
  }: {
    collections?: readonly string[]
    classifier?: CaseClassifier
    opposites?: OppositeCheck | undefined
  } = {},
): Promise<Repertory> {
  const { qdrantUrl: url, qdrantApiKey: apiKey } = settings
  if (!url) {
    throw new ConfigurationError('a Qdrant URL is required; set QDRANT_URL in the environment or .env')
  }
  const searches = collections.map((collection) => new QdrantRubrics({ url, apiKey, collection }))
  for (const [index, search] of searches.entries()) {
    if (!(await search.exists())) throw new CorpusError(`the Qdrant collection ${collections[index]} does not exist`)
  }
  const rubrics = searches.length === 1 ? searches[0]! : new CombinedRubrics(searches)
  return new Repertory({ classifier, embedder, rubrics, opposites })
}

/** The decision model decides whether a question is a case. */
export function caseClassifier(settings: Settings): CaseClassifier {
  return new DecisionCaseClassifier({ apiKey: settings.openrouterApiKey })
}

export function loadCorpus(settings: Settings): QdrantCorpus {
  if (!settings.qdrantUrl) {
    throw new ConfigurationError('a Qdrant URL is required; set QDRANT_URL in the environment or .env')
  }
  return new QdrantCorpus({
    url: settings.qdrantUrl,
    apiKey: settings.qdrantApiKey,
  })
}

/** Sign-in and saved chats, or null when Firebase is not configured. */
export function loadAccounts(settings: Settings): Accounts | null {
  const { firebaseProjectId: projectId, firebaseApiKey: apiKey } = settings
  if (!projectId || !apiKey) return null
  return firebaseAccounts({ apiKey, projectId, authDomain: settings.firebaseAuthDomain ?? `${projectId}.firebaseapp.com` })
}
