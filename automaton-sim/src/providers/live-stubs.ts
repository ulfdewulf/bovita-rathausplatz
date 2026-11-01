/**
 * LIVE adapters — architecture placeholders.
 *
 * Real-money operation is explicitly NOT part of this phase. These classes
 * exist so the wiring (ProviderFactory) is complete and so tests can prove
 * that every real-world effect passes through the SafetyGate and is refused
 * in SIMULATION/SHADOW. Each method asks the gate first; even in LIVE they
 * then fail with NOT_IMPLEMENTED instead of doing anything.
 */

import type { SafetyGate } from "../core/mode.js";
import type { HostingProvider, ComputeProvider, ProvisionResult, ComputeJobResult } from "./interfaces.js";
import type { PaymentProvider, SettlementRequest, SettlementResult } from "../economy/payment.js";
import type { WalletProvider, WalletOperation } from "../economy/wallet.js";
import type { LedgerAuthority } from "../economy/authority.js";
import type { Reservation } from "../economy/ledger.js";
import type { DatabasePlan, HostingPlan, LedgerEntry, DailyFinancialSummary } from "../core/types.js";
import type { Micro } from "../core/money.js";
import { SimulationError } from "../core/errors.js";

export class NotImplementedInThisPhase extends SimulationError {
  constructor(what: string) {
    super(`${what} is not implemented in this phase (LIVE operation was not commissioned)`, "NOT_IMPLEMENTED");
  }
}

export class LivePaymentAdapter implements PaymentProvider {
  readonly kind = "live" as const;
  constructor(private readonly gate: SafetyGate) {}
  settle(request: SettlementRequest): SettlementResult {
    this.gate.assertAllowed("real_payment", `settle order ${request.orderId} for ${request.gross} micro USDC`);
    throw new NotImplementedInThisPhase("LivePaymentAdapter.settle");
  }
}

export class LiveWalletAdapter implements WalletProvider {
  readonly kind = "live" as const;
  readonly chain = "eip155:8453" as const; // Base mainnet
  constructor(
    readonly id: string,
    private readonly gate: SafetyGate,
  ) {}
  balance(): Micro {
    this.gate.assertAllowed("network_read", "read on-chain USDC balance");
    throw new NotImplementedInThisPhase("LiveWalletAdapter.balance");
  }
  available(): Micro {
    return this.balance();
  }
  canAfford(_amount: Micro): boolean {
    return false;
  }
  credit(_op: WalletOperation, _authority: LedgerAuthority): LedgerEntry {
    this.gate.assertAllowed("real_payment", "credit live wallet");
    throw new NotImplementedInThisPhase("LiveWalletAdapter.credit");
  }
  debit(op: WalletOperation, _authority: LedgerAuthority): LedgerEntry {
    this.gate.assertAllowed("mainnet_signature", `sign USDC transfer of ${op.amount} micro`);
    throw new NotImplementedInThisPhase("LiveWalletAdapter.debit");
  }
  transfer(_to: WalletProvider, amount: Micro): { debit: LedgerEntry; credit: LedgerEntry } {
    this.gate.assertAllowed("mainnet_signature", `sign USDC transfer of ${amount} micro`);
    throw new NotImplementedInThisPhase("LiveWalletAdapter.transfer");
  }
  reserve(_amount: Micro): Reservation {
    throw new NotImplementedInThisPhase("LiveWalletAdapter.reserve");
  }
  getTransactions(): LedgerEntry[] {
    this.gate.assertAllowed("network_read", "read on-chain transactions");
    throw new NotImplementedInThisPhase("LiveWalletAdapter.getTransactions");
  }
  getFinancialHistory(): DailyFinancialSummary[] {
    throw new NotImplementedInThisPhase("LiveWalletAdapter.getFinancialHistory");
  }
}

export class LiveHostingAdapter implements HostingProvider {
  readonly kind = "live" as const;
  constructor(private readonly gate: SafetyGate) {}
  changePlan(agentId: string, from: HostingPlan, to: HostingPlan): ProvisionResult {
    this.gate.assertAllowed("paid_resource", `change hosting plan ${from} -> ${to} for ${agentId}`);
    throw new NotImplementedInThisPhase("LiveHostingAdapter.changePlan");
  }
  changeDatabasePlan(agentId: string, from: DatabasePlan, to: DatabasePlan): ProvisionResult {
    this.gate.assertAllowed("paid_resource", `change database plan ${from} -> ${to} for ${agentId}`);
    throw new NotImplementedInThisPhase("LiveHostingAdapter.changeDatabasePlan");
  }
  registerDomain(agentId: string, name: string): ProvisionResult {
    this.gate.assertAllowed("paid_resource", `register domain ${name} for ${agentId}`);
    throw new NotImplementedInThisPhase("LiveHostingAdapter.registerDomain");
  }
  deploy(agentId: string, productId: string, version: number): ProvisionResult {
    this.gate.assertAllowed("deployment", `deploy ${productId} v${version} for ${agentId}`);
    throw new NotImplementedInThisPhase("LiveHostingAdapter.deploy");
  }
  canServeRequest(): boolean {
    return false;
  }
}

export class LiveComputeAdapter implements ComputeProvider {
  readonly kind = "live" as const;
  constructor(private readonly gate: SafetyGate) {}
  runJob<T>(agentId: string, _job: () => T): { result: T; compute: ComputeJobResult } {
    this.gate.assertAllowed("paid_resource", `run metered compute job for ${agentId}`);
    throw new NotImplementedInThisPhase("LiveComputeAdapter.runJob");
  }
}
