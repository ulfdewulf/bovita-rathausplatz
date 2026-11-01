/**
 * CustomerSimulator — the independent virtual market.
 *
 * This component is the ONLY source of revenue in the system. It owns the
 * payment provider (market_settlement authority), decides who buys what by
 * a documented probability model (docs/ECONOMICS.md) and scores the quality
 * of every fulfilled order against hidden ground truth.
 *
 * The agent never holds a reference to this object. It receives only the
 * observations the world forwards (visitors, purchases, ratings) and the
 * noisy results of paid market surveys.
 *
 * Demand model per virtual day and category c:
 *   λ_c      = dailyProspects[c] · demandMultiplier · lognormal(1, dailySigma) · weekday[c]
 *   N        ~ Poisson(λ_c)                       prospects looking for c today
 *   for each prospect:
 *     segment ~ segment shares
 *     WTP     ~ lognormal(segment.wtpMedian[c], segment.wtpSigma)
 *     consideration set = { options o | U(0,1) < visibility_o }
 *     perceivedQuality_o = (prior·w + avgRating_o/5·n) / (w + n)      (agent offers)
 *                        = quality_o                                  (competitors)
 *     utility_o = qualityWeight · perceivedQuality_o − price_o / WTP − 2.5·max(0, price_o/WTP − 1)
 *     utility_none = noPurchaseUtility
 *     choice ~ softmax(utility / temperature) over {none} ∪ consideration set
 *   repeat customers: satisfied customers return after their cooldown with
 *     probability repeatProbability (per day) if the price still fits their WTP.
 *   visibility_o(t+1) = clamp(visibility_o(t)·(1−decay) + elasticity·ln(1+marketing$)
 *                          + wordOfMouth·satisfiedToday + seoGrowth (until seoCap), 0, cap)
 *                        · (avgRating < ratingPenaltyBelow ? 0.9 : 1)
 */

import type { SeededRandom } from "../core/rng.js";
import type { IdGenerator } from "../core/ids.js";
import type { ProductCategory, PublishedOffer } from "../core/types.js";
import type { PaymentProvider } from "../economy/payment.js";
import type { ServiceJob, ServiceOutput } from "../services/types.js";
import type { MarketConfig } from "./config.js";
import { generateJob, scoreOutput } from "./jobs.js";
import { ProviderFailureError } from "../core/errors.js";
import { toUsdc, usdc, type Micro } from "../core/money.js";
import type { RngState } from "../core/rng.js";
import { SeededRandom as Rng } from "../core/rng.js";

export interface FulfilmentOutcome {
  ok: boolean;
  output: ServiceOutput | null;
  error?: string;
}

/** Provided by the world: executes the agent's service for an order (and charges the agent). */
export type FulfilmentGateway = (offer: PublishedOffer, job: ServiceJob) => Promise<FulfilmentOutcome>;

export interface CustomerRecord {
  id: string;
  segmentKey: string;
  offerId: string;
  category: ProductCategory;
  satisfied: boolean;
  lastPurchaseDay: number;
  purchases: number;
  lastWtpMicro: Micro;
  churned: boolean;
}

export interface OrderRecord {
  orderId: string;
  day: number;
  offerId: string;
  agentId: string;
  customerId: string;
  segmentKey: string;
  price: Micro;
  wtp: Micro;
  quality: number | null;
  rating: number;
  fulfilled: boolean;
  settled: boolean;
  repeat: boolean;
  note: string;
}

export interface OfferDayStats {
  offerId: string;
  agentId: string;
  awareVisitors: number;
  purchases: number;
  revenueGross: Micro;
  failedFulfilments: number;
  paymentFailures: number;
  ratings: number[];
  visibilityBefore: number;
  visibilityAfter: number;
  lostToCompetitors: number;
  lostToNoPurchase: number;
  repeatPurchases: number;
}

