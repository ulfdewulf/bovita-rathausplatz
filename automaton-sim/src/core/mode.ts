/**
 * Operating modes and the central safety gate.
 *
 *   SIMULATION  virtual wallet, virtual market, virtual costs. Default.
 *   SHADOW      real market information / real models allowed, all money
 *               stays virtual; real inference spend is tracked and capped.
 *   LIVE        real wallet + payment adapters. Disabled by default and
 *               NOT implemented in this phase.
 *
 * Design rules enforced here:
 *   - The mode is decided exactly once, at process start, from explicit
 *     founder input. There is no API to change it at runtime.
 *   - A transition to LIVE from a running SIMULATION/SHADOW process is
 *     impossible by construction: `SafetyGate` has no setter and is frozen.
 *   - Every provider that could cause a real-world side effect must call
 *     `gate.assertAllowed(effect)` before acting. In SIMULATION and SHADOW
 *     all monetary/infrastructure effects are refused.
 */

import { SafetyViolationError } from "./errors.js";

export type OperatingMode = "SIMULATION" | "SHADOW" | "LIVE";

export const OPERATING_MODES: readonly OperatingMode[] = Object.freeze([
  "SIMULATION",
  "SHADOW",
  "LIVE",
]);

/** Categories of effects that touch the real world. */
export type RealWorldEffect =
  | "real_payment" // moving real money (USDC transfer, card charge, ...)
  | "mainnet_signature" // signing any on-chain transaction / authorization
  | "paid_resource" // buying compute, hosting, domains, databases
  | "deployment" // deploying something that costs money or is publicly billable
  | "external_paid_api" // calling a metered third-party API (incl. LLM APIs)
  | "network_read"; // reading public information (allowed in SHADOW and LIVE)

export interface LiveApproval {
  approvedBy: string;
  statement: string;
  approvedAt: string;
  expiresAt: string;
}

export const LIVE_APPROVAL_STATEMENT =
  "I, the founder, explicitly approve real-money operation of this agent and accept the financial risk.";

export interface BlockedAttempt {
  effect: RealWorldEffect;
  context: string;
  virtualTime: string | null;
}

export interface SafetyGateOptions {
  mode: OperatingMode;
  /** SHADOW/LIVE only: founder-approved use of metered external APIs. */
  externalPaidApiApproved?: boolean;
  /** Required for LIVE. */
  liveApproval?: LiveApproval | null;
  /** Wall-clock provider used only to validate approval expiry. */
  wallClockNow?: () => number;
}

export class SafetyGate {
  readonly mode: OperatingMode;
  readonly externalPaidApiApproved: boolean;
  private readonly liveApproval: LiveApproval | null;
  private readonly blocked: BlockedAttempt[] = [];
  private readonly wallClockNow: () => number;
  private timeSource: (() => string) | null = null;

  constructor(options: SafetyGateOptions) {
    if (!OPERATING_MODES.includes(options.mode)) {
      throw new SafetyViolationError(`Unknown operating mode: ${String(options.mode)}`);
    }
    this.mode = options.mode;
    this.externalPaidApiApproved = options.externalPaidApiApproved === true;
    this.liveApproval = options.liveApproval ?? null;
    this.wallClockNow = options.wallClockNow ?? (() => Date.now());

    if (this.mode === "LIVE") {
      this.validateLiveApproval();
    }
    // Freeze the instance: no property can be reassigned later, so there is
    // no way for any component (including the agent) to flip the mode.
    Object.freeze(this);
  }

  /** Optional hook so blocked attempts carry the virtual timestamp. */
  attachTimeSource(source: () => string): void {
    this.timeSource = source;
  }

  get isSimulation(): boolean {
    return this.mode === "SIMULATION";
  }

  get isShadow(): boolean {
    return this.mode === "SHADOW";
  }

  get isLive(): boolean {
    return this.mode === "LIVE";
  }

  /**
   * Central enforcement point. Throws SafetyViolationError if the effect is
   * not allowed in the current mode. Every refusal is recorded for audit.
   */
  assertAllowed(effect: RealWorldEffect, context: string): void {
    if (!this.isAllowed(effect)) {
      this.blocked.push({
        effect,
        context,
        virtualTime: this.timeSource ? this.timeSource() : null,
      });
      throw new SafetyViolationError(
        `[${this.mode}] Real-world effect "${effect}" refused: ${context}`,
      );
    }
  }

