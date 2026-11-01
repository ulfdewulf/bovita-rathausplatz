/**
 * InfrastructureBilling
 *
 * Recurring costs accrue every virtual hour for every paid resource the
 * agent keeps running, whether or not the agent does anything. Free tiers
 * are booked once per day with a zero amount (so the dashboard shows that
 * the resource exists and what its usage limit is). If an agent cannot pay
 * for the next hour of infrastructure, the billing reports a failure; the
 * world then declares the agent DEAD (it cannot pay for its own existence).
 */

import type { LedgerAuthority } from "./authority.js";
import type { PricingCatalog } from "./pricing.js";
import type { WalletProvider } from "./wallet.js";
import type { InfrastructureState } from "../core/types.js";
import type { RuntimePlan } from "../agent/strategy.js";

export interface BillableInfrastructure extends InfrastructureState {
  runtimePlan: RuntimePlan;
}
import { InsufficientFundsError } from "../core/errors.js";
import type { Micro } from "../core/money.js";

export interface BillingResult {
  charged: Micro;
  /** True if a mandatory charge could not be paid. */
  unpaid: boolean;
  details: string[];
}

export class InfrastructureBilling {
  constructor(
    private readonly pricing: PricingCatalog,
    private readonly authority: LedgerAuthority,
  ) {}

  /** Cost of one hour of the current infrastructure (used by survival logic). */
  hourlyCost(infra: BillableInfrastructure): Micro {
    return (
      this.pricing.runtimeHourly(infra.runtimePlan).amount +
      this.pricing.hostingHourly(infra.hostingPlan).amount +
      this.pricing.databaseHourly(infra.databasePlan).amount
    );
  }

  accrueHour(agentId: string, wallet: WalletProvider, infra: BillableInfrastructure, day: number, hour: number): BillingResult {
    const result: BillingResult = { charged: 0, unpaid: false, details: [] };

    // The agent's own runtime is mandatory: if it cannot be paid, the agent cannot exist.
    const runtime = this.pricing.runtimeHourly(infra.runtimePlan);
    if (runtime.amount > 0) {
      if (!this.tryDebit(wallet, runtime.amount, "compute", runtime.basis, `agent runtime ${infra.runtimePlan} (1h)`, `infra:${agentId}:${day}:${hour}:runtime`, result)) {
        result.unpaid = true;
        return result;
      }
    }

    // Reset free tier counters at the start of each virtual day.
    if (infra.freeTierDay !== day) {
      infra.freeTierDay = day;
      infra.freeTierRequestsToday = 0;
    }

    const hosting = this.pricing.hostingHourly(infra.hostingPlan);
    if (hosting.amount > 0) {
      if (!this.tryDebit(wallet, hosting.amount, "hosting", hosting.basis, `hosting ${infra.hostingPlan} (1h)`, `infra:${agentId}:${day}:${hour}:hosting`, result)) {
        result.unpaid = true;
        return result;
      }
    } else if (hour === 0) {
      wallet.debit(
        {
          amount: 0,
          category: "hosting",
          basis: hosting.basis,
          description: `hosting free tier day ${day} (limit ${this.pricing.freeTierRequestsPerDay()} requests/day)`,
          idempotencyKey: `infra:${agentId}:${day}:free-hosting`,
        },
        this.authority,
      );
      result.details.push("free hosting tier booked at 0");
    }

    const db = this.pricing.databaseHourly(infra.databasePlan);
    if (db.amount > 0) {
      if (!this.tryDebit(wallet, db.amount, "database", db.basis, `database ${infra.databasePlan} (1h)`, `infra:${agentId}:${day}:${hour}:database`, result)) {
        result.unpaid = true;
        return result;
      }
    } else if (infra.databasePlan === "free" && hour === 0) {
      wallet.debit(
        {
          amount: 0,
          category: "database",
          basis: db.basis,
          description: `database free tier day ${day}`,
          idempotencyKey: `infra:${agentId}:${day}:free-db`,
        },
        this.authority,
      );
    }

    // Yearly domain renewal (booked at hour 0 of the renewal day).
    if (infra.domainRegistered && infra.domainRenewalDay !== null && day >= infra.domainRenewalDay && hour === 0) {
      const dom = this.pricing.domainYearly();
      if (this.tryDebit(wallet, dom.amount, "domain", dom.basis, `domain renewal (1 year)`, `infra:${agentId}:${day}:domain-renewal`, result)) {
        infra.domainRenewalDay = day + 365;
      } else {
        infra.domainRegistered = false;
        infra.domainRenewalDay = null;
        result.details.push("domain lapsed: renewal unaffordable");
      }
    }

    return result;
  }

  private tryDebit(
    wallet: WalletProvider,
    amount: Micro,
    category: "hosting" | "database" | "domain" | "compute",
    basis: "actual" | "market_price" | "assumption",
    description: string,
    idempotencyKey: string,
    result: BillingResult,
  ): boolean {
    try {
      wallet.debit({ amount, category, basis, description, idempotencyKey }, this.authority);
      result.charged += amount;
      result.details.push(`${description}: ${amount} micro`);
      return true;
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        result.details.push(`${description}: UNPAID (insufficient funds)`);
        return false;
      }
      // Duplicate (already billed for this hour after a restart) is not an error.
      if ((err as { code?: string }).code === "DUPLICATE_ENTRY") {
        result.details.push(`${description}: already billed`);
        return true;
      }
      throw err;
    }
  }
}
