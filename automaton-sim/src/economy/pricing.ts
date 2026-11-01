/**
 * PricingCatalog
 *
 * Every price the simulation uses, with its basis:
 *   market_price  current provider list price (snapshot date in `asOf`)
 *   assumption    free experimental parameter
 *   actual        only used for real spend recorded in SHADOW/LIVE
 *
 * Prices are configured in USD for readability and converted to integer
 * micro-USDC internally. The catalog is deep-frozen after construction so
 * that nothing (in particular not the agent) can change the rules mid-run.
 */

import type { PriceBasis } from "../core/types.js";
import { usdc, type Micro } from "../core/money.js";

export type ModelTier = "frontier" | "standard" | "economy" | "local";
export const MODEL_TIERS: readonly ModelTier[] = Object.freeze(["frontier", "standard", "economy", "local"]);

export interface PriceEntry {
  usd: number;
  basis: PriceBasis;
  source: string;
}

export interface TokenWorkload {
  tokensIn: number;
  tokensOut: number;
  note: string;
}

export interface PricingConfig {
  asOf: string;
  inference: Record<ModelTier, { inputPer1M: PriceEntry; outputPer1M: PriceEntry; qualityFactor: number }>;
  hosting: {
    free: { monthly: PriceEntry; freeRequestsPerDay: number };
    hobby: { monthly: PriceEntry };
    vm_small: { monthly: PriceEntry };
  };
  database: {
    none: { monthly: PriceEntry };
    free: { monthly: PriceEntry };
    paid: { monthly: PriceEntry };
  };
  /** The agent's own runtime (the machine the agent process lives on). Mandatory cost. */
  runtime: {
    shared: { monthly: PriceEntry };
    vm_small: { monthly: PriceEntry };
  };
  domain: { yearly: PriceEntry };
  dataApi: { perCall: PriceEntry };
  payment: { settlementFeeFixed: PriceEntry; settlementFeePercent: number };
  compute: { perFulfilmentJob: PriceEntry };
  deployment: { perDeploy: PriceEntry };
  marketing: { minCampaign: PriceEntry };
  workloads: {
    routineTurn: TokenWorkload;
    marketScan: TokenWorkload;
    buildProduct: TokenWorkload;
    improveProduct: TokenWorkload;
    fulfilmentDigest: TokenWorkload;
  };
}

