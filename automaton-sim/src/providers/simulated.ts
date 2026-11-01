/**
 * Virtual infrastructure providers for SIMULATION / SHADOW.
 *
 * They never touch the network. They can be configured to fail with a given
 * probability so that provider-outage behaviour is testable.
 */

import type { ComputeJobResult, ComputeProvider, HostingProvider, ProvisionResult } from "./interfaces.js";
import type { PricingCatalog } from "../economy/pricing.js";
import type { SeededRandom } from "../core/rng.js";
import type { DatabasePlan, HostingPlan } from "../core/types.js";
import { ProviderFailureError } from "../core/errors.js";

export interface SimulatedProviderOptions {
  failureRate?: number;
  rng?: SeededRandom;
}

export class SimulatedHostingProvider implements HostingProvider {
  readonly kind = "simulated" as const;
  private readonly failureRate: number;
  private readonly rng: SeededRandom | null;
  failures = 0;

  constructor(
    private readonly pricing: PricingCatalog,
    options: SimulatedProviderOptions = {},
  ) {
    this.failureRate = options.failureRate ?? 0;
    this.rng = options.rng ?? null;
  }

  private maybeFail(what: string): void {
    if (this.failureRate > 0 && this.rng && this.rng.chance(this.failureRate)) {
      this.failures++;
      throw new ProviderFailureError(`simulated hosting provider outage during ${what}`, "simulated_hosting");
    }
  }

  changePlan(agentId: string, from: HostingPlan, to: HostingPlan): ProvisionResult {
    this.maybeFail(`plan change ${from} -> ${to}`);
    return {
      resourceId: `host_${agentId}_${to}`,
      setupCost: 0,
      basis: "market_price",
      note: `hosting plan ${from} -> ${to}; recurring ${this.pricing.hostingMonthly(to).amount} micro/month`,
    };
  }

  changeDatabasePlan(agentId: string, from: DatabasePlan, to: DatabasePlan): ProvisionResult {
    this.maybeFail(`database plan change ${from} -> ${to}`);
    return {
      resourceId: `db_${agentId}_${to}`,
      setupCost: 0,
      basis: "market_price",
      note: `database plan ${from} -> ${to}`,
    };
  }

  registerDomain(agentId: string, name: string): ProvisionResult {
    this.maybeFail(`domain registration ${name}`);
    const price = this.pricing.domainYearly();
    return {
      resourceId: `domain_${agentId}_${name}`,
      setupCost: price.amount,
      basis: price.basis,
      note: `domain ${name} registered for 1 year`,
    };
  }

  deploy(agentId: string, productId: string, version: number): ProvisionResult {
    this.maybeFail(`deployment of ${productId} v${version}`);
    const price = this.pricing.deployment();
    return {
      resourceId: `deploy_${agentId}_${productId}_v${version}`,
      setupCost: price.amount,
      basis: price.basis,
      note: `deployed ${productId} v${version}`,
    };
  }

  canServeRequest(plan: HostingPlan, servedToday: number): boolean {
    if (plan === "free") return servedToday < this.pricing.freeTierRequestsPerDay();
    return true;
  }
}

export class SimulatedComputeProvider implements ComputeProvider {
  readonly kind = "simulated" as const;
  private readonly failureRate: number;
  private readonly rng: SeededRandom | null;
  failures = 0;

  constructor(options: SimulatedProviderOptions = {}) {
    this.failureRate = options.failureRate ?? 0;
    this.rng = options.rng ?? null;
  }

  runJob<T>(agentId: string, job: () => T): { result: T; compute: ComputeJobResult } {
    if (this.failureRate > 0 && this.rng && this.rng.chance(this.failureRate)) {
      this.failures++;
      throw new ProviderFailureError(`simulated compute outage for agent ${agentId}`, "simulated_compute");
    }
    const result = job();
    return { result, compute: { units: 1 } };
  }
}
