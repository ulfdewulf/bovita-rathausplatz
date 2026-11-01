/**
 * EconomicLedger
 *
 * Append-only, hash-chained double-entry-ish ledger that is the single
 * source of truth for every virtual balance. Wallets are views on the
 * ledger. Properties:
 *
 *   - integer micro-USDC, no floats
 *   - unique sequential ids, hash chain over the entries (tamper evidence,
 *     reproducibility checks via ledgerHash())
 *   - idempotency keys reject double booking
 *   - balance checks: no debit may push an account below its credit line
 *     (0 by default: no overdraft)
 *   - authority checks: who may credit what (see authority.ts)
 *   - transactional sections with rollback for multi-entry operations
 */

import { createHash } from "node:crypto";
import type {
  LedgerAuthorityKind,
  LedgerCategory,
  LedgerEntry,
  LedgerPostRequest,
  DailyFinancialSummary,
  PriceBasis,
} from "../core/types.js";
import { assertMicro, type Micro } from "../core/money.js";
import { DuplicateEntryError, InsufficientFundsError, UnauthorizedLedgerOperation } from "../core/errors.js";
import type { SimulationClock } from "../core/clock.js";
import type { IdGenerator } from "../core/ids.js";
import { LedgerAuthority, authorityPermits } from "./authority.js";

export interface LedgerAccount {
  id: string;
  label: string;
  /** Explicit credit facility. 0 = overdraft impossible. */
  creditLine: Micro;
  balance: Micro;
  reserved: Micro;
  createdDay: number;
}

export interface LedgerState {
  ledgerId: string;
  accounts: LedgerAccount[];
  entries: LedgerEntry[];
}

export interface LedgerFilter {
  accountId?: string;
  category?: LedgerCategory;
  kind?: "credit" | "debit";
  fromDay?: number;
  toDay?: number;
  limit?: number;
}

const COST_CATEGORIES: ReadonlySet<LedgerCategory> = new Set<LedgerCategory>([
  "inference",
  "compute",
  "hosting",
  "database",
  "domain",
  "api",
  "marketing",
  "deployment",
  "payment_fee",
  "other",
  "refund",
]);

export function isCostCategory(category: LedgerCategory): boolean {
  return COST_CATEGORIES.has(category);
}

function canonical(entry: Omit<LedgerEntry, "hash">): string {
  return JSON.stringify({
    id: entry.id,
    seq: entry.seq,
    accountId: entry.accountId,
    kind: entry.kind,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    category: entry.category,
    basis: entry.basis,
    description: entry.description,
    authority: entry.authority,
    virtualTime: entry.virtualTime,
    virtualDay: entry.virtualDay,
    idempotencyKey: entry.idempotencyKey,
    counterpartyAccountId: entry.counterpartyAccountId,
    refs: entry.refs,
    prevHash: entry.prevHash,
  });
}

export function hashEntry(entry: Omit<LedgerEntry, "hash">): string {
  return createHash("sha256").update(canonical(entry)).digest("hex").slice(0, 32);
}

export class EconomicLedger {
  readonly ledgerId: string;
  private readonly accounts = new Map<string, LedgerAccount>();
  private entries: LedgerEntry[] = [];
  private readonly idempotency = new Map<string, string>();
  private readonly issuedAuthorities = new WeakSet<LedgerAuthority>();
  private readonly listeners: Array<(entry: LedgerEntry) => void> = [];
  private inTransaction = false;

  constructor(
    ledgerId: string,
    private readonly clock: SimulationClock,
    private readonly ids: IdGenerator,
  ) {
    this.ledgerId = ledgerId;
  }

  // ─── Authorities ────────────────────────────────────────────────────

  /**
   * Issue a capability token. Only the composition root (SimulationWorld)
   * calls this; tokens are then handed to the components that legitimately
   * need them. The agent only ever receives an `agent_operation` token.
   */
  issueAuthority(kind: LedgerAuthorityKind): LedgerAuthority {
    const token = new LedgerAuthority(kind, this.ledgerId);
    this.issuedAuthorities.add(token);
    return token;
  }

