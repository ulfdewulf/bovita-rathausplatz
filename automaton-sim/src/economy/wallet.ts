/**
 * WalletProvider interface + VirtualWallet.
 *
 * The VirtualWallet is a thin, authority-checked view on the EconomicLedger.
 * Later, a LiveWalletAdapter implements the same interface against a real
 * Base/USDC wallet; the business logic does not change.
 */

import type { LedgerAuthority } from "./authority.js";
import type { EconomicLedger, LedgerFilter, Reservation } from "./ledger.js";
import type { DailyFinancialSummary, LedgerCategory, LedgerEntry, PriceBasis } from "../core/types.js";
import type { Micro } from "../core/money.js";

export interface WalletOperation {
  amount: Micro;
  category: LedgerCategory;
  basis: PriceBasis | "n/a";
  description: string;
  idempotencyKey?: string;
  refs?: Record<string, string>;
}

export interface WalletProvider {
  readonly id: string;
  readonly kind: "virtual" | "live";
  readonly chain: string; // "simulated:base" or "eip155:8453"
  balance(): Micro;
  available(): Micro;
  credit(op: WalletOperation, authority: LedgerAuthority): LedgerEntry;
  debit(op: WalletOperation, authority: LedgerAuthority): LedgerEntry;
  transfer(
    to: WalletProvider,
    amount: Micro,
    description: string,
    authority: LedgerAuthority,
    refs?: Record<string, string>,
    idempotencyKey?: string,
  ): { debit: LedgerEntry; credit: LedgerEntry };
  reserve(amount: Micro): Reservation;
  canAfford(amount: Micro): boolean;
  getTransactions(filter?: Omit<LedgerFilter, "accountId">): LedgerEntry[];
  getFinancialHistory(fromDay?: number, toDay?: number): DailyFinancialSummary[];
}

export class VirtualWallet implements WalletProvider {
  readonly kind = "virtual" as const;
  readonly chain = "simulated:base" as const;

  constructor(
    readonly id: string,
    private readonly ledger: EconomicLedger,
  ) {
    if (!ledger.hasAccount(id)) throw new Error(`Ledger has no account ${id}`);
  }

  balance(): Micro {
    return this.ledger.balance(this.id);
  }

  available(): Micro {
    return this.ledger.available(this.id);
  }

  canAfford(amount: Micro): boolean {
    return this.ledger.canDebit(this.id, amount);
  }

  credit(op: WalletOperation, authority: LedgerAuthority): LedgerEntry {
    return this.ledger.post({ ...op, accountId: this.id, kind: "credit" }, authority);
  }

  debit(op: WalletOperation, authority: LedgerAuthority): LedgerEntry {
    return this.ledger.post({ ...op, accountId: this.id, kind: "debit" }, authority);
  }

  transfer(
    to: WalletProvider,
    amount: Micro,
    description: string,
    authority: LedgerAuthority,
    refs: Record<string, string> = {},
    idempotencyKey?: string,
  ): { debit: LedgerEntry; credit: LedgerEntry } {
    if (to.kind !== "virtual") {
      throw new Error("A virtual wallet can only transfer to another virtual wallet");
    }
    return this.ledger.transfer(this.id, to.id, amount, description, authority, refs, idempotencyKey);
  }

  reserve(amount: Micro): Reservation {
    return this.ledger.reserve(this.id, amount);
  }

  getTransactions(filter: Omit<LedgerFilter, "accountId"> = {}): LedgerEntry[] {
    return this.ledger.getEntries({ ...filter, accountId: this.id });
  }

  getFinancialHistory(fromDay?: number, toDay?: number): DailyFinancialSummary[] {
    return this.ledger.dailySummary(this.id, fromDay, toDay);
  }
}

/**
 * The read-only wallet view that is handed to the agent's decision logic.
 * It exposes observation only; no credit/debit methods exist on it.
 */
export interface AgentWalletView {
  readonly id: string;
  balance(): Micro;
  getTransactions(filter?: Omit<LedgerFilter, "accountId">): LedgerEntry[];
  getFinancialHistory(fromDay?: number, toDay?: number): DailyFinancialSummary[];
}

export function createAgentWalletView(wallet: WalletProvider): AgentWalletView {
  const view: AgentWalletView = {
    id: wallet.id,
    balance: () => wallet.balance(),
    getTransactions: (filter) => wallet.getTransactions(filter),
    getFinancialHistory: (fromDay, toDay) => wallet.getFinancialHistory(fromDay, toDay),
  };
  return Object.freeze(view);
}
