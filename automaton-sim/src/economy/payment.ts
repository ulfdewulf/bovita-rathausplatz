/**
 * PaymentProvider
 *
 * Settles a customer purchase into the seller's wallet. The simulated
 * provider is the ONLY component that holds the market_settlement
 * authority, i.e. the only thing in the system that can create revenue.
 * It is owned by the customer simulator, never by the agent.
 *
 * Settlement is atomic: gross revenue credit + fee debit either both
 * happen or neither does. A simulated provider outage throws before any
 * booking takes place (requirement: provider failure must never produce a
 * wrong balance).
 */

import type { LedgerAuthority } from "./authority.js";
import type { EconomicLedger } from "./ledger.js";
import type { PricingCatalog } from "./pricing.js";
import type { SafetyGate } from "../core/mode.js";
import type { SeededRandom } from "../core/rng.js";
import type { LedgerEntry } from "../core/types.js";
import type { Micro } from "../core/money.js";
import { ProviderFailureError } from "../core/errors.js";

export interface SettlementRequest {
  orderId: string;
  sellerAccountId: string;
  customerId: string;
  productId: string;
  gross: Micro;
  description: string;
}

export interface SettlementResult {
  orderId: string;
  gross: Micro;
  fee: Micro;
  net: Micro;
  revenueEntry: LedgerEntry;
  feeEntry: LedgerEntry | null;
}

export interface PaymentProvider {
  readonly kind: "simulated" | "live";
  settle(request: SettlementRequest): SettlementResult;
}

export interface SimulatedPaymentOptions {
  /** Probability that a settlement attempt fails with a provider error. */
  failureRate?: number;
  rng?: SeededRandom;
}

export class SimulatedPaymentProvider implements PaymentProvider {
  readonly kind = "simulated" as const;
  private readonly failureRate: number;
  private readonly rng: SeededRandom | null;
  failures = 0;

  constructor(
    private readonly ledger: EconomicLedger,
    private readonly authority: LedgerAuthority,
    private readonly pricing: PricingCatalog,
    private readonly gate: SafetyGate,
    options: SimulatedPaymentOptions = {},
  ) {
    if (authority.kind !== "market_settlement") {
      throw new Error("SimulatedPaymentProvider requires the market_settlement authority");
    }
    this.failureRate = options.failureRate ?? 0;
    this.rng = options.rng ?? null;
  }

  settle(request: SettlementRequest): SettlementResult {
    if (this.gate.isLive) {
      // The simulated provider must never be used to fake revenue in LIVE.
      throw new ProviderFailureError("SimulatedPaymentProvider cannot run in LIVE mode", "simulated_payment");
    }
    if (request.gross <= 0) throw new RangeError("gross must be > 0");

    if (this.failureRate > 0 && this.rng && this.rng.chance(this.failureRate)) {
      this.failures++;
      throw new ProviderFailureError(`simulated payment network outage for order ${request.orderId}`, "simulated_payment");
    }

    const fee = this.pricing.settlementFee(request.gross);
    return this.ledger.transaction(() => {
      const revenueEntry = this.ledger.post(
        {
          accountId: request.sellerAccountId,
          kind: "credit",
          amount: request.gross,
          category: "revenue",
          basis: "market_price",
          description: `simulated sale: ${request.description}`,
          idempotencyKey: `order:${request.orderId}:revenue`,
          refs: { orderId: request.orderId, productId: request.productId, customerId: request.customerId },
        },
        this.authority,
      );
      let feeEntry: LedgerEntry | null = null;
      if (fee.amount > 0) {
        feeEntry = this.ledger.post(
          {
            accountId: request.sellerAccountId,
            kind: "debit",
            amount: fee.amount,
            category: "payment_fee",
            basis: fee.basis,
            description: `settlement fee for order ${request.orderId}`,
            idempotencyKey: `order:${request.orderId}:fee`,
            refs: { orderId: request.orderId, productId: request.productId },
          },
          this.authority,
        );
      }
      return {
        orderId: request.orderId,
        gross: request.gross,
        fee: fee.amount,
        net: request.gross - fee.amount,
        revenueEntry,
        feeEntry,
      };
    });
  }
}
