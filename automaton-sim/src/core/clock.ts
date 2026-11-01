/**
 * SimulationClock
 *
 * The single source of time for all business logic. Nothing in the economic
 * core may call Date.now(); it asks the clock instead. The runner advances
 * the clock either as fast as possible (accelerated mode) or in step with
 * real time (realtime mode). Because the clock is explicit, the same run can
 * be replayed deterministically and persisted mid-flight.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export interface ClockState {
  /** Virtual epoch (ms) at which the simulation started. */
  startMs: number;
  /** Elapsed virtual hours since start. */
  elapsedHours: number;
}

export class SimulationClock {
  private elapsedHours: number;

  constructor(readonly startMs: number, elapsedHours = 0) {
    if (!Number.isFinite(startMs)) throw new TypeError("startMs must be finite");
    if (!Number.isInteger(elapsedHours) || elapsedHours < 0) {
      throw new RangeError("elapsedHours must be a non-negative integer");
    }
    this.elapsedHours = elapsedHours;
  }

  /** Current virtual time in epoch milliseconds. */
  now(): number {
    return this.startMs + this.elapsedHours * HOUR_MS;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Zero-based virtual day index since the start of the simulation. */
  day(): number {
    return Math.floor(this.elapsedHours / 24);
  }

  hourOfDay(): number {
    return this.elapsedHours % 24;
  }

  /** 0 = Monday ... 6 = Sunday, derived from the virtual date. */
  weekday(): number {
    const jsDay = new Date(this.now()).getUTCDay(); // 0 = Sunday
    return (jsDay + 6) % 7;
  }

  hoursElapsed(): number {
    return this.elapsedHours;
  }

  advanceHours(hours = 1): void {
    if (!Number.isInteger(hours) || hours <= 0) {
      throw new RangeError("advanceHours requires a positive integer");
    }
    this.elapsedHours += hours;
  }

  getState(): ClockState {
    return { startMs: this.startMs, elapsedHours: this.elapsedHours };
  }

  static fromState(state: ClockState): SimulationClock {
    return new SimulationClock(state.startMs, state.elapsedHours);
  }

  static startingAt(iso: string): SimulationClock {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new TypeError(`Invalid ISO date: ${iso}`);
    return new SimulationClock(ms, 0);
  }
}
