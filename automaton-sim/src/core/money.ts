/**
 * Money primitives.
 *
 * All monetary amounts are integer micro-USDC (1 USDC = 1_000_000 micro).
 * Integers avoid floating point drift in the ledger. USDC itself has
 * 6 decimals, so this is the native on-chain resolution of the token that
 * the LIVE mode would later use on Base.
 */

export type Micro = number;

export const MICRO_PER_USDC = 1_000_000;

export function usdc(amount: number): Micro {
  if (!Number.isFinite(amount)) throw new TypeError(`Invalid USDC amount: ${amount}`);
  return Math.round(amount * MICRO_PER_USDC);
}

export function toUsdc(micro: Micro): number {
  return micro / MICRO_PER_USDC;
}

export function assertMicro(value: unknown, label = "amount"): asserts value is Micro {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer micro-USDC value, got ${String(value)}`);
  }
}

export function assertPositiveMicro(value: unknown, label = "amount"): asserts value is Micro {
  assertMicro(value, label);
  if (value <= 0) throw new RangeError(`${label} must be > 0, got ${value}`);
}

export function formatUsdc(micro: Micro, decimals = 4): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  return `${sign}${(abs / MICRO_PER_USDC).toFixed(decimals)} USDC`;
}

/** Multiply a micro amount by a factor and round to integer micro. */
export function scaleMicro(micro: Micro, factor: number): Micro {
  return Math.round(micro * factor);
}