export const DEFAULT_PRICING: PricingConfig = {
  asOf: "2026-06",
  inference: {
    frontier: {
      inputPer1M: { usd: 3.0, basis: "market_price", source: "frontier-class API list price per 1M input tokens" },
      outputPer1M: { usd: 15.0, basis: "market_price", source: "frontier-class API list price per 1M output tokens" },
      qualityFactor: 1.0,
    },
    standard: {
      inputPer1M: { usd: 0.8, basis: "market_price", source: "mid-tier API list price per 1M input tokens" },
      outputPer1M: { usd: 4.0, basis: "market_price", source: "mid-tier API list price per 1M output tokens" },
      qualityFactor: 0.88,
    },
    economy: {
      inputPer1M: { usd: 0.1, basis: "market_price", source: "small/nano-class API list price per 1M input tokens" },
      outputPer1M: { usd: 0.4, basis: "market_price", source: "small/nano-class API list price per 1M output tokens" },
      qualityFactor: 0.72,
    },
    local: {
      inputPer1M: { usd: 0.02, basis: "assumption", source: "electricity + hardware amortisation for a local 7B model" },
      outputPer1M: { usd: 0.06, basis: "assumption", source: "electricity + hardware amortisation for a local 7B model" },
      qualityFactor: 0.65,
    },
  },
  hosting: {
    free: {
      monthly: { usd: 0, basis: "market_price", source: "static/serverless free tier" },
      freeRequestsPerDay: 150,
    },
    hobby: { monthly: { usd: 20, basis: "market_price", source: "PaaS pro/hobby plan" } },
    vm_small: { monthly: { usd: 6, basis: "market_price", source: "small VPS 1 vCPU / 1 GB" } },
  },
  database: {
    none: { monthly: { usd: 0, basis: "market_price", source: "no database" } },
    free: { monthly: { usd: 0, basis: "market_price", source: "managed DB free tier (0.5 GB)" } },
    paid: { monthly: { usd: 10, basis: "market_price", source: "managed Postgres hobby plan" } },
  },
  runtime: {
    shared: { monthly: { usd: 3, basis: "assumption", source: "shared container slot for the agent process" } },
    vm_small: { monthly: { usd: 6, basis: "market_price", source: "small VPS 1 vCPU / 1 GB for the agent process" } },
  },
  domain: { yearly: { usd: 12, basis: "market_price", source: ".com registration per year" } },
  dataApi: { perCall: { usd: 0.002, basis: "assumption", source: "third-party data/SEO API per call" } },
  payment: {
    settlementFeeFixed: { usd: 0.005, basis: "assumption", source: "USDC transfer gas on Base L2 per settlement" },
    settlementFeePercent: 0,
  },
  compute: { perFulfilmentJob: { usd: 0.0005, basis: "assumption", source: "CPU seconds per job on serverless" } },
  deployment: { perDeploy: { usd: 0, basis: "market_price", source: "deployments included in hosting plan" } },
  marketing: { minCampaign: { usd: 1, basis: "assumption", source: "minimum paid listing / ad budget" } },
  workloads: {
    routineTurn: { tokensIn: 30_000, tokensOut: 1_200, note: "one reasoning turn: full context + decision" },
    marketScan: { tokensIn: 60_000, tokensOut: 8_000, note: "research pass over market signals" },
    buildProduct: { tokensIn: 900_000, tokensOut: 150_000, note: "agentic coding session for an MVP" },
    improveProduct: { tokensIn: 400_000, tokensOut: 80_000, note: "agentic coding session for a new version" },
    fulfilmentDigest: { tokensIn: 12_000, tokensOut: 1_500, note: "LLM work per text digest order" },
  },
};

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) deepFreeze(value);
  }
  return obj;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge((out as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export type PricingOverrides = {
  [K in keyof PricingConfig]?: unknown;
};

export interface PricedAmount {
  amount: Micro;
  basis: PriceBasis;
  source: string;
}

export class PricingCatalog {
  readonly config: PricingConfig;

  constructor(overrides?: PricingOverrides) {
    const merged = deepMerge(structuredClone(DEFAULT_PRICING), overrides ?? {});
    PricingCatalog.validate(merged);
    this.config = deepFreeze(merged);
    Object.freeze(this);
  }

  static validate(cfg: PricingConfig): void {
    const checkEntry = (e: PriceEntry, label: string) => {
      if (typeof e.usd !== "number" || !Number.isFinite(e.usd) || e.usd < 0) {
        throw new RangeError(`pricing.${label}: usd must be a finite number >= 0`);
      }
      if (!["actual", "market_price", "assumption"].includes(e.basis)) {
        throw new RangeError(`pricing.${label}: invalid basis ${String(e.basis)}`);
      }
    };
    for (const tier of MODEL_TIERS) {
      checkEntry(cfg.inference[tier].inputPer1M, `inference.${tier}.inputPer1M`);
      checkEntry(cfg.inference[tier].outputPer1M, `inference.${tier}.outputPer1M`);
    }
    checkEntry(cfg.hosting.free.monthly, "hosting.free");
    checkEntry(cfg.hosting.hobby.monthly, "hosting.hobby");
    checkEntry(cfg.hosting.vm_small.monthly, "hosting.vm_small");
    checkEntry(cfg.database.none.monthly, "database.none");
    checkEntry(cfg.database.free.monthly, "database.free");
    checkEntry(cfg.database.paid.monthly, "database.paid");
    checkEntry(cfg.runtime.shared.monthly, "runtime.shared");
    checkEntry(cfg.runtime.vm_small.monthly, "runtime.vm_small");
    checkEntry(cfg.domain.yearly, "domain.yearly");
    checkEntry(cfg.dataApi.perCall, "dataApi.perCall");
    checkEntry(cfg.payment.settlementFeeFixed, "payment.settlementFeeFixed");
    checkEntry(cfg.compute.perFulfilmentJob, "compute.perFulfilmentJob");
    checkEntry(cfg.deployment.perDeploy, "deployment.perDeploy");
    checkEntry(cfg.marketing.minCampaign, "marketing.minCampaign");
    if (cfg.hosting.free.freeRequestsPerDay < 0) throw new RangeError("freeRequestsPerDay must be >= 0");
  }

  inferenceCost(tier: ModelTier, tokensIn: number, tokensOut: number): PricedAmount {
    const p = this.config.inference[tier];
    const usd = (tokensIn / 1_000_000) * p.inputPer1M.usd + (tokensOut / 1_000_000) * p.outputPer1M.usd;
    return { amount: usdc(usd), basis: p.inputPer1M.basis, source: p.inputPer1M.source };
  }

  modelQuality(tier: ModelTier): number {
    return this.config.inference[tier].qualityFactor;
  }

  hostingHourly(plan: keyof PricingConfig["hosting"]): PricedAmount {
    const e = this.config.hosting[plan].monthly;
    return { amount: usdc(e.usd / (30 * 24)), basis: e.basis, source: e.source };
  }

  hostingMonthly(plan: keyof PricingConfig["hosting"]): PricedAmount {
    const e = this.config.hosting[plan].monthly;
    return { amount: usdc(e.usd), basis: e.basis, source: e.source };
  }

  databaseHourly(plan: keyof PricingConfig["database"]): PricedAmount {
    const e = this.config.database[plan].monthly;
    return { amount: usdc(e.usd / (30 * 24)), basis: e.basis, source: e.source };
  }

  runtimeHourly(plan: keyof PricingConfig["runtime"]): PricedAmount {
    const e = this.config.runtime[plan].monthly;
    return { amount: usdc(e.usd / (30 * 24)), basis: e.basis, source: e.source };
  }

  runtimeMonthly(plan: keyof PricingConfig["runtime"]): PricedAmount {
    const e = this.config.runtime[plan].monthly;
    return { amount: usdc(e.usd), basis: e.basis, source: e.source };
  }

  domainYearly(): PricedAmount {
    const e = this.config.domain.yearly;
    return { amount: usdc(e.usd), basis: e.basis, source: e.source };
  }

  dataApiCalls(n: number): PricedAmount {
    const e = this.config.dataApi.perCall;
    return { amount: usdc(e.usd * n), basis: e.basis, source: e.source };
  }

  settlementFee(gross: Micro): PricedAmount {
    const e = this.config.payment.settlementFeeFixed;
    const pct = Math.round((gross * this.config.payment.settlementFeePercent) / 100);
    return { amount: usdc(e.usd) + pct, basis: e.basis, source: e.source };
  }

  fulfilmentCompute(): PricedAmount {
    const e = this.config.compute.perFulfilmentJob;
    return { amount: usdc(e.usd), basis: e.basis, source: e.source };
  }

  deployment(): PricedAmount {
    const e = this.config.deployment.perDeploy;
    return { amount: usdc(e.usd), basis: e.basis, source: e.source };
  }

  minMarketingCampaign(): Micro {
    return usdc(this.config.marketing.minCampaign.usd);
  }

  workload(name: keyof PricingConfig["workloads"]): TokenWorkload {
    return this.config.workloads[name];
  }

  freeTierRequestsPerDay(): number {
    return this.config.hosting.free.freeRequestsPerDay;
  }

  /** Flattened table for the dashboard. */
  table(): Array<{ key: string; usd: number; basis: PriceBasis; source: string }> {
    const rows: Array<{ key: string; usd: number; basis: PriceBasis; source: string }> = [];
    for (const tier of MODEL_TIERS) {
      rows.push({ key: `inference.${tier}.inputPer1M`, ...this.config.inference[tier].inputPer1M });
      rows.push({ key: `inference.${tier}.outputPer1M`, ...this.config.inference[tier].outputPer1M });
    }
    rows.push({ key: "hosting.free.monthly", ...this.config.hosting.free.monthly });
    rows.push({ key: "hosting.hobby.monthly", ...this.config.hosting.hobby.monthly });
    rows.push({ key: "hosting.vm_small.monthly", ...this.config.hosting.vm_small.monthly });
    rows.push({ key: "database.free.monthly", ...this.config.database.free.monthly });
    rows.push({ key: "database.paid.monthly", ...this.config.database.paid.monthly });
    rows.push({ key: "runtime.shared.monthly", ...this.config.runtime.shared.monthly });
    rows.push({ key: "runtime.vm_small.monthly", ...this.config.runtime.vm_small.monthly });
    rows.push({ key: "domain.yearly", ...this.config.domain.yearly });
    rows.push({ key: "dataApi.perCall", ...this.config.dataApi.perCall });
    rows.push({ key: "payment.settlementFeeFixed", ...this.config.payment.settlementFeeFixed });
    rows.push({ key: "compute.perFulfilmentJob", ...this.config.compute.perFulfilmentJob });
    rows.push({ key: "deployment.perDeploy", ...this.config.deployment.perDeploy });
    rows.push({ key: "marketing.minCampaign", ...this.config.marketing.minCampaign });
    return rows;
  }
}
