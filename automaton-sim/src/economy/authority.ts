/**
 * Ledger authorities (capabilities).
 *
 * A LedgerAuthority is an unforgeable token that says *who* is posting an
 * entry. The ledger only accepts tokens it issued itself, and it only
 * accepts credits from the founder (initial capital), the independent market
 * settlement (customer payments) and the replication controller (parent ->
 * child transfer). The agent is handed an `agent_operation` token, which can
 * only ever debit. This is how "the agent cannot credit itself" is enforced
 * technically rather than by convention.
 */

import type { LedgerAuthorityKind, LedgerCategory, LedgerKind } from "../core/types.js";

export class LedgerAuthority {
  readonly #kind: LedgerAuthorityKind;
  readonly #ledgerId: string;

  constructor(kind: LedgerAuthorityKind, ledgerId: string) {
    this.#kind = kind;
    this.#ledgerId = ledgerId;
    Object.freeze(this);
  }

  get kind(): LedgerAuthorityKind {
    return this.#kind;
  }

  get ledgerId(): string {
    return this.#ledgerId;
  }
}

const CREDIT_AUTHORITIES: ReadonlySet<LedgerAuthorityKind> = new Set<LedgerAuthorityKind>([
  "founder_capital",
  "market_settlement",
  "replication_transfer",
]);

/** Which authority may post which credit category. */
const CREDIT_CATEGORY_RULES: Readonly<Partial<Record<LedgerCategory, LedgerAuthorityKind[]>>> = Object.freeze({
  capital: ["founder_capital"],
  revenue: ["market_settlement"],
  transfer_in: ["replication_transfer"],
});

export function authorityPermits(
  authority: LedgerAuthority,
  kind: LedgerKind,
  category: LedgerCategory,
): { ok: true } | { ok: false; reason: string } {
  if (kind === "debit") {
    // Debits (spending) are allowed for every authority; refunds are
    // debits posted by the market settlement authority.
    if (category === "refund" && authority.kind !== "market_settlement") {
      return { ok: false, reason: "refunds can only be posted by market settlement" };
    }
    return { ok: true };
  }
  if (!CREDIT_AUTHORITIES.has(authority.kind)) {
    return {
      ok: false,
      reason: `authority "${authority.kind}" may not credit any account`,
    };
  }
  const allowed = CREDIT_CATEGORY_RULES[category];
  if (!allowed) {
    return { ok: false, reason: `category "${category}" is not a creditable category` };
  }
  if (!allowed.includes(authority.kind)) {
    return {
      ok: false,
      reason: `credit category "${category}" requires authority ${allowed.join("|")}, got "${authority.kind}"`,
    };
  }
  return { ok: true };
}
