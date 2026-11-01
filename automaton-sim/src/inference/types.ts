import type { ModelTier, TokenWorkload } from "../economy/pricing.js";
import type { DecisionSource } from "../core/types.js";
import type { Micro } from "../core/money.js";

export type InferencePurpose = "decision" | "market_scan" | "build" | "improve" | "fulfilment";

export interface InferenceRequest {
  purpose: InferencePurpose;
  tier: ModelTier;
  /** Prompt for real models. Ignored by the simulated provider. */
  prompt: string;
  system?: string;
  expectJson?: boolean;
  /** Token workload assumed for the simulated provider / cost estimate. */
  workload: TokenWorkload;
}

export interface InferenceResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: "simulated" | "ollama" | "external";
  model: string;
  /** Real money spent on this call (0 unless an external metered API was used). */
  realCostMicro: Micro;
  decisionSource: DecisionSource;
}

export interface InferenceProvider {
  readonly kind: "simulated" | "ollama" | "external";
  /** Whether this provider produces real model output (vs. synthetic token accounting only). */
  readonly producesText: boolean;
  modelFor(tier: ModelTier): string;
  complete(request: InferenceRequest): Promise<InferenceResponse>;
}