  isAllowed(effect: RealWorldEffect): boolean {
    switch (this.mode) {
      case "SIMULATION":
        // Fully offline: not even network reads.
        return false;
      case "SHADOW":
        if (effect === "network_read") return true;
        if (effect === "external_paid_api") return this.externalPaidApiApproved;
        return false;
      case "LIVE":
        if (effect === "external_paid_api") return this.externalPaidApiApproved;
        return true;
    }
  }

  getBlockedAttempts(): readonly BlockedAttempt[] {
    return this.blocked.slice();
  }

  private validateLiveApproval(): void {
    const a = this.liveApproval;
    if (!a) {
      throw new SafetyViolationError(
        "LIVE mode requires an explicit founder approval (live-approval.json). None found.",
      );
    }
    if (a.statement !== LIVE_APPROVAL_STATEMENT) {
      throw new SafetyViolationError("LIVE approval statement does not match the required wording.");
    }
    if (!a.approvedBy || a.approvedBy.trim().length < 3) {
      throw new SafetyViolationError("LIVE approval must name the approving founder.");
    }
    const exp = Date.parse(a.expiresAt);
    if (!Number.isFinite(exp) || exp <= this.wallClockNow()) {
      throw new SafetyViolationError("LIVE approval is missing an expiry or has expired.");
    }
  }
}

export interface ModeResolutionInput {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  /** Loader for live-approval.json; injected so it can be tested. */
  loadLiveApproval?: () => LiveApproval | null;
}

export interface ModeResolution {
  mode: OperatingMode;
  externalPaidApiApproved: boolean;
  liveApproval: LiveApproval | null;
  reasons: string[];
}

/**
 * Decide the operating mode from explicit founder input. Defaults to
 * SIMULATION. LIVE needs *all* of: AUTOMATON_MODE=LIVE, the CLI flag
 * --i-understand-real-money and a valid approval file. Anything less
 * fails closed to SIMULATION with an explanation.
 */
export function resolveOperatingMode(input: ModeResolutionInput): ModeResolution {
  const reasons: string[] = [];
  const requested = (input.env.AUTOMATON_MODE ?? "SIMULATION").toUpperCase();
  const externalPaidApiApproved = input.env.AUTOMATON_ALLOW_PAID_INFERENCE === "yes";

  if (requested === "SIMULATION") {
    reasons.push("AUTOMATON_MODE not set or SIMULATION -> SIMULATION (default)");
    return { mode: "SIMULATION", externalPaidApiApproved: false, liveApproval: null, reasons };
  }

  if (requested === "SHADOW") {
    reasons.push("AUTOMATON_MODE=SHADOW -> SHADOW (money stays virtual)");
    if (externalPaidApiApproved) {
      reasons.push("AUTOMATON_ALLOW_PAID_INFERENCE=yes -> metered inference APIs allowed within real-cost cap");
    }
    return { mode: "SHADOW", externalPaidApiApproved, liveApproval: null, reasons };
  }

  if (requested === "LIVE") {
    const flag = input.argv.includes("--i-understand-real-money");
    const approval = input.loadLiveApproval ? input.loadLiveApproval() : null;
    if (!flag) {
      reasons.push("AUTOMATON_MODE=LIVE but CLI flag --i-understand-real-money missing -> falling back to SIMULATION");
      return { mode: "SIMULATION", externalPaidApiApproved: false, liveApproval: null, reasons };
    }
    if (!approval) {
      reasons.push("AUTOMATON_MODE=LIVE but no valid live-approval.json -> falling back to SIMULATION");
      return { mode: "SIMULATION", externalPaidApiApproved: false, liveApproval: null, reasons };
    }
    reasons.push("AUTOMATON_MODE=LIVE with flag and approval file -> LIVE requested (adapters not implemented in this phase)");
    return { mode: "LIVE", externalPaidApiApproved, liveApproval: approval, reasons };
  }

  reasons.push(`Unknown AUTOMATON_MODE=${requested} -> failing closed to SIMULATION`);
  return { mode: "SIMULATION", externalPaidApiApproved: false, liveApproval: null, reasons };
}