  private assertAuthority(authority: unknown, kind: "credit" | "debit", category: LedgerCategory): LedgerAuthority {
    if (!(authority instanceof LedgerAuthority) || !this.issuedAuthorities.has(authority)) {
      throw new UnauthorizedLedgerOperation(
        `Ledger ${this.ledgerId} rejected a ${kind} (${category}): missing or foreign authority token`,
      );
    }
    if (authority.ledgerId !== this.ledgerId) {
      throw new UnauthorizedLedgerOperation("authority token was issued by a different ledger");
    }
    const verdict = authorityPermits(authority, kind, category);
    if (!verdict.ok) {
      throw new UnauthorizedLedgerOperation(`Ledger ${this.ledgerId} rejected a ${kind} (${category}): ${verdict.reason}`);
    }
    return authority;
  }

  // ─── Accounts ───────────────────────────────────────────────────────

  openAccount(id: string, label: string, creditLine: Micro = 0): LedgerAccount {
    assertMicro(creditLine, "creditLine");
    if (creditLine < 0) throw new RangeError("creditLine must be >= 0");
    if (this.accounts.has(id)) throw new Error(`Account ${id} already exists`);
    const account: LedgerAccount = {
      id,
      label,
      creditLine,
      balance: 0,
      reserved: 0,
      createdDay: this.clock.day(),
    };
    this.accounts.set(id, account);
    return account;
  }

  hasAccount(id: string): boolean {
    return this.accounts.has(id);
  }

  getAccount(id: string): LedgerAccount {
    const acc = this.accounts.get(id);
    if (!acc) throw new Error(`Unknown account ${id}`);
    return acc;
  }

  listAccounts(): LedgerAccount[] {
    return [...this.accounts.values()].map((a) => ({ ...a }));
  }

  balance(accountId: string): Micro {
    return this.getAccount(accountId).balance;
  }

  available(accountId: string): Micro {
    const acc = this.getAccount(accountId);
    return acc.balance + acc.creditLine - acc.reserved;
  }

  canDebit(accountId: string, amount: Micro): boolean {
    assertMicro(amount, "amount");
    return amount >= 0 && this.available(accountId) >= amount;
  }

  // ─── Reservations ───────────────────────────────────────────────────

  /**
   * Reserve funds for an operation whose exact cost is only known after
   * an (possibly failing) provider call. Reserved funds cannot be spent
   * twice. commit() books the actual cost, release() frees the hold.
   */
  reserve(accountId: string, amount: Micro): Reservation {
    assertMicro(amount, "amount");
    if (amount < 0) throw new RangeError("reservation must be >= 0");
    const acc = this.getAccount(accountId);
    if (this.available(accountId) < amount) {
      throw new InsufficientFundsError(accountId, amount, this.available(accountId));
    }
    acc.reserved += amount;
    return new Reservation(this, accountId, amount);
  }

  /** @internal */
  _releaseReserved(accountId: string, amount: Micro): void {
    const acc = this.getAccount(accountId);
    acc.reserved = Math.max(0, acc.reserved - amount);
  }

  // ─── Posting ────────────────────────────────────────────────────────

  post(request: LedgerPostRequest, authority: LedgerAuthority): LedgerEntry {
    assertMicro(request.amount, "amount");
    this.assertAuthority(authority, request.kind, request.category);

    if (request.kind === "credit" && request.amount <= 0) {
      throw new RangeError("credit amount must be > 0");
    }
    if (request.kind === "debit" && request.amount < 0) {
      throw new RangeError("debit amount must be >= 0");
    }
    if (request.idempotencyKey && this.idempotency.has(request.idempotencyKey)) {
      throw new DuplicateEntryError(request.idempotencyKey);
    }

    const acc = this.getAccount(request.accountId);
    let balanceAfter: Micro;
    if (request.kind === "debit") {
      // Overdraft only via an explicit credit line. Reserved funds count as spent.
      if (acc.balance + acc.creditLine - acc.reserved < request.amount) {
        throw new InsufficientFundsError(acc.id, request.amount, acc.balance + acc.creditLine - acc.reserved);
      }
      balanceAfter = acc.balance - request.amount;
    } else {
      balanceAfter = acc.balance + request.amount;
    }

    const prev = this.entries[this.entries.length - 1];
    const seq = this.entries.length + 1;
    const partial: Omit<LedgerEntry, "hash"> = {
      id: this.ids.next("tx"),
      seq,
      accountId: acc.id,
      kind: request.kind,
      amount: request.amount,
      balanceAfter,
      category: request.category,
      basis: request.basis,
      description: request.description,
      authority: authority.kind,
      virtualTime: this.clock.nowIso(),
      virtualDay: this.clock.day(),
      idempotencyKey: request.idempotencyKey ?? null,
      counterpartyAccountId: request.counterpartyAccountId ?? null,
      refs: { ...(request.refs ?? {}) },
      prevHash: prev ? prev.hash : "genesis",
    };
    const entry: LedgerEntry = Object.freeze({ ...partial, hash: hashEntry(partial) });

    acc.balance = balanceAfter;
    this.entries.push(entry);
    if (entry.idempotencyKey) this.idempotency.set(entry.idempotencyKey, entry.id);
    if (!this.inTransaction) {
      for (const l of this.listeners) l(entry);
    }
    return entry;
  }

