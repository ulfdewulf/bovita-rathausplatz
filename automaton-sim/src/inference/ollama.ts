/**
 * OllamaInferenceProvider — local model via the Ollama HTTP API.
 *
 * Only loopback URLs are accepted (same rule as upstream PR #425): a local
 * model is free and private; anything non-local would be an external API
 * and has to go through the ExternalApiInferenceProvider with its cap.
 */

import type { InferenceProvider, InferenceRequest, InferenceResponse } from "./types.js";
import type { ModelTier } from "../economy/pricing.js";
import { ProviderFailureError } from "../core/errors.js";

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;

export interface OllamaOptions {
  baseUrl?: string;
  models?: Partial<Record<ModelTier, string>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OllamaInferenceProvider implements InferenceProvider {
  readonly kind = "ollama" as const;
  readonly producesText = true;
  private readonly baseUrl: string;
  private readonly models: Record<ModelTier, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    if (!LOOPBACK.test(this.baseUrl)) {
      throw new ProviderFailureError(`Ollama base URL must be loopback, got ${this.baseUrl}`, "ollama");
    }
    const defaultModel = options.models?.standard ?? "qwen2.5:7b";
    this.models = {
      frontier: options.models?.frontier ?? defaultModel,
      standard: defaultModel,
      economy: options.models?.economy ?? defaultModel,
      local: options.models?.local ?? defaultModel,
    };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    const model = this.modelFor(request.tier);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: request.expectJson ? "json" : undefined,
          messages: [
            ...(request.system ? [{ role: "system", content: request.system }] : []),
            { role: "user", content: request.prompt },
          ],
        }),
      });
      if (!res.ok) {
        throw new ProviderFailureError(`Ollama returned HTTP ${res.status}`, "ollama");
      }
      const data = (await res.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      return {
        text: data.message?.content ?? "",
        tokensIn: data.prompt_eval_count ?? request.workload.tokensIn,
        tokensOut: data.eval_count ?? request.workload.tokensOut,
        provider: "ollama",
        model,
        realCostMicro: 0,
        decisionSource: "llm_local",
      };
    } catch (err) {
      if (err instanceof ProviderFailureError) throw err;
      throw new ProviderFailureError(`Ollama call failed: ${(err as Error).message}`, "ollama");
    } finally {
      clearTimeout(timer);
    }
  }
}
