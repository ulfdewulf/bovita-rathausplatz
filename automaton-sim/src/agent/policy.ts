/**
 * HeuristicDecisionPolicy — deterministic business rules.
 *
 * This is the "simulated brain": given the AgentView it returns the actions
 * the agent takes this turn plus a human-readable rationale. It is a pure
 * function of the view, so runs are reproducible. Decisions made here are
 * tagged `simulated_policy` and are never presented as model decisions.
 *
 * The business cycle it implements:
 *   1. identify opportunity (market scans)      5. test (self-test on build)
 *   2. evaluate idea (expected margin)          6. publish
 *   3. estimate costs / revenue                  7. read demand (visitors, conversion, ratings)
 *   4. build MVP                                 8. compute P&L, 9. improve or discontinue
 */

import type { ProductCategory } from "../core/types.js";
import type { AgentAction } from "./actions.js";
import type { AgentView, ProductView } from "./view.js";

export interface DecisionProposal {
  actions: AgentAction[];
  rationale: string;
}

export interface DecisionPolicy {
  readonly name: string;
  decide(view: AgentView, modelText: string | null): DecisionProposal;
}

const CATEGORIES: ProductCategory[] = ["website_audit", "data_cleaning", "text_digest"];

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function expectedDailyMargin(view: AgentView, category: ProductCategory): { priceUsd: number; marginUsd: number; note: string } | null {
  const survey = view.surveys.find((s) => s.category === category);
  if (!survey) return null;
  const fulfilment = view.estimates.fulfilmentUsd[category];
  // Price a little below the median WTP, never below 3x fulfilment cost.
  const priceUsd = round2(Math.max(0.5, Math.max(fulfilment * 3, survey.estimatedWtpMedianUsd * 0.9)));
  // Initial awareness ~3 %, conversion guess 30 % of aware prospects.
  const expectedOrders = survey.estimatedDailyProspects * 0.03 * 0.3;
  const marginUsd = expectedOrders * (priceUsd - fulfilment);
  return { priceUsd, marginUsd, note: `${survey.estimatedDailyProspects.toFixed(1)} prospects/day, WTP median ${survey.estimatedWtpMedianUsd.toFixed(2)}` };
}

export class HeuristicDecisionPolicy implements DecisionPolicy {
  readonly name = "heuristic-v1";

