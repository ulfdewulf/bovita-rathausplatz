/**
 * LlmDecisionPolicy — lets a real model (local Ollama or approved external
 * API) choose actions from the same action space. Invalid output falls back
 * to the heuristic policy and is tagged `llm_fallback` so the decision log
 * never claims a model decided when it did not.
 */

import type { AgentView } from "./view.js";
import type { AgentAction } from "./actions.js";
import { ALLOWED_ACTIONS_BY_STATE, validateAction } from "./actions.js";
import { HeuristicDecisionPolicy, type DecisionPolicy, type DecisionProposal } from "./policy.js";

export const LLM_SYSTEM_PROMPT = `You are the decision module of an autonomous digital-services business running inside an economic simulation.
You must keep the business solvent. You can only act through the JSON actions listed. You cannot create money, change market rules or alter cost rules.
Respond with a single JSON object: {"rationale": string, "actions": [action, ...]}.`;

export function buildDecisionPrompt(view: AgentView): string {
  const compact = {
    day: view.day,
    survival: view.survival,
    balanceUsd: view.balanceUsd,
    profitableStreakDays: view.profitableStreakDays,
    products: view.products.map((p) => ({
      id: p.id,
      category: p.category,
      version: p.version,
      maxVersion: p.maxVersion,
      priceUsd: p.priceUsd,
      status: p.status,
      daysPublished: p.daysPublished,
      last7: p.last7,
      avgRating: p.avgRating,
      ratingCount: p.ratingCount,
    })),
    infra: view.infra,
    surveys: view.surveys,
    estimates: view.estimates,
    strategy: {
      pricingUsd: view.strategy.pricingUsd,
      marketingDailyBudgetUsd: view.strategy.marketingDailyBudgetUsd,
      hostingPlan: view.strategy.hostingPlan,
    },
    replication: view.replication,
    allowedActions: ALLOWED_ACTIONS_BY_STATE[view.survival.state],
  };
  return `State:\n${JSON.stringify(compact)}\n\nAction schema (one object per action):
{"type":"scan_market","category":"website_audit|data_cleaning|text_digest","sampleSize":30}
{"type":"build_product","category":"...","priceUsd":9}
{"type":"publish_product","productId":"..."}
{"type":"set_price","productId":"...","priceUsd":7.5}
{"type":"improve_product","productId":"..."}
{"type":"discontinue_product","productId":"..."}
{"type":"run_marketing","productId":"...","spendUsd":1.5}
{"type":"change_hosting","plan":"free|hobby|vm_small"}
{"type":"change_runtime","plan":"shared|vm_small"}
{"type":"request_replication","childCapitalUsd":60,"variant":"rotate_focus|premium|budget"}
{"type":"idle","reason":"..."}
Return JSON only.`;
}

export function parseModelActions(text: string, view: AgentView): { actions: AgentAction[]; rationale: string; rejected: number } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { rationale?: unknown; actions?: unknown };
  if (!Array.isArray(obj.actions)) return null;
  const allowed = new Set(ALLOWED_ACTIONS_BY_STATE[view.survival.state]);
  const actions: AgentAction[] = [];
  let rejected = 0;
  for (const raw of obj.actions) {
    const a = validateAction(raw);
    if (!a || !allowed.has(a.type)) {
      rejected++;
      continue;
    }
    actions.push(a);
  }
  if (actions.length === 0) return null;
  return { actions, rationale: typeof obj.rationale === "string" ? obj.rationale : "", rejected };
}

export class LlmDecisionPolicy implements DecisionPolicy {
  readonly name = "llm-json-v1";
  private readonly fallback = new HeuristicDecisionPolicy();
  lastWasFallback = false;
  lastRejected = 0;

  decide(view: AgentView, modelText: string | null): DecisionProposal {
    this.lastWasFallback = false;
    this.lastRejected = 0;
    if (modelText) {
      const parsed = parseModelActions(modelText, view);
      if (parsed) {
        this.lastRejected = parsed.rejected;
        return { actions: parsed.actions, rationale: `[model] ${parsed.rationale}${parsed.rejected ? ` (${parsed.rejected} invalid action(s) dropped)` : ""}` };
      }
    }
    this.lastWasFallback = true;
    const fb = this.fallback.decide(view, null);
    return { actions: fb.actions, rationale: `[fallback: model output invalid] ${fb.rationale}` };
  }
}
