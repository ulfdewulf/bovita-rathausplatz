/**
 * The agent's action space. Both the heuristic policy and model-driven
 * policies emit these; the ActionExecutor is the only component that turns
 * them into effects. Anything not listed here is impossible for the agent.
 */

import type { HostingPlan, ProductCategory, SurvivalState } from "../core/types.js";
import type { ModelTier } from "../economy/pricing.js";
import { MODEL_TIERS } from "../economy/pricing.js";
import type { AgentStrategy } from "./strategy.js";
import type { RuntimePlan } from "./strategy.js";

export type AgentAction =
  | { type: "scan_market"; category: ProductCategory; sampleSize: number }
  | { type: "build_product"; category: ProductCategory; priceUsd: number }
  | { type: "publish_product"; productId: string }
  | { type: "set_price"; productId: string; priceUsd: number }
  | { type: "improve_product"; productId: string }
  | { type: "discontinue_product"; productId: string }
  | { type: "run_marketing"; productId: string; spendUsd: number }
  | { type: "change_hosting"; plan: HostingPlan }
  | { type: "change_runtime"; plan: RuntimePlan }
  | { type: "update_strategy"; changes: Partial<Omit<AgentStrategy, "version" | "createdDay" | "rationale">>; rationale: string }
  | { type: "request_replication"; childCapitalUsd: number; variant: string }
  | { type: "idle"; reason: string };

export type AgentActionType = AgentAction["type"];

export const ACTION_TYPES: readonly AgentActionType[] = Object.freeze([
  "scan_market",
  "build_product",
  "publish_product",
  "set_price",
  "improve_product",
  "discontinue_product",
  "run_marketing",
  "change_hosting",
  "change_runtime",
  "update_strategy",
  "request_replication",
  "idle",
]);

const CATEGORIES: ProductCategory[] = ["website_audit", "data_cleaning", "text_digest"];
const HOSTING: HostingPlan[] = ["free", "hobby", "vm_small"];
const RUNTIME: RuntimePlan[] = ["shared", "vm_small"];

/** Which actions are permitted in which survival state. */
export const ALLOWED_ACTIONS_BY_STATE: Readonly<Record<SurvivalState, readonly AgentActionType[]>> = Object.freeze({
  NORMAL: ACTION_TYPES,
  CONSERVE: ["scan_market", "publish_product", "set_price", "improve_product", "discontinue_product", "run_marketing", "change_hosting", "change_runtime", "update_strategy", "idle"],
  CRITICAL: ["publish_product", "set_price", "discontinue_product", "change_hosting", "change_runtime", "update_strategy", "idle"],
  DEAD: [],
});

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Validate an untyped action (e.g. parsed from model output). Returns the
 * typed action or null if it is not a legal action.
 */
export function validateAction(raw: unknown): AgentAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "scan_market":
      if (!CATEGORIES.includes(a.category as ProductCategory)) return null;
      return { type: "scan_market", category: a.category as ProductCategory, sampleSize: isFiniteNumber(a.sampleSize) ? Math.max(5, Math.min(200, Math.floor(a.sampleSize))) : 30 };
    case "build_product":
      if (!CATEGORIES.includes(a.category as ProductCategory) || !isFiniteNumber(a.priceUsd) || a.priceUsd < 0.5 || a.priceUsd > 500) return null;
      return { type: "build_product", category: a.category as ProductCategory, priceUsd: a.priceUsd };
    case "publish_product":
    case "improve_product":
    case "discontinue_product":
      if (typeof a.productId !== "string" || !a.productId) return null;
      return { type: a.type, productId: a.productId } as AgentAction;
    case "set_price":
      if (typeof a.productId !== "string" || !isFiniteNumber(a.priceUsd) || a.priceUsd < 0.5 || a.priceUsd > 500) return null;
      return { type: "set_price", productId: a.productId, priceUsd: a.priceUsd };
    case "run_marketing":
      if (typeof a.productId !== "string" || !isFiniteNumber(a.spendUsd) || a.spendUsd <= 0 || a.spendUsd > 500) return null;
      return { type: "run_marketing", productId: a.productId, spendUsd: a.spendUsd };
    case "change_hosting":
      if (!HOSTING.includes(a.plan as HostingPlan)) return null;
      return { type: "change_hosting", plan: a.plan as HostingPlan };
    case "change_runtime":
      if (!RUNTIME.includes(a.plan as RuntimePlan)) return null;
      return { type: "change_runtime", plan: a.plan as RuntimePlan };
    case "update_strategy":
      if (!a.changes || typeof a.changes !== "object") return null;
      return { type: "update_strategy", changes: a.changes as AgentAction extends { type: "update_strategy"; changes: infer C } ? C : never, rationale: typeof a.rationale === "string" ? a.rationale : "" };
    case "request_replication":
      if (!isFiniteNumber(a.childCapitalUsd) || a.childCapitalUsd < 10) return null;
      return { type: "request_replication", childCapitalUsd: a.childCapitalUsd, variant: typeof a.variant === "string" ? a.variant : "rotate_focus" };
    case "idle":
      return { type: "idle", reason: typeof a.reason === "string" ? a.reason : "" };
    default:
      return null;
  }
}

export function isModelTier(x: unknown): x is ModelTier {
  return MODEL_TIERS.includes(x as ModelTier);
}