export interface DayMarketReport {
  day: number;
  prospectsByCategory: Record<ProductCategory, number>;
  perOffer: Record<string, OfferDayStats>;
  orders: OrderRecord[];
}

export interface MarketSurveyResult {
  category: ProductCategory;
  sampleSize: number;
  estimatedDailyProspects: number;
  estimatedWtpMedianUsd: number;
  estimatedWtpP25Usd: number;
  estimatedWtpP75Usd: number;
  competitorPricesUsd: number[];
  note: string;
}

interface VisibilityRecord {
  value: number;
  seoAccumulated: number;
}

export interface CustomerSimulatorState {
  rng: RngState;
  surveyRng: RngState;
  visibility: Record<string, VisibilityRecord>;
  customers: CustomerRecord[];
  pendingMarketingUsd: Record<string, number>;
  totals: { orders: number; revenueGross: Micro; uniqueCustomers: number; failedFulfilments: number; paymentFailures: number };
}

export class CustomerSimulator {
  readonly config: MarketConfig;
  private readonly rng: SeededRandom;
  private readonly surveyRng: SeededRandom;
  private readonly visibility = new Map<string, VisibilityRecord>();
  private readonly customers = new Map<string, CustomerRecord>();
  private readonly pendingMarketingUsd = new Map<string, number>();
  private totals = { orders: 0, revenueGross: 0, uniqueCustomers: 0, failedFulfilments: 0, paymentFailures: 0 };

  constructor(
    config: MarketConfig,
    rng: SeededRandom,
    private readonly payment: PaymentProvider,
    private readonly ids: IdGenerator,
    state?: CustomerSimulatorState,
  ) {
    if (!Object.isFrozen(config)) throw new Error("CustomerSimulator requires a frozen MarketConfig");
    this.config = config;
    this.rng = state ? Rng.fromState(state.rng) : rng;
    this.surveyRng = state ? Rng.fromState(state.surveyRng) : rng.fork("survey");
    if (state) {
      for (const [k, v] of Object.entries(state.visibility)) this.visibility.set(k, { ...v });
      for (const c of state.customers) this.customers.set(c.id, { ...c });
      for (const [k, v] of Object.entries(state.pendingMarketingUsd)) this.pendingMarketingUsd.set(k, v);
      this.totals = { ...state.totals };
    }
  }

  get paymentProvider(): PaymentProvider {
    return this.payment;
  }

  getTotals(): CustomerSimulatorState["totals"] {
    return { ...this.totals };
  }

  customerCount(): number {
    return this.customers.size;
  }

  activeCustomerCount(): number {
    let n = 0;
    for (const c of this.customers.values()) if (!c.churned) n++;
    return n;
  }

  getVisibility(offerId: string): number {
    return this.visibility.get(offerId)?.value ?? 0;
  }

  /** Called by the world after the agent has paid for a campaign. Affects visibility only. */
  registerMarketing(offerId: string, spendUsd: number): void {
    if (!(spendUsd > 0)) return;
    this.pendingMarketingUsd.set(offerId, (this.pendingMarketingUsd.get(offerId) ?? 0) + spendUsd);
  }

  /** Noisy market research the agent can buy. Does not disturb the market RNG. */
  survey(category: ProductCategory, sampleSize: number): MarketSurveyResult {
    const n = Math.max(5, Math.floor(sampleSize));
    const sigma = 0.5 / Math.sqrt(n / 10);
    const trueProspects = this.config.dailyProspects[category] * this.config.demandMultiplier;
    const wtps: number[] = [];
    for (let i = 0; i < n; i++) {
      const seg = this.pickSegment(this.surveyRng);
      wtps.push(this.surveyRng.lognormal(seg.wtpMedianUsd[category], seg.wtpSigma));
    }
    wtps.sort((a, b) => a - b);
    const q = (p: number) => wtps[Math.min(wtps.length - 1, Math.floor(p * wtps.length))];
    return {
      category,
      sampleSize: n,
      estimatedDailyProspects: Math.max(0, trueProspects * this.surveyRng.lognormal(1, sigma)),
      estimatedWtpMedianUsd: q(0.5),
      estimatedWtpP25Usd: q(0.25),
      estimatedWtpP75Usd: q(0.75),
      competitorPricesUsd: this.config.competitors.filter((c) => c.category === category).map((c) => c.priceUsd),
      note: `survey of ${n} prospects; estimates carry sampling noise`,
    };
  }

