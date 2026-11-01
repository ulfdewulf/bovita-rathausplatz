/**
 * InferenceRouter
 *
 * Chooses the model tier from the survival state and the agent's strategy,
 * reserves the estimated cost, calls the provider, then books the actual
 * cost. Provider failure => reservation released, nothing booked. Real
 * spend (external APIs) is booked with basis "actual", simulated calls with
 * basis "market_price" (the price such a call would cost at list prices).
 */

import type { InferenceProvider, InferenceRequest, InferenceResponse } from "./types.js";
import type { ModelTier, PricingCatalog } from "../economy/pricing.js";
import type { WalletProvider } from "../economy/wallet.js";
import type { LedgerAuthority } from "../economy/authority.js";
import type { SurvivalState } from "../core/types.js";
import { InsufficientFundsError } from "../core/errors.js";
import type { Micro } from "../core/money.js";

export interface TierPolicy {
  NORMAL: ModelTier;
  CONSERVE: ModelTier;
  CRITICAL: ModelTier;
}

export interface RoutedInference extends InferenceResponse {
  tier: ModelTier;
  bookedCost: Micro;
  basis: "actual" | "market_price" | "assumption";
}

export class InferenceRouter {
  constructor(
    private readonly provider: InferenceProvider,
    private readonly pricing: PricingCatalog,
    private readonly authority: LedgerAuthority,
  ) {}

  get providerKind(): InferenceProvider["kind"] {
    return this.provider.kind;
  }

  get producesText(): boolean {
    return this.provider.producesText;
  }

  selectTier(state: SurvivalState, policy: TierPolicy): ModelTier | null {
    if (state === "DEAD") return null;
    return policy[state];
  }

  estimateCost(tier: ModelTier, request: Pick<InferenceRequest, "workload">): Micro {
    return this.pricing.inferenceCost(tier, request.workload.tokensIn, request.workload.tokensOut).amount;
  }

  /**
   * Run an inference call paid from `wallet`. Throws InsufficientFundsError
   * (before calling the provider) if the estimated cost cannot be covered,
   * and re-throws provider errors after releasing the reservation.
   */
  async run(wallet: WalletProvider, request: InferenceRequest, refs: Record<string, string> = {}): Promise<RoutedInference> {
    const estimate = this.estimateCost(request.tier, request);
    // Reserve 120 % of the estimate so output-length variance is covered.
    const reserveAmount = Math.ceil(estimate * 1.2);
    if (!wallet.canAfford(reserveAmount)) {
      throw new InsufficientFundsError(wallet.id, reserveAmount, wallet.available());
    }
    const reservation = wallet.reserve(reserveAmount);
    let response: InferenceResponse;
    try {
      response = await this.provider.complete(request);
    } catch (err) {
      reservation.release();
      throw err;
    }
    const priced = this.pricing.inferenceCost(request.tier, response.tokensIn, response.tokensOut);
    const basis = response.realCostMicro > 0 ? "actual" : priced.basis;
    const amount = response.realCostMicro > 0 ? response.realCostMicro : priced.amount;
    // If the actual cost exceeds the reservation, book what is affordable and
    // flag it; the balance can never go below zero.
    const bookable = Math.min(amount, wallet.available() + reservation.amount);
    const entry = reservation.commit(
      {
        amount: bookable,
        category: "inference",
        basis,
        description: `${request.purpose} via ${response.provider}/${response.model} (${response.tokensIn} in / ${response.tokensOut} out)`,
        refs: { ...refs, purpose: request.purpose, tier: request.tier, provider: response.provider },
      },
      this.authority,
    );
    return { ...response, tier: request.tier, bookedCost: entry.amount, basis };
  }
}