  decide(view: AgentView, _modelText: string | null): DecisionProposal {
    const actions: AgentAction[] = [];
    const notes: string[] = [];
    const s = view.strategy;
    const state = view.survival.state;
    const balance = view.balanceUsd;
    const products = view.products;
    const published = products.filter((p) => p.status === "published");
    const inProgress = products.filter((p) => p.status === "building" || p.status === "testing");
    const active = [...published, ...inProgress];

    if (state === "DEAD") return { actions: [], rationale: "dead: no actions" };

    // ── Publish anything that passed its self-test ────────────────────
    for (const p of products.filter((x) => x.status === "testing")) {
      actions.push({ type: "publish_product", productId: p.id });
      notes.push(`publish ${p.name} v${p.version} (self-test passed)`);
    }

    // ── Cost discipline in CONSERVE / CRITICAL ─────────────────────────
    if (state !== "NORMAL") {
      if (view.infra.hostingPlan !== "free") {
        const infraDaily = (view.estimates.hostingMonthlyUsd[view.infra.hostingPlan] ?? 0) / 30;
        const revenueDaily = published.reduce((sum, p) => sum + p.last7.revenueUsd, 0) / 7;
        if (state === "CRITICAL" || revenueDaily < infraDaily * 2) {
          actions.push({ type: "change_hosting", plan: "free" });
          notes.push("downgrade hosting to free tier to cut burn");
        }
      }
      if (view.infra.runtimePlan !== "shared") {
        actions.push({ type: "change_runtime", plan: "shared" });
        notes.push("downgrade agent runtime to shared plan");
      }
    }

    // ── Pricing & quality management for published products ───────────
    for (const p of published) {
      if (p.daysPublished < 3) continue;
      const canChangePrice = p.lastPriceChangeDay === null || view.day - p.lastPriceChangeDay >= 7;
      if (canChangePrice && p.last7.visitors >= 15) {
        const conv = p.last7.purchases / p.last7.visitors;
        const floor = Math.max(0.5, view.estimates.fulfilmentUsd[p.category] * 3);
        if (conv < s.lowConversionBelow) {
          const price = round2(Math.max(floor, p.priceUsd * (1 - s.priceStepPercent / 100)));
          if (price < p.priceUsd) {
            actions.push({ type: "set_price", productId: p.id, priceUsd: price });
            notes.push(`${p.name}: conversion ${(conv * 100).toFixed(1)} % too low -> price ${p.priceUsd} -> ${price}`);
          }
        } else if (conv > s.highConversionAbove && state === "NORMAL") {
          const price = round2(Math.min(500, p.priceUsd * (1 + s.priceStepPercent / 100)));
          actions.push({ type: "set_price", productId: p.id, priceUsd: price });
          notes.push(`${p.name}: conversion ${(conv * 100).toFixed(1)} % high -> price ${p.priceUsd} -> ${price}`);
        }
      }

      // Improve quality when ratings are weak and we can afford it.
      const canImprove = p.lastImproveDay === null || view.day - p.lastImproveDay >= 10;
      if (
        state !== "CRITICAL" &&
        canImprove &&
        p.version < p.maxVersion &&
        p.ratingCount >= 5 &&
        p.avgRating !== null &&
        p.avgRating < s.improveWhenRatingBelow &&
        balance >= view.estimates.improveUsd * (state === "NORMAL" ? 2.5 : 4)
      ) {
        actions.push({ type: "improve_product", productId: p.id });
        notes.push(`${p.name}: rating ${p.avgRating.toFixed(2)} < ${s.improveWhenRatingBelow} -> build v${p.version + 1}`);
      }

      // Marketing when awareness is the bottleneck.
      const visitorsPerDay = p.last7.visitors / 7;
      const marketedToday = p.lastMarketingDay === view.day;
      if (!marketedToday && s.marketingDailyBudgetUsd > 0 && visitorsPerDay < s.marketingVisitorThreshold) {
        const conv = p.last7.visitors >= 10 ? p.last7.purchases / p.last7.visitors : null;
        const allowed =
          state === "NORMAL"
            ? balance > 10
            : state === "CONSERVE"
              ? conv !== null && conv >= 0.25 && balance > 15
              : false;
        if (allowed) {
          const spend = round2(Math.max(view.estimates.minMarketingUsd, Math.min(s.marketingDailyBudgetUsd * (state === "NORMAL" ? 1 : 0.5), balance * 0.015)));
          if (spend >= view.estimates.minMarketingUsd && spend <= balance * 0.05) {
            actions.push({ type: "run_marketing", productId: p.id, spendUsd: spend });
            notes.push(`${p.name}: ${visitorsPerDay.toFixed(1)} visitors/day -> marketing ${spend} USD`);
          }
        }
      }

      // Capacity: free tier exhausted while demand is there.
      if (state === "NORMAL" && view.infra.hostingPlan === "free" && view.infra.freeTierExceededLast7 > 0) {
        const revenueDaily = published.reduce((sum, x) => sum + x.last7.revenueUsd, 0) / 7;
        const vmDaily = view.estimates.hostingMonthlyUsd.vm_small / 30;
        if (revenueDaily > vmDaily * 3) {
          actions.push({ type: "change_hosting", plan: "vm_small" });
          notes.push(`free tier exceeded ${view.infra.freeTierExceededLast7}x in 7 days -> upgrade hosting to vm_small`);
        }
      }

      // Discontinue products that do not earn their keep.
      const unprofitable = p.last21.revenueUsd - p.last21.fulfilmentCostUsd - p.last21.marketingUsd <= 0 && p.last21.purchases <= 2;
      if (p.daysPublished >= s.discontinueAfterUnprofitableDays && unprofitable) {
        actions.push({ type: "discontinue_product", productId: p.id });
        notes.push(`${p.name}: no profit in ${s.discontinueAfterUnprofitableDays} days (${p.last21.purchases} sales) -> discontinue`);
      }
    }

    // ── Opportunity discovery and building (NORMAL only) ───────────────
    if (state === "NORMAL") {
      const discontinuedRecently = (c: ProductCategory) => {
        const d = view.discontinuedCategories[c];
        return d !== undefined && view.day - d < 60;
      };
      const activeCategories = new Set(active.map((p) => p.category));
      const candidates = s.focusCategories.filter((c) => !activeCategories.has(c) && !discontinuedRecently(c) && (view.buildFailures[c] ?? 0) < 4);
      const surveysMissing = candidates.filter((c) => !view.surveys.some((sv) => sv.category === c));
      const wantsNewProduct = active.length < s.maxConcurrentProducts && candidates.length > 0;
      const firstProductMature = published.length === 0 || published.some((p) => p.daysPublished >= 14 && p.last7.revenueUsd - p.last7.fulfilmentCostUsd > 0);
      const canAffordBuild = balance >= view.estimates.buildUsd * 2.5 + 5;

      if (wantsNewProduct && inProgress.length === 0 && (active.length === 0 || firstProductMature) && canAffordBuild) {
        if (surveysMissing.length > 0 && balance >= view.estimates.scanUsd * surveysMissing.length + 5) {
          for (const c of surveysMissing) actions.push({ type: "scan_market", category: c, sampleSize: 30 });
          notes.push(`scan market for ${surveysMissing.join(", ")}`);
        } else {
          let best: { category: ProductCategory; priceUsd: number; marginUsd: number; note: string } | null = null;
          for (const c of candidates) {
            const est = expectedDailyMargin(view, c);
            if (!est) continue;
            if (!best || est.marginUsd > best.marginUsd) best = { category: c, ...est };
          }
          if (best && best.marginUsd > 0) {
            const price = best.category in s.pricingUsd && (view.buildFailures[best.category] ?? 0) === 0 ? best.priceUsd : best.priceUsd;
            actions.push({ type: "build_product", category: best.category, priceUsd: price });
            notes.push(`build ${best.category} at ${price} USD (expected margin ${best.marginUsd.toFixed(2)} USD/day; ${best.note})`);
          } else if (best) {
            notes.push(`no category with positive expected margin (best ${best.category}: ${best.marginUsd.toFixed(2)} USD/day)`);
          }
        }
      }

      // Replication when the controller says we qualify.
      if (s.replication.enabled && view.replication.eligible) {
        actions.push({ type: "request_replication", childCapitalUsd: s.replication.childCapitalUsd, variant: ["rotate_focus", "premium", "budget"][view.children % 3] });
        notes.push(`profitable for ${view.profitableStreakDays} days -> spawn child with ${s.replication.childCapitalUsd} USD`);
      }
    }

    if (actions.length === 0) {
      const reason =
        state === "CRITICAL"
          ? "critical: preserving cash, only selling existing products"
          : published.length > 0
            ? "monitoring: no adjustment warranted this turn"
            : "waiting: nothing affordable or sensible to do";
      actions.push({ type: "idle", reason });
      notes.push(reason);
    }

    return { actions, rationale: notes.join(" | ") };
  }
}

export function summariseProducts(products: ProductView[]): string {
  return products.map((p) => `${p.name} v${p.version} ${p.status} @${p.priceUsd}`).join(", ") || "none";
}