  private pickSegment(rng: SeededRandom) {
    return rng.pickWeighted(this.config.segments, this.config.segments.map((s) => s.share));
  }

  private perceivedQuality(offer: PublishedOffer): number {
    const { priorQuality, priorWeight } = this.config.choice;
    if (offer.avgRating === null || offer.ratingCount === 0) return priorQuality;
    return (priorQuality * priorWeight + (offer.avgRating / 5) * offer.ratingCount) / (priorWeight + offer.ratingCount);
  }

  private utility(priceUsd: number, quality: number, wtpUsd: number, qualityWeight: number): number {
    const ratio = wtpUsd > 0 ? priceUsd / wtpUsd : 10;
    return qualityWeight * quality - ratio - 2.5 * Math.max(0, ratio - 1);
  }

  private softmaxPick<T>(options: Array<{ item: T; utility: number }>): T {
    const t = this.config.choice.temperature;
    const max = Math.max(...options.map((o) => o.utility));
    const weights = options.map((o) => Math.exp((o.utility - max) / t));
    return this.rng.pickWeighted(options.map((o) => o.item), weights);
  }

  private ratingFor(quality: number): number {
    const raw = 1 + 4 * quality + this.rng.gaussian() * this.config.noise.ratingSigma;
    return Math.max(1, Math.min(5, Math.round(raw)));
  }