  /**
   * Atomic multi-entry operation. If `fn` throws, all entries posted inside
   * are rolled back and balances restored. Used for transfers and for
   * provider-call-then-book sequences.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    const entriesLen = this.entries.length;
    const balances = new Map<string, { balance: Micro; reserved: Micro }>();
    for (const [id, acc] of this.accounts) balances.set(id, { balance: acc.balance, reserved: acc.reserved });
    const keysBefore = new Set(this.idempotency.keys());
    this.inTransaction = true;
    try {
      const result = fn();
      this.inTransaction = false;
      for (const entry of this.entries.slice(entriesLen)) {
        for (const l of this.listeners) l(entry);
      }
      return result;
    } catch (err) {
      this.entries.length = entriesLen;
      for (const [id, snap] of balances) {
        const acc = this.accounts.get(id);
        if (acc) {
          acc.balance = snap.balance;
          acc.reserved = snap.reserved;
        }
      }
      for (const key of [...this.idempotency.keys()]) {
        if (!keysBefore.has(key)) this.idempotency.delete(key);
      }
      this.inTransaction = false;
      throw err;
    }
  }

  transfer(
    fromAccountId: string,
    toAccountId: string,
    amount: Micro,
    description: string,
    authority: LedgerAuthority,
    refs: Record<string, string> = {},
    idempotencyKey?: string,
  ): { debit: LedgerEntry; credit: LedgerEntry } {
    if (amount <= 0) throw new RangeError("transfer amount must be > 0");
    return this.transaction(() => {
      const debit = this.post(
        {
          accountId: fromAccountId,
          kind: "debit",
          amount,
          category: "transfer_out",
          basis: "n/a",
          description,
          counterpartyAccountId: toAccountId,
          refs,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:out` : undefined,
        },
        authority,
      );
      const credit = this.post(
        {
          accountId: toAccountId,
          kind: "credit",
          amount,
          category: "transfer_in",
          basis: "n/a",
          description,
          counterpartyAccountId: fromAccountId,
          refs,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:in` : undefined,
        },
        authority,
      );
      return { debit, credit };
    });
  }

  onEntry(listener: (entry: LedgerEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  // ─── Queries ────────────────────────────────────────────────────────

  getEntries(filter: LedgerFilter = {}): LedgerEntry[] {
    let out = this.entries;
    if (filter.accountId) out = out.filter((e) => e.accountId === filter.accountId);
    if (filter.category) out = out.filter((e) => e.category === filter.category);
    if (filter.kind) out = out.filter((e) => e.kind === filter.kind);
    if (filter.fromDay !== undefined) out = out.filter((e) => e.virtualDay >= filter.fromDay!);
    if (filter.toDay !== undefined) out = out.filter((e) => e.virtualDay <= filter.toDay!);
    if (filter.limit !== undefined) out = out.slice(-filter.limit);
    return out.slice();
  }

  entryCount(): number {
    return this.entries.length;
  }

  /** Hash of the last entry = fingerprint of the whole chain. */
  ledgerHash(): string {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : "genesis";
  }

