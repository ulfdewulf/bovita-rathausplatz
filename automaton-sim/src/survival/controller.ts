/**
 * SurvivalController
 *
 * Derives the survival state from the wallet balance and the trailing burn
 * rate. DEAD is terminal: once an agent is dead it stays dead across
 * restarts; no component can revive it (there is no method for it).
 *
 *   NORMAL    enough balance and runway
 *   CONSERVE  balance below conserveBelow or runway below conserveRunwayDays
 *   CRITICAL  balance below criticalBelow or runway below criticalRunwayDays
 *   DEAD      balance below deadBelow or below the cost of the next minimal
 *             operating step, or a mandatory bill could not be paid
 */

import type { DailyFinancialSummary, SurvivalAssessment, SurvivalState, SurvivalThresholds } from "../core/types.js";
import { usdc, type Micro } from "../core/money.js";

export const DEFAULT_SURVIVAL_THRESHOLDS: SurvivalThresholds = {
  conserveBelow: usdc(40),
  conserveRunwayDays: 30,
  criticalBelow: usdc(10),
  criticalRunwayDays: 10,
  deadBelow: usdc(0.05),
  burnWindowDays: 7,
};

export interface SurvivalRecord {
  state: SurvivalState;
  sinceDay: number;
  deadAt: string | null;
  deadReason: string | null;
  transitions: Array<{ day: number; from: SurvivalState; to: SurvivalState; reasons: string[] }>;
}

export function createSurvivalRecord(day: number): SurvivalRecord {
  return { state: "NORMAL", sinceDay: day, deadAt: null, deadReason: null, transitions: [] };
}

export class SurvivalController {
  readonly thresholds: Readonly<SurvivalThresholds>;

  constructor(thresholds: Partial<SurvivalThresholds> = {}) {
    const merged = { ...DEFAULT_SURVIVAL_THRESHOLDS, ...thresholds };
    if (merged.criticalBelow >= merged.conserveBelow) throw new RangeError("criticalBelow must be < conserveBelow");
    if (merged.deadBelow >= merged.criticalBelow) throw new RangeError("deadBelow must be < criticalBelow");
    if (merged.burnWindowDays < 1) throw new RangeError("burnWindowDays must be >= 1");
    this.thresholds = Object.freeze(merged);
    Object.freeze(this);
  }

  /** Trailing average net outflow per day (positive = losing money). */
  burnRate(history: readonly DailyFinancialSummary[], day: number): Micro {
    const w = this.thresholds.burnWindowDays;
    const from = day - w; // exclusive
    let total = 0;
    for (const s of history) {
      if (s.day > from && s.day < day) total += s.costs - s.revenue; // transfers/capital are not burn
    }
    const daysCovered = Math.min(w, Math.max(1, day));
    return Math.round(total / daysCovered);
  }

  assess(
    balance: Micro,
    history: readonly DailyFinancialSummary[],
    day: number,
    minOperatingCost: Micro,
    previous: SurvivalState,
  ): SurvivalAssessment {
    const t = this.thresholds;
    const reasons: string[] = [];
    if (previous === "DEAD") {
      return { state: "DEAD", balance, burnRatePerDay: 0, runwayDays: 0, reasons: ["terminal state: DEAD is irreversible"], day };
    }
    const burn = this.burnRate(history, day);
    const runway = burn > 0 ? balance / burn : null;

    let state: SurvivalState;
    if (balance < t.deadBelow || balance < minOperatingCost) {
      state = "DEAD";
      reasons.push(
        balance < t.deadBelow
          ? `balance ${balance} below dead threshold ${t.deadBelow}`
          : `balance ${balance} cannot cover the next minimal operating step (${minOperatingCost})`,
      );
    } else if (balance < t.criticalBelow || (runway !== null && day >= t.burnWindowDays && runway < t.criticalRunwayDays)) {
      state = "CRITICAL";
      if (balance < t.criticalBelow) reasons.push(`balance below critical threshold ${t.criticalBelow}`);
      if (runway !== null && runway < t.criticalRunwayDays) reasons.push(`runway ${runway.toFixed(1)} days < ${t.criticalRunwayDays}`);
    } else if (balance < t.conserveBelow || (runway !== null && day >= t.burnWindowDays && runway < t.conserveRunwayDays)) {
      state = "CONSERVE";
      if (balance < t.conserveBelow) reasons.push(`balance below conserve threshold ${t.conserveBelow}`);
      if (runway !== null && runway < t.conserveRunwayDays) reasons.push(`runway ${runway.toFixed(1)} days < ${t.conserveRunwayDays}`);
    } else {
      state = "NORMAL";
      reasons.push("balance and runway sufficient");
    }

    // Hysteresis: recovering upwards requires a 15 % margin above the threshold.
    if (previous === "CONSERVE" && state === "NORMAL" && balance < t.conserveBelow * 1.15) {
      state = "CONSERVE";
      reasons.push("hysteresis: staying in CONSERVE until balance exceeds threshold by 15 %");
    }
    if (previous === "CRITICAL" && state !== "CRITICAL" && state !== "DEAD" && balance < t.criticalBelow * 1.15) {
      state = "CRITICAL";
      reasons.push("hysteresis: staying in CRITICAL until balance exceeds threshold by 15 %");
    }

    return { state, balance, burnRatePerDay: burn, runwayDays: runway === null ? null : Math.round(runway * 10) / 10, reasons, day };
  }

  /** Apply an assessment to a record, logging transitions. Returns true if the state changed. */
  apply(record: SurvivalRecord, assessment: SurvivalAssessment, nowIso: string): boolean {
    if (record.state === "DEAD") return false;
    if (assessment.state === record.state) return false;
    record.transitions.push({ day: assessment.day, from: record.state, to: assessment.state, reasons: assessment.reasons });
    record.state = assessment.state;
    record.sinceDay = assessment.day;
    if (assessment.state === "DEAD") {
      record.deadAt = nowIso;
      record.deadReason = assessment.reasons.join("; ");
    }
    return true;
  }

  /** Kill switch used when a mandatory bill cannot be paid. */
  declareDead(record: SurvivalRecord, day: number, reason: string, nowIso: string): void {
    if (record.state === "DEAD") return;
    record.transitions.push({ day, from: record.state, to: "DEAD", reasons: [reason] });
    record.state = "DEAD";
    record.sinceDay = day;
    record.deadAt = nowIso;
    record.deadReason = reason;
  }
}
