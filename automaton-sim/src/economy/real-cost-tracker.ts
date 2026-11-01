/**
 * RealCostTracker
 *
 * In SHADOW mode the agent may use metered external model APIs. Those costs
 * are REAL money and are therefore tracked separately from the virtual
 * economy, with a hard cap. The virtual ledger still books the simulated
 * market price for the same call (so the economics stay comparable), but
 * this tracker is what protects the founder's real budget.
 */

import type { Micro } from "../core/money.js";
import { SafetyViolationError } from "../core/errors.js";

export interface RealCostRecord {
  wallClockIso: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  amount: Micro;
  description: string;
}

export interface RealCostState {
  capMicro: Micro;
  spentMicro: Micro;
  records: RealCostRecord[];
}

export class RealCostCapExceeded extends SafetyViolationError {
  constructor(cap: Micro, spent: Micro, estimate: Micro) {
    super(`Real cost cap exceeded: cap ${cap} micro, spent ${spent} micro, next call estimate ${estimate} micro`);
  }
}

export class RealCostTracker {
  private spent: Micro;
  private readonly records: RealCostRecord[];

  constructor(
    readonly capMicro: Micro,
    state?: Partial<RealCostState>,
  ) {
    if (!Number.isInteger(capMicro) || capMicro < 0) throw new RangeError("cap must be a non-negative integer");
    this.spent = state?.spentMicro ?? 0;
    this.records = state?.records ? state.records.slice() : [];
  }

  spentMicro(): Micro {
    return this.spent;
  }

  remainingMicro(): Micro {
    return Math.max(0, this.capMicro - this.spent);
  }

  /** Must be called BEFORE a metered call. Throws if the estimate does not fit. */
  assertWithinCap(estimate: Micro): void {
    if (this.spent + estimate > this.capMicro) {
      throw new RealCostCapExceeded(this.capMicro, this.spent, estimate);
    }
  }

  record(record: Omit<RealCostRecord, "wallClockIso">, wallClockIso: string): void {
    this.spent += record.amount;
    this.records.push({ ...record, wallClockIso });
  }

  getRecords(): readonly RealCostRecord[] {
    return this.records.slice();
  }

  getState(): RealCostState {
    return { capMicro: this.capMicro, spentMicro: this.spent, records: this.records.slice() };
  }

  static fromState(state: RealCostState): RealCostTracker {
    return new RealCostTracker(state.capMicro, state);
  }
}
