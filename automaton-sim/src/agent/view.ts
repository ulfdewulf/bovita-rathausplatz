/**
 * AgentView — everything the agent is allowed to know.
 *
 * It is a plain, frozen data snapshot built by the world each turn. It
 * contains observations (balance, sales, ratings, surveys the agent paid
 * for) and public information (list prices), but no handle to the market,
 * the ledger or the survival controller.
 */

import type { DailyFinancialSummary, DecisionRecord, InfrastructureState, ProductCategory, ProductStatus, SurvivalAssessment } from "../core/types.js";
import type { ModelTier } from "../economy/pricing.js";
import type { MarketSurveyResult } from "../market/customer-simulator.js";
import type { AgentStrategy, RuntimePlan } from "./strategy.js";

export interface ProductView {
  id: string;
  category: ProductCategory;
  name: string;
  version: number;
  maxVersion: number;
  priceUsd: number;
  status: ProductStatus;
  daysPublished: number;
  daysSinceLastSale: number | null;
  last7: { visitors: number; purchases: number; revenueUsd: number; fulfilmentCostUsd: number; failedFulfilments: number };
  last21: { purchases: number; revenueUsd: number; fulfilmentCostUsd: number; marketingUsd: number };
  avgRating: number | null;
  ratingCount: number;
  totalPurchases: number;
  totalRevenueUsd: number;
  lastPriceChangeDay: number | null;
  lastImproveDay: number | null;
  lastMarketingDay: number | null;
}

export interface CostEstimates {
  turnUsd: number;
  scanUsd: number;
  buildUsd: number;
  improveUsd: number;
  fulfilmentUsd: Record<ProductCategory, number>;
  hostingMonthlyUsd: Record<"free" | "hobby" | "vm_small", number>;
  runtimeMonthlyUsd: Record<RuntimePlan, number>;
  minMarketingUsd: number;
  freeTierRequestsPerDay: number;
}

export interface AgentView {
  agentId: string;
  name: string;
  generation: number;
  day: number;
  hour: number;
  survival: SurvivalAssessment;
  balanceUsd: number;
  recentDaily: DailyFinancialSummary[];
  profitableStreakDays: number;
  products: ProductView[];
  infra: InfrastructureState & { runtimePlan: RuntimePlan; hourlyCostUsd: number; freeTierExceededLast7: number };
  strategy: AgentStrategy;
  surveys: Array<MarketSurveyResult & { day: number }>;
  estimates: CostEstimates;
  modelTiers: readonly ModelTier[];
  children: number;
  replication: { eligible: boolean; reasons: string[] };
  discontinuedCategories: Partial<Record<ProductCategory, number>>;
  buildFailures: Partial<Record<ProductCategory, number>>;
  recentDecisions: DecisionRecord[];
}
