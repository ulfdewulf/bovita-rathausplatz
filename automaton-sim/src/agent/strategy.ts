/**
 * AgentStrategy — the only thing the agent is allowed to change about itself.
 *
 * Every change goes through StrategyHistory.propose(), which validates the
 * new version against hard invariants ("tests") and records it with the
 * agent's rationale. The market rules, the pricing catalog and the survival
 * thresholds are not part of the strategy and cannot be touched here.
 */

import type { HostingPlan, ProductCategory, SurvivalState } from "../core/types.js";
import type { ModelTier } from "../economy/pricing.js";
import { MODEL_TIERS } from "../economy/pricing.js";

export type RuntimePlan = "shared" | "vm_small";

export interface ReplicationPolicy {
  enabled: boolean;
  /** Consecutive days with positive net cash flow required. */
  minPositiveCashflowDays: number;
  childCapitalUsd: number;
  /** Parent must keep at least this much after funding a child. */
  minReserveAfterUsd: number;
  maxChildren: number;
}

export interface AgentStrategy {
  version: number;
  createdDay: number;
  rationale: string;
  /** Categories in order of preference. */
  focusCategories: ProductCategory[];
  pricingUsd: Record<ProductCategory, number>;
  maxConcurrentProducts: number;
  marketingDailyBudgetUsd: number;
  /** Market when fewer aware visitors/day than this (7-day average). */
  marketingVisitorThreshold: number;
  decisionTiers: Record<Exclude<SurvivalState, "DEAD">, ModelTier>;
  buildTier: ModelTier;
  fulfilmentTier: ModelTier;
  turnCadenceHours: Record<Exclude<SurvivalState, "DEAD">, number>;
  hostingPlan: HostingPlan;
  runtimePlan: RuntimePlan;
  improveWhenRatingBelow: number;
  discontinueAfterUnprofitableDays: number;
  /** Lower price when 7-day conversion is below this. */
  lowConversionBelow: number;
  /** Raise price when 7-day conversion is above this. */
  highConversionAbove: number;
  priceStepPercent: number;
  replication: ReplicationPolicy;
}

export const DEFAULT_STRATEGY: AgentStrategy = {
  version: 1,
  createdDay: 0,
  rationale: "genesis strategy",
  focusCategories: ["website_audit", "data_cleaning", "text_digest"],
  pricingUsd: { website_audit: 9, data_cleaning: 5, text_digest: 6 },
  maxConcurrentProducts: 2,
  marketingDailyBudgetUsd: 1.5,
  marketingVisitorThreshold: 3,
  decisionTiers: { NORMAL: "standard", CONSERVE: "economy", CRITICAL: "economy" },
  buildTier: "standard",
  fulfilmentTier: "economy",
  turnCadenceHours: { NORMAL: 4, CONSERVE: 8, CRITICAL: 24 },
  hostingPlan: "free",
  runtimePlan: "shared",
  improveWhenRatingBelow: 3.8,
  discontinueAfterUnprofitableDays: 21,
  lowConversionBelow: 0.08,
  highConversionAbove: 0.45,
  priceStepPercent: 10,
  replication: {
    enabled: true,
    minPositiveCashflowDays: 30,
    childCapitalUsd: 60,
    minReserveAfterUsd: 60,
    maxChildren: 3,
  },
};

const CATEGORIES: ProductCategory[] = ["website_audit", "data_cleaning", "text_digest"];
const HOSTING: HostingPlan[] = ["free", "hobby", "vm_small"];
const RUNTIME: RuntimePlan[] = ["shared", "vm_small"];

