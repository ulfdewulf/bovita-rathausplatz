/**
 * SimulatedInferenceProvider
 *
 * Does not run a model. It accounts for the tokens a model call *would*
 * consume (workload with small deterministic jitter) so the economics are
 * realistic, and returns an empty text. Decisions made with this provider
 * are produced by the deterministic heuristic policy and are tagged
 * `simulated_policy`, never as model decisions.
 */

import type { InferenceProvider, InferenceRequest, InferenceResponse } from "./types.js";
import type { ModelTier } from "../economy/pricing.js";
import type { SeededRandom } from "../core/rng.js";

export class SimulatedInferenceProvider implements InferenceProvider {
  readonly kind = "simulated" as const;
  readonly producesText = false;
  calls = 0;

  constructor(private readonly rng: SeededRandom) {}

  modelFor(tier: ModelTier): string {
    return `sim-${tier}`;
  }

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    this.calls++;
    const jitterIn = 0.85 + this.rng.next() * 0.3; // ±15 %
    const jitterOut = 0.8 + this.rng.next() * 0.4; // ±20 %
    return {
      text: "",
      tokensIn: Math.round(request.workload.tokensIn * jitterIn),
      tokensOut: Math.round(request.workload.tokensOut * jitterOut),
      provider: "simulated",
      model: this.modelFor(request.tier),
      realCostMicro: 0,
      decisionSource: "simulated_policy",
    };
  }
}
