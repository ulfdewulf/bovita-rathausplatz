/**
 * Shared domain types for the autonomous business agent simulation.
 */

import type { Micro } from "./money.js";
import type { OperatingMode } from "./mode.js";

// ─── Cost basis ───────────────────────────────────────────────────────────

/**
 *  actual        money that really left a real account (SHADOW/LIVE only)
 *  market_price  simulated at current provider list prices
 *  assumption    free parameter chosen for the experiment
 */
export type PriceBasis = "actual" | "market_price" | "assumption";

// ─── Ledger ───────────────────────────────────────────────────────────────

export type LedgerKind = "credit" | "debit";

export type LedgerCategory =
  | "capital" // founder starting capital
  | "revenue" // simulated customer payments
  | "refund"
  | "inference" // model calls
  | "compute" // build / fulfilment compute
  | "hosting"
  | "database"
  | "domain"
  | "api" // third party data APIs
  | "marketing"
  | "deployment"
  | "payment_fee"
  | "transfer_out" // replication capital to child
  | "transfer_in"
  | "other";

/** Who is allowed to post which entries. The agent never holds a credit authority. */
export type LedgerAuthorityKind =
  | "founder_capital" // initial funding, founder controls only
  | "market_settlement" // the independent customer simulator / payment provider
  | "replication_transfer" // parent -> child capital transfer by the replication controller
  | "agent_operation" // agent spending (debits only)
  | "system_billing"; // recurring infrastructure billing (debits only)

export interface LedgerEntry {
  id: string;
  seq: number;
  accountId: string;
  kind: LedgerKind;
  amount: Micro;
  balanceAfter: Micro;
  category: LedgerCategory;
  basis: PriceBasis | "n/a";
  description: string;
  authority: LedgerAuthorityKind;
  virtualTime: string;
  virtualDay: number;
  idempotencyKey: string | null;
  counterpartyAccountId: string | null;
  refs: Record<string, string>;
  /** Hash chain for tamper evidence and reproducibility checks. */
  prevHash: string;
  hash: string;
}

export interface LedgerPostRequest {
  accountId: string;
  kind: LedgerKind;
  amount: Micro;
  category: LedgerCategory;
  basis: PriceBasis | "n/a";
  description: string;
  idempotencyKey?: string;
  counterpartyAccountId?: string;
  refs?: Record<string, string>;
}

export interface DailyFinancialSummary {
  day: number;
  revenue: Micro;
  costs: Micro;
  transfersOut: Micro;
  transfersIn: Micro;
  capital: Micro;
  net: Micro;
  closingBalance: Micro;
  costsByCategory: Partial<Record<LedgerCategory, Micro>>;
  costsByBasis: Partial<Record<PriceBasis, Micro>>;
}

// ─── Survival ─────────────────────────────────────────────────────────────

export type SurvivalState = "NORMAL" | "CONSERVE" | "CRITICAL" | "DEAD";

export interface SurvivalThresholds {
  /** Enter CONSERVE below this balance or below conserveRunwayDays of runway. */
  conserveBelow: Micro;
  conserveRunwayDays: number;
  criticalBelow: Micro;
  criticalRunwayDays: number;
  /**
   * DEAD when the balance can no longer pay for the cheapest possible
   * operating step (one minimal turn + one hour of infrastructure).
   */
  deadBelow: Micro;
  /** Trailing window for burn rate estimation. */
  burnWindowDays: number;
}

export interface SurvivalAssessment {
  state: SurvivalState;
  balance: Micro;
  /** Average net daily outflow over the trailing window (positive = losing money). */
  burnRatePerDay: Micro;
  /** Days until balance hits zero at the current burn rate; null = not burning. */
  runwayDays: number | null;
  reasons: string[];
  day: number;
}

// ─── Products / offers ────────────────────────────────────────────────────

export type ProductCategory = "website_audit" | "data_cleaning" | "text_digest";

export type ProductStatus = "idea" | "building" | "testing" | "published" | "discontinued";

export interface ProductMetricsDay {
  day: number;
  awareVisitors: number;
  purchases: number;
  revenue: Micro;
  fulfilmentCosts: Micro;
  failedFulfilments: number;
  avgRating: number | null;
}

export interface Product {
  id: string;
  agentId: string;
  category: ProductCategory;
  name: string;
  /** Service implementation version, e.g. 1, 2, 3. Higher = more capable. */
  serviceVersion: number;
  price: Micro;
  status: ProductStatus;
  createdDay: number;
  publishedDay: number | null;
  discontinuedDay: number | null;
  totalPurchases: number;
  totalRevenue: Micro;
  totalFulfilmentCosts: Micro;
  totalDevelopmentCosts: Micro;
  ratings: number[]; // last N ratings, 1..5
  history: ProductMetricsDay[];
}

/** What the market sees: a published offer. Read-only for the simulator. */
export interface PublishedOffer {
  offerId: string; // = product id
  agentId: string;
  category: ProductCategory;
  name: string;
  price: Micro;
  serviceVersion: number;
  publishedDay: number;
  /** Rolling average rating 1..5, null if none. */
  avgRating: number | null;
  ratingCount: number;
}

// ─── Decisions ────────────────────────────────────────────────────────────

/**
 *  simulated_policy   deterministic rule-based decision (no model involved)
 *  llm_local          decided by a local model (Ollama)
 *  llm_external       decided by a metered external model API
 *  llm_fallback       model output invalid; heuristic fallback was used
 */
export type DecisionSource = "simulated_policy" | "llm_local" | "llm_external" | "llm_fallback";

export interface DecisionRecord {
  id: string;
  agentId: string;
  day: number;
  hour: number;
  virtualTime: string;
  survivalState: SurvivalState;
  balanceBefore: Micro;
  balanceAfter: Micro;
  source: DecisionSource;
  modelTier: string;
  rationale: string;
  actions: Array<{ type: string; params: Record<string, unknown>; outcome: string; cost: Micro }>;
  inferenceCost: Micro;
  tokensIn: number;
  tokensOut: number;
}

// ─── Infrastructure ───────────────────────────────────────────────────────

export type HostingPlan = "free" | "hobby" | "vm_small";
export type DatabasePlan = "none" | "free" | "paid";

export interface InfrastructureState {
  hostingPlan: HostingPlan;
  databasePlan: DatabasePlan;
  domainRegistered: boolean;
  domainRenewalDay: number | null;
  /** Requests served today under the free hosting tier. */
  freeTierRequestsToday: number;
  freeTierDay: number;
}

// ─── Run metadata ─────────────────────────────────────────────────────────

export interface RunMetadata {
  runId: string;
  seed: string;
  scenario: string;
  mode: OperatingMode;
  createdAtWallClock: string;
  label: string;
  disclaimer: string;
}

export const EXPERIMENT_DISCLAIMER =
  "WIRTSCHAFTLICHES EXPERIMENT / ECONOMIC EXPERIMENT: Alle Umsätze, Kosten und Guthaben sind simuliert. " +
  "Simulierte Umsätze sind keine tatsächlich erwirtschafteten Einnahmen. Keine echten Zahlungen, " +
  "keine Mainnet-Transaktionen, keine kostenpflichtigen Deployments.";