/** Hard invariants every strategy version must satisfy. Returns a list of violations. */
export function validateStrategy(s: AgentStrategy): string[] {
  const errors: string[] = [];
  if (!Array.isArray(s.focusCategories) || s.focusCategories.length === 0) errors.push("focusCategories must not be empty");
  for (const c of s.focusCategories ?? []) if (!CATEGORIES.includes(c)) errors.push(`unknown category ${String(c)}`);
  for (const c of CATEGORIES) {
    const p = s.pricingUsd?.[c];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0.5 || p > 500) errors.push(`price for ${c} must be between 0.5 and 500 USD`);
  }
  if (!Number.isInteger(s.maxConcurrentProducts) || s.maxConcurrentProducts < 1 || s.maxConcurrentProducts > 3) errors.push("maxConcurrentProducts must be 1..3");
  if (!(s.marketingDailyBudgetUsd >= 0 && s.marketingDailyBudgetUsd <= 50)) errors.push("marketingDailyBudgetUsd must be 0..50");
  if (!(s.marketingVisitorThreshold >= 0)) errors.push("marketingVisitorThreshold must be >= 0");
  for (const state of ["NORMAL", "CONSERVE", "CRITICAL"] as const) {
    if (!MODEL_TIERS.includes(s.decisionTiers?.[state])) errors.push(`decisionTiers.${state} invalid`);
    const h = s.turnCadenceHours?.[state];
    if (!Number.isInteger(h) || h < 1 || h > 24) errors.push(`turnCadenceHours.${state} must be 1..24`);
  }
  if (!MODEL_TIERS.includes(s.buildTier)) errors.push("buildTier invalid");
  if (!MODEL_TIERS.includes(s.fulfilmentTier)) errors.push("fulfilmentTier invalid");
  if (!HOSTING.includes(s.hostingPlan)) errors.push("hostingPlan invalid");
  if (!RUNTIME.includes(s.runtimePlan)) errors.push("runtimePlan invalid");
  if (!(s.improveWhenRatingBelow >= 1 && s.improveWhenRatingBelow <= 5)) errors.push("improveWhenRatingBelow must be 1..5");
  if (!Number.isInteger(s.discontinueAfterUnprofitableDays) || s.discontinueAfterUnprofitableDays < 7) errors.push("discontinueAfterUnprofitableDays must be >= 7");
  if (!(s.lowConversionBelow >= 0 && s.lowConversionBelow < s.highConversionAbove && s.highConversionAbove <= 1)) errors.push("conversion thresholds invalid");
  if (!(s.priceStepPercent >= 1 && s.priceStepPercent <= 50)) errors.push("priceStepPercent must be 1..50");
  const r = s.replication;
  if (!r || typeof r.enabled !== "boolean") errors.push("replication.enabled missing");
  else {
    if (!Number.isInteger(r.minPositiveCashflowDays) || r.minPositiveCashflowDays < 7) errors.push("replication.minPositiveCashflowDays must be >= 7");
    if (!(r.childCapitalUsd >= 10)) errors.push("replication.childCapitalUsd must be >= 10");
    if (!(r.minReserveAfterUsd >= 10)) errors.push("replication.minReserveAfterUsd must be >= 10");
    if (!Number.isInteger(r.maxChildren) || r.maxChildren < 0 || r.maxChildren > 5) errors.push("replication.maxChildren must be 0..5");
  }
  return errors;
}

export interface StrategyProposalResult {
  accepted: boolean;
  errors: string[];
  version: number;
}

export class StrategyHistory {
  private versions: AgentStrategy[];

  constructor(initial: AgentStrategy = DEFAULT_STRATEGY, versions?: AgentStrategy[]) {
    if (versions && versions.length) {
      this.versions = versions.map((v) => structuredClone(v));
    } else {
      const errors = validateStrategy(initial);
      if (errors.length) throw new Error(`invalid initial strategy: ${errors.join("; ")}`);
      this.versions = [structuredClone(initial)];
    }
  }

  current(): AgentStrategy {
    return this.versions[this.versions.length - 1];
  }

  all(): AgentStrategy[] {
    return this.versions.map((v) => structuredClone(v));
  }

  /**
   * Propose a new version. The change is applied to a copy, validated
   * ("tested") and only then becomes current.
   */
  propose(changes: Partial<Omit<AgentStrategy, "version" | "createdDay" | "rationale">>, rationale: string, day: number): StrategyProposalResult {
    const base = this.current();
    const candidate: AgentStrategy = {
      ...structuredClone(base),
      ...structuredClone(changes),
      pricingUsd: { ...base.pricingUsd, ...(changes.pricingUsd ?? {}) },
      decisionTiers: { ...base.decisionTiers, ...(changes.decisionTiers ?? {}) },
      turnCadenceHours: { ...base.turnCadenceHours, ...(changes.turnCadenceHours ?? {}) },
      replication: { ...base.replication, ...(changes.replication ?? {}) },
      version: base.version + 1,
      createdDay: day,
      rationale,
    };
    const errors = validateStrategy(candidate);
    if (errors.length) return { accepted: false, errors, version: base.version };
    this.versions.push(candidate);
    return { accepted: true, errors: [], version: candidate.version };
  }
}

/** Variants a parent can give a child so lineages explore different strategies. */
export function deriveChildStrategy(parent: AgentStrategy, variant: string, day: number): AgentStrategy {
  const child: AgentStrategy = structuredClone(parent);
  child.version = 1;
  child.createdDay = day;
  child.rationale = `child genesis (variant ${variant}) derived from parent v${parent.version}`;
  switch (variant) {
    case "rotate_focus": {
      child.focusCategories = [...parent.focusCategories.slice(1), parent.focusCategories[0]];
      break;
    }
    case "premium": {
      for (const c of Object.keys(child.pricingUsd) as ProductCategory[]) child.pricingUsd[c] = Math.round(parent.pricingUsd[c] * 1.2 * 100) / 100;
      child.improveWhenRatingBelow = Math.min(5, parent.improveWhenRatingBelow + 0.3);
      break;
    }
    case "budget": {
      for (const c of Object.keys(child.pricingUsd) as ProductCategory[]) child.pricingUsd[c] = Math.max(0.5, Math.round(parent.pricingUsd[c] * 0.8 * 100) / 100);
      child.marketingDailyBudgetUsd = Math.max(0, parent.marketingDailyBudgetUsd * 0.5);
      break;
    }
    default:
      break;
  }
  child.replication = { ...parent.replication, enabled: false }; // grandchildren need their own track record first
  return child;
}
