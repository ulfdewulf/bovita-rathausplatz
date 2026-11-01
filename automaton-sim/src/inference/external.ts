/**
 * ExternalApiInferenceProvider — metered OpenAI-compatible chat API.
 *
 * Allowed only when the SafetyGate permits `external_paid_api` (SHADOW with
 * AUTOMATON_ALLOW_PAID_INFERENCE=yes, or LIVE) AND the RealCostTracker cap
 * has room for the estimated cost. Real spend is recorded on the tracker
 * separately from the virtual economy.
 */

import type { InferenceProvider, InferenceRequest, InferenceResponse } from "./types.js";
import type { ModelTier, PricingCatalog } from "../economy/pricing.js";
import type { SafetyGate } from "../core/mode.js";
import type { RealCostTracker } from "../economy/real-cost-tracker.js";
import { ProviderFailureError } from "../core/errors.js";

export interface ExternalApiOptions {
  baseUrl: string;
  apiKey: string;
  models?: Partial<Record<ModelTier, string>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  wallClock?: () => string;
}

export class ExternalApiInferenceProvider implements InferenceProvider {
  readonly kind = "external" as const;
  readonly producesText = true;
  private readonly models: Record<ModelTier, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly wallClock: () => string;

  constructor(
    private readonly gate: SafetyGate,
    private readonly realCosts: RealCostTracker,
    private readonly pricing: PricingCatalog,
    private readonly options: ExternalApiOptions,
  ) {
    if (!options.apiKey) throw new ProviderFailureError("external API key missing", "external");
    this.models = {
      frontier: options.models?.frontier ?? "gpt-4.1",
      standard: options.models?.standard ?? "gpt-4.1-mini",
      economy: options.models?.economy ?? "gpt-4.1-nano",
      local: options.models?.local ?? "gpt-4.1-nano",
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.wallClock = options.wallClock ?? (() => new Date().toISOString());
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    const model = this.modelFor(request.tier);
    // 1. Mode check (throws in SIMULATION, and in SHADOW without approval).
    this.gate.assertAllowed("external_paid_api", `metered inference ${model} for ${request.purpose}`);
    // 2. Real cost cap check with the estimated workload.
    const estimate = this.pricing.inferenceCost(request.tier, request.workload.tokensIn, request.workload.tokensOut).amount;
    this.realCosts.assertWithinCap(estimate);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            ...(request.system ? [{ role: "system", content: request.system }] : []),
            { role: "user", content: request.prompt },
          ],
          response_format: request.expectJson ? { type: "json_object" } : undefined,
        }),
      });
      if (!res.ok) throw new ProviderFailureError(`external API returned HTTP ${res.status}`, "external");
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const tokensIn = data.usage?.prompt_tokens ?? request.workload.tokensIn;
      const tokensOut = data.usage?.completion_tokens ?? request.workload.tokensOut;
      const actual = this.pricing.inferenceCost(request.tier, tokensIn, tokensOut).amount;
      this.realCosts.record(
        { provider: "external", model, tokensIn, tokensOut, amount: actual, description: request.purpose },
        this.wallClock(),
      );
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        tokensIn,
        tokensOut,
        provider: "external",
        model,
        realCostMicro: actual,
        decisionSource: "llm_external",
      };
    } catch (err) {
      if (err instanceof ProviderFailureError) throw err;
      throw new ProviderFailureError(`external API call failed: ${(err as Error).message}`, "external");
    } finally {
      clearTimeout(timer);
    }
  }
}
