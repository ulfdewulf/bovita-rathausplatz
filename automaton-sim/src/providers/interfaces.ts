/**
 * Provider interfaces that separate the business logic from the world.
 *
 * SIMULATION wires virtual implementations, LIVE will wire real adapters.
 * The agent and the economic core only ever see these interfaces.
 */

import type { HostingPlan, DatabasePlan } from "../core/types.js";
import type { Micro } from "../core/money.js";

export interface ProvisionResult {
  resourceId: string;
  /** Cost booked immediately (setup fees); recurring costs run through billing. */
  setupCost: Micro;
  basis: "actual" | "market_price" | "assumption";
  note: string;
}

export interface HostingProvider {
  readonly kind: "simulated" | "live";
  /** Switch the hosting plan. Must be side-effect free on failure. */
  changePlan(agentId: string, from: HostingPlan, to: HostingPlan): ProvisionResult;
  changeDatabasePlan(agentId: string, from: DatabasePlan, to: DatabasePlan): ProvisionResult;
  registerDomain(agentId: string, name: string): ProvisionResult;
  /** Deploy a service version. On free tiers this is free; it can still fail. */
  deploy(agentId: string, productId: string, version: number): ProvisionResult;
  /** Whether a request can be served under the current plan (free-tier limits). */
  canServeRequest(plan: HostingPlan, servedToday: number): boolean;
}

export interface ComputeJobResult {
  /** CPU units consumed (abstract). */
  units: number;
}

export interface ComputeProvider {
  readonly kind: "simulated" | "live";
  /** Run a fulfilment job; throws ProviderFailureError on outage. */
  runJob<T>(agentId: string, job: () => T): { result: T; compute: ComputeJobResult };
}