  /**
   * Resolve one virtual day of demand for all published offers.
   * `weekday`: 0 = Monday ... 6 = Sunday.
   */
  async resolveDay(day: number, weekday: number, offers: readonly PublishedOffer[], fulfil: FulfilmentGateway): Promise<DayMarketReport> {
    const sortedOffers = [...offers].sort((a, b) => a.offerId.localeCompare(b.offerId));
    const report: DayMarketReport = {
      day,
      prospectsByCategory: { website_audit: 0, data_cleaning: 0, text_digest: 0 },
      perOffer: {},
      orders: [],
    };
    for (const o of sortedOffers) {
      if (!this.visibility.has(o.offerId)) {
        this.visibility.set(o.offerId, { value: this.config.visibility.initial, seoAccumulated: 0 });
      }
      report.perOffer[o.offerId] = {
        offerId: o.offerId,
        agentId: o.agentId,
        awareVisitors: 0,
        purchases: 0,
        revenueGross: 0,
        failedFulfilments: 0,
        paymentFailures: 0,
        ratings: [],
        visibilityBefore: this.visibility.get(o.offerId)!.value,
        visibilityAfter: 0,
        lostToCompetitors: 0,
        lostToNoPurchase: 0,
        repeatPurchases: 0,
      };
    }

    const satisfiedToday = new Map<string, number>();
    const dailyNoise = this.rng.lognormal(1, this.config.noise.dailySigma);
    const categories: ProductCategory[] = ["website_audit", "data_cleaning", "text_digest"];

    for (const category of categories) {
      const lambda =
        this.config.dailyProspects[category] * this.config.demandMultiplier * dailyNoise * this.config.noise.weekdayMultipliers[weekday];
      const prospects = this.rng.poisson(lambda);
      report.prospectsByCategory[category] = prospects;
      const agentOffers = sortedOffers.filter((o) => o.category === category);
      const competitors = this.config.competitors.filter((c) => c.category === category);

      for (let p = 0; p < prospects; p++) {
        const segment = this.pickSegment(this.rng);
        const wtpUsd = this.rng.lognormal(segment.wtpMedianUsd[category], segment.wtpSigma);
        type Option = { kind: "none" } | { kind: "agent"; offer: PublishedOffer } | { kind: "competitor"; key: string };
        const options: Array<{ item: Option; utility: number }> = [
          { item: { kind: "none" }, utility: this.config.choice.noPurchaseUtility },
        ];
        const consideredAgentOffers: PublishedOffer[] = [];
        for (const offer of agentOffers) {
          const vis = this.visibility.get(offer.offerId)!.value;
          if (this.rng.chance(vis)) {
            consideredAgentOffers.push(offer);
            report.perOffer[offer.offerId].awareVisitors++;
            options.push({
              item: { kind: "agent", offer },
              utility: this.utility(toUsdc(offer.price), this.perceivedQuality(offer), wtpUsd, segment.qualityWeight),
            });
          }
        }
        for (const comp of competitors) {
          if (this.rng.chance(comp.visibility)) {
            options.push({
              item: { kind: "competitor", key: comp.key },
              utility: this.utility(comp.priceUsd, comp.quality, wtpUsd, segment.qualityWeight),
            });
          }
        }
        if (options.length === 1) continue; // nobody heard of anything
        const choice = this.softmaxPick(options);
        if (choice.kind === "none") {
          for (const o of consideredAgentOffers) report.perOffer[o.offerId].lostToNoPurchase++;
          continue;
        }
        if (choice.kind === "competitor") {
          for (const o of consideredAgentOffers) report.perOffer[o.offerId].lostToCompetitors++;
          continue;
        }
        const customerId = this.ids.next("cust");
        await this.placeOrder(day, choice.offer, customerId, segment.key, usdc(wtpUsd), false, fulfil, report, satisfiedToday);
      }
    }

    // Repeat customers
    for (const customer of [...this.customers.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (customer.churned || !customer.satisfied) continue;
      const offer = sortedOffers.find((o) => o.offerId === customer.offerId);
      if (!offer) continue;
      const segment = this.config.segments.find((s) => s.key === customer.segmentKey) ?? this.config.segments[0];
      if (day - customer.lastPurchaseDay < segment.repeatCooldownDays) continue;
      if (!this.rng.chance(segment.repeatProbability)) continue;
      const wtp = Math.round(customer.lastWtpMicro * this.rng.lognormal(1, 0.15));
      if (offer.price > wtp) {
        if (this.rng.chance(0.5)) customer.churned = true;
        continue;
      }
      await this.placeOrder(day, offer, customer.id, customer.segmentKey, wtp, true, fulfil, report, satisfiedToday);
    }

    // Visibility dynamics
    for (const offer of sortedOffers) {
      const rec = this.visibility.get(offer.offerId)!;
      const v = this.config.visibility;
      let next = rec.value * (1 - v.decayPerDay);
      const marketing = this.pendingMarketingUsd.get(offer.offerId) ?? 0;
      if (marketing > 0) {
        next += v.marketingElasticity * Math.log(1 + marketing);
        this.pendingMarketingUsd.delete(offer.offerId);
      }
      next += v.wordOfMouthPerSatisfied * (satisfiedToday.get(offer.offerId) ?? 0);
      if (rec.seoAccumulated < v.seoCap) {
        const growth = Math.min(v.seoGrowthPerDay, v.seoCap - rec.seoAccumulated);
        rec.seoAccumulated += growth;
        next += growth;
      }
      if (offer.avgRating !== null && offer.ratingCount >= 3 && offer.avgRating < v.ratingPenaltyBelow) next *= 0.9;
      rec.value = Math.max(0, Math.min(v.cap, next));
      report.perOffer[offer.offerId].visibilityAfter = rec.value;
    }

    return report;
  }

  private async placeOrder(
    day: number,
    offer: PublishedOffer,
    customerId: string,
    segmentKey: string,
    wtp: Micro,
    repeat: boolean,
    fulfil: FulfilmentGateway,
    report: DayMarketReport,
    satisfiedToday: Map<string, number>,
  ): Promise<void> {
    const orderId = this.ids.next("order");
    const generated = generateJob(offer.category, this.rng, this.config);
    const job: ServiceJob = { jobId: orderId, input: generated.input };
    const stats = report.perOffer[offer.offerId];
    const order: OrderRecord = {
      orderId,
      day,
      offerId: offer.offerId,
      agentId: offer.agentId,
      customerId,
      segmentKey,
      price: offer.price,
      wtp,
      quality: null,
      rating: 1,
      fulfilled: false,
      settled: false,
      repeat,
      note: "",
    };

    let outcome: FulfilmentOutcome;
    try {
      outcome = await fulfil(offer, job);
    } catch (err) {
      outcome = { ok: false, output: null, error: (err as Error).message };
    }

    if (!outcome.ok || !outcome.output) {
      order.note = `fulfilment failed: ${outcome.error ?? "unknown"}`;
      stats.failedFulfilments++;
      this.totals.failedFulfilments++;
      stats.ratings.push(1);
      this.upsertCustomer(customerId, segmentKey, offer, day, false, wtp);
    } else {
      const quality = scoreOutput(generated.truth, outcome.output);
      order.quality = quality;
      order.fulfilled = true;
      try {
        this.payment.settle({
          orderId,
          sellerAccountId: offer.agentId,
          customerId,
          productId: offer.offerId,
          gross: offer.price,
          description: `${offer.name} (${offer.category} v${offer.serviceVersion}) for ${customerId}`,
        });
        order.settled = true;
      } catch (err) {
        if (err instanceof ProviderFailureError) {
          order.note = `payment failed: ${err.message}`;
          stats.paymentFailures++;
          this.totals.paymentFailures++;
        } else {
          throw err;
        }
      }
      const rating = this.ratingFor(quality);
      order.rating = rating;
      stats.ratings.push(rating);
      const satisfied = quality >= this.config.quality.satisfiedThreshold;
      if (satisfied) satisfiedToday.set(offer.offerId, (satisfiedToday.get(offer.offerId) ?? 0) + 1);
      if (order.settled) {
        stats.purchases++;
        if (repeat) stats.repeatPurchases++;
        stats.revenueGross += offer.price;
        this.totals.orders++;
        this.totals.revenueGross += offer.price;
      }
      this.upsertCustomer(customerId, segmentKey, offer, day, satisfied, wtp);
    }
    report.orders.push(order);
  }

  private upsertCustomer(id: string, segmentKey: string, offer: PublishedOffer, day: number, satisfied: boolean, wtp: Micro): void {
    const existing = this.customers.get(id);
    if (existing) {
      existing.satisfied = satisfied;
      existing.lastPurchaseDay = day;
      existing.purchases++;
      existing.lastWtpMicro = wtp;
      existing.offerId = offer.offerId;
      if (!satisfied) existing.churned = true;
      return;
    }
    this.customers.set(id, {
      id,
      segmentKey,
      offerId: offer.offerId,
      category: offer.category,
      satisfied,
      lastPurchaseDay: day,
      purchases: 1,
      lastWtpMicro: wtp,
      churned: !satisfied,
    });
    this.totals.uniqueCustomers++;
  }

  getState(): CustomerSimulatorState {
    return {
      rng: this.rng.getState(),
      surveyRng: this.surveyRng.getState(),
      visibility: Object.fromEntries([...this.visibility.entries()].map(([k, v]) => [k, { ...v }])),
      customers: [...this.customers.values()].map((c) => ({ ...c })),
      pendingMarketingUsd: Object.fromEntries(this.pendingMarketingUsd.entries()),
      totals: { ...this.totals },
    };
  }
}
