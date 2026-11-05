import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { Embedder } from './memory.ts';

/**
 * NEAR AI Cloud gateway (OpenAI-compatible), verified 5 Nov 2026:
 *   base URL  https://cloud-api.near.ai/v1   (docs.near.ai/api-reference/introduction)
 *   models    GET https://cloud-api.near.ai/v1/models
 * Defaults: z-ai/glm-5.3-flash (owned_by nearai = runs in NEAR AI's TEE fleet,
 * supports tools + structured_outputs); embeddings Qwen/Qwen3-Embedding-0.6B (1024-d).
 */
export type NearAiConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  routerModel: string;
  embeddingModel: string;
};

export function nearAiModels(cfg: NearAiConfig): { chat: LanguageModel; router: LanguageModel } {
  const provider = createOpenAICompatible({
    name: 'nearai',
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
  });
  return { chat: provider(cfg.model), router: provider(cfg.routerModel) };
}

/** Embeddings via the OpenAI-compatible /embeddings route. */
export class NearAiEmbedder implements Embedder {
  readonly dimensions = 1024;
  constructor(private readonly cfg: NearAiConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.cfg.baseURL.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.cfg.embeddingModel, input: texts }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`embeddings failed: ${res.status}`);
    const j = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    if (!Array.isArray(j.data)) throw new Error('embeddings: bad response');
    return [...j.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
