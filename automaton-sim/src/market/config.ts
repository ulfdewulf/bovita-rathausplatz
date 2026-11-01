/**
 * Market configuration — the rules of the virtual customer market.
 *
 * These parameters belong to the experimenter (founder), never to the agent.
 * The customer simulator deep-freezes its config; the agent only receives
 * noisy observations (sales, visitors, ratings, survey results).
 */

import type { ProductCategory } from "../core/types.js";

export interface MarketSegment {
  key: string;
  /** Share of prospects belonging to this segment (shares are normalised). */
  share: number;
  /** Median willingness to pay in USD per category. */
  wtpMedianUsd: Record<ProductCategory, number>;
  /** Sigma of the lognormal WTP distribution. */
  wtpSigma: number;
  /** Weight of perceived quality in the utility function. */
  qualityWeight: number;
  /** Daily probability that a satisfied customer comes back after the cooldown. */
  repeatProbability: number;
  repeatCooldownDays: number;
}

export interface Competitor {
  key: string;
  category: ProductCategory;
  priceUsd: number;
  /** True quality 0..1 (the market knows it; the agent does not). */
  quality: number;
  /** Probability that a prospect knows this competitor. */
  visibility: number;
}

export interface MarketConfig {
  /** Base number of prospects per virtual day for the whole market, per category. */
  dailyProspects: Record<ProductCategory, number>;
  /** Scenario knob applied to dailyProspects (0 = no customers). */
  demandMultiplier: number;
  segments: MarketSegment[];
  competitors: Competitor[];
  noise: {
    /** Sigma of the lognormal daily demand multiplier. */
    dailySigma: number;
    /** Monday..Sunday multipliers. */
    weekdayMultipliers: [number, number, number, number, number, number, number];
    /** Sigma of the rating noise (in stars). */
    ratingSigma: number;
  };
  visibility: {
    /** Visibility of a freshly published offer (probability a prospect knows it). */
    initial: number;
    cap: number;
    /** Daily decay of visibility (fraction lost per day). */
    decayPerDay: number;
    /** Visibility gained per unit of ln(1 + marketing spend in USD). */
    marketingElasticity: number;
    /** Visibility gained per satisfied customer (word of mouth). */
    wordOfMouthPerSatisfied: number;
    /** Organic growth per day while published (SEO), until seoCap is reached. */
    seoGrowthPerDay: number;
    seoCap: number;
    /** Offers rated below this lose extra visibility. */
    ratingPenaltyBelow: number;
  };
  choice: {
    /** Softmax temperature; lower = more deterministic choice of the best option. */
    temperature: number;
    /** Utility of buying nothing. */
    noPurchaseUtility: number;
    /** Prior quality assumed for an offer without ratings, and its weight. */
    priorQuality: number;
    priorWeight: number;
  };
  quality: {
    /** Fulfilment quality at or above which a customer counts as satisfied. */
    satisfiedThreshold: number;
  };
  jobs: {
    auditDefects: [number, number];
    csvRows: [number, number];
    csvDefects: [number, number];
    digestKeyFacts: [number, number];
    digestFiller: [number, number];
  };
}

export const DEFAULT_MARKET_CONFIG: MarketConfig = {
  dailyProspects: {
    website_audit: 30,
    data_cleaning: 20,
    text_digest: 25,
  },
  demandMultiplier: 1,
  segments: [
    {
      key: "budget",
      share: 0.5,
      wtpMedianUsd: { website_audit: 6, data_cleaning: 3, text_digest: 4 },
      wtpSigma: 0.55,
      qualityWeight: 0.8,
      repeatProbability: 0.04,
      repeatCooldownDays: 7,
    },
    {
      key: "smb",
      share: 0.38,
      wtpMedianUsd: { website_audit: 14, data_cleaning: 8, text_digest: 9 },
      wtpSigma: 0.5,
      qualityWeight: 1.3,
      repeatProbability: 0.07,
      repeatCooldownDays: 5,
    },
    {
      key: "pro",
      share: 0.12,
      wtpMedianUsd: { website_audit: 35, data_cleaning: 20, text_digest: 22 },
      wtpSigma: 0.45,
      qualityWeight: 1.8,
      repeatProbability: 0.1,
      repeatCooldownDays: 3,
    },
  ],
  competitors: [
    { key: "free-seo-checker", category: "website_audit", priceUsd: 0, quality: 0.35, visibility: 0.5 },
    { key: "audit-pro", category: "website_audit", priceUsd: 19, quality: 0.85, visibility: 0.3 },
    { key: "spreadsheet-fixer", category: "data_cleaning", priceUsd: 6, quality: 0.6, visibility: 0.35 },
    { key: "digest-bot", category: "text_digest", priceUsd: 7, quality: 0.65, visibility: 0.4 },
  ],
  noise: {
    dailySigma: 0.3,
    weekdayMultipliers: [1.1, 1.15, 1.1, 1.05, 0.95, 0.7, 0.6],
    ratingSigma: 0.35,
  },
  visibility: {
    initial: 0.03,
    cap: 0.6,
    decayPerDay: 0.04,
    marketingElasticity: 0.035,
    wordOfMouthPerSatisfied: 0.004,
    seoGrowthPerDay: 0.0015,
    seoCap: 0.12,
    ratingPenaltyBelow: 3.0,
  },
  choice: {
    temperature: 0.35,
    noPurchaseUtility: 0.25,
    priorQuality: 0.5,
    priorWeight: 3,
  },
  quality: {
    satisfiedThreshold: 0.6,
  },
  jobs: {
    auditDefects: [2, 6],
    csvRows: [12, 40],
    csvDefects: [2, 5],
    digestKeyFacts: [3, 5],
    digestFiller: [6, 12],
  },
};

export function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) deepFreeze(value);
  }
  return obj;
}

export function deepMergeConfig<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMergeConfig((out as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export function buildMarketConfig(overrides?: unknown): MarketConfig {
  const merged = deepMergeConfig(structuredClone(DEFAULT_MARKET_CONFIG), overrides ?? {});
  validateMarketConfig(merged);
  return deepFreeze(merged);
}

export function validateMarketConfig(cfg: MarketConfig): void {
  if (cfg.demandMultiplier < 0 || !Number.isFinite(cfg.demandMultiplier)) throw new RangeError("demandMultiplier must be >= 0");
  if (!cfg.segments.length) throw new RangeError("at least one segment required");
  for (const s of cfg.segments) {
    if (s.share < 0) throw new RangeError(`segment ${s.key}: share must be >= 0`);
    if (s.wtpSigma <= 0) throw new RangeError(`segment ${s.key}: wtpSigma must be > 0`);
  }
  if (cfg.choice.temperature <= 0) throw new RangeError("choice.temperature must be > 0");
  if (cfg.visibility.cap <= 0 || cfg.visibility.cap > 1) throw new RangeError("visibility.cap must be in (0,1]");
  if (cfg.noise.weekdayMultipliers.length !== 7) throw new RangeError("7 weekday multipliers required");
}
