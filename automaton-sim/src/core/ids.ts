/**
 * Deterministic ID generation.
 *
 * IDs are derived from a run id, a prefix and a monotonically increasing
 * counter, so two runs with the same seed produce identical IDs. The
 * counters are part of the persisted state.
 */

export interface IdGeneratorState {
  runId: string;
  counters: Record<string, number>;
}

export class IdGenerator {
  private counters: Record<string, number>;

  constructor(readonly runId: string, counters: Record<string, number> = {}) {
    this.counters = { ...counters };
  }

  next(prefix: string): string {
    const n = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = n;
    return `${prefix}_${this.runId}_${n.toString(36).padStart(6, "0")}`;
  }

  peek(prefix: string): number {
    return this.counters[prefix] ?? 0;
  }

  getState(): IdGeneratorState {
    return { runId: this.runId, counters: { ...this.counters } };
  }

  static fromState(state: IdGeneratorState): IdGenerator {
    return new IdGenerator(state.runId, state.counters);
  }
}