  /** Per-day aggregation for one account. */
  dailySummary(accountId: string, fromDay?: number, toDay?: number): DailyFinancialSummary[] {
    const byDay = new Map<number, DailyFinancialSummary>();
    for (const e of this.entries) {
      if (e.accountId !== accountId) continue;
      if (fromDay !== undefined && e.virtualDay < fromDay) continue;
      if (toDay !== undefined && e.virtualDay > toDay) continue;
      let s = byDay.get(e.virtualDay);
      if (!s) {
        s = {
          day: e.virtualDay,
          revenue: 0,
          costs: 0,
          transfersOut: 0,
          transfersIn: 0,
          capital: 0,
          net: 0,
          closingBalance: e.balanceAfter,
          costsByCategory: {},
          costsByBasis: {},
        };
        byDay.set(e.virtualDay, s);
      }
      s.closingBalance = e.balanceAfter;
      if (e.kind === "credit") {
        if (e.category === "revenue") s.revenue += e.amount;
        else if (e.category === "capital") s.capital += e.amount;
        else if (e.category === "transfer_in") s.transfersIn += e.amount;
        s.net += e.amount;
      } else {
        if (e.category === "transfer_out") s.transfersOut += e.amount;
        else {
          s.costs += e.amount;
          s.costsByCategory[e.category] = (s.costsByCategory[e.category] ?? 0) + e.amount;
          if (e.basis !== "n/a") {
            s.costsByBasis[e.basis as PriceBasis] = (s.costsByBasis[e.basis as PriceBasis] ?? 0) + e.amount;
          }
        }
        s.net -= e.amount;
      }
    }
    return [...byDay.values()].sort((a, b) => a.day - b.day);
  }

  /** Recompute balances from scratch and verify the hash chain. */
  verifyIntegrity(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const balances = new Map<string, Micro>();
    let prevHash = "genesis";
    for (const [i, e] of this.entries.entries()) {
      if (e.seq !== i + 1) problems.push(`entry ${e.id}: seq ${e.seq} != ${i + 1}`);
      if (e.prevHash !== prevHash) problems.push(`entry ${e.id}: broken hash chain`);
      const { hash, ...rest } = e;
      if (hashEntry(rest) !== hash) problems.push(`entry ${e.id}: hash mismatch`);
      const before = balances.get(e.accountId) ?? 0;
      const after = e.kind === "credit" ? before + e.amount : before - e.amount;
      if (after !== e.balanceAfter) problems.push(`entry ${e.id}: balanceAfter ${e.balanceAfter} != ${after}`);
      balances.set(e.accountId, after);
      prevHash = hash;
    }
    for (const [id, acc] of this.accounts) {
      const computed = balances.get(id) ?? 0;
      if (computed !== acc.balance) problems.push(`account ${id}: stored ${acc.balance} != recomputed ${computed}`);
      if (acc.balance + acc.creditLine < 0) problems.push(`account ${id}: below credit line`);
    }
    return { ok: problems.length === 0, problems };
  }

  // ─── Persistence ────────────────────────────────────────────────────

  getState(): LedgerState {
    return {
      ledgerId: this.ledgerId,
      accounts: this.listAccounts().map((a) => ({ ...a, reserved: 0 })),
      entries: this.entries.slice(),
    };
  }

  static fromState(state: LedgerState, clock: SimulationClock, ids: IdGenerator): EconomicLedger {
    const ledger = new EconomicLedger(state.ledgerId, clock, ids);
    for (const acc of state.accounts) {
      ledger.accounts.set(acc.id, { ...acc, reserved: 0 });
    }
    ledger.entries = state.entries.map((e) => Object.freeze({ ...e, refs: { ...e.refs } }));
    for (const e of ledger.entries) {
      if (e.idempotencyKey) ledger.idempotency.set(e.idempotencyKey, e.id);
    }
    const check = ledger.verifyIntegrity();
    if (!check.ok) {
      throw new Error(`Refusing to load corrupt ledger ${state.ledgerId}: ${check.problems.slice(0, 3).join("; ")}`);
    }
    return ledger;
  }
}

export class Reservation {
  private settled = false;

  constructor(
    private readonly ledger: EconomicLedger,
    readonly accountId: string,
    readonly amount: Micro,
  ) {}

  get isSettled(): boolean {
    return this.settled;
  }

  /** Book the actual cost (may differ from the reserved amount) and release the hold. */
  commit(request: Omit<LedgerPostRequest, "accountId" | "kind">, authority: LedgerAuthority): LedgerEntry {
    if (this.settled) throw new Error("reservation already settled");
    this.ledger._releaseReserved(this.accountId, this.amount);
    this.settled = true;
    return this.ledger.post({ ...request, accountId: this.accountId, kind: "debit" }, authority);
  }

  release(): void {
    if (this.settled) return;
    this.ledger._releaseReserved(this.accountId, this.amount);
    this.settled = true;
  }
}
