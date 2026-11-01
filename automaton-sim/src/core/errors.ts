export class SimulationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientFundsError extends SimulationError {
  constructor(readonly walletId: string, readonly requested: number, readonly available: number) {
    super(
      `Insufficient funds in wallet ${walletId}: requested ${requested} micro, available ${available} micro`,
      "INSUFFICIENT_FUNDS",
    );
  }
}

export class DuplicateEntryError extends SimulationError {
  constructor(readonly idempotencyKey: string) {
    super(`Duplicate ledger entry rejected (idempotency key ${idempotencyKey})`, "DUPLICATE_ENTRY");
  }
}

export class UnauthorizedLedgerOperation extends SimulationError {
  constructor(message: string) {
    super(message, "UNAUTHORIZED_LEDGER_OPERATION");
  }
}

export class SafetyViolationError extends SimulationError {
  constructor(message: string) {
    super(message, "SAFETY_VIOLATION");
  }
}

export class AgentDeadError extends SimulationError {
  constructor(agentId: string) {
    super(`Agent ${agentId} is DEAD; no further paid actions are possible`, "AGENT_DEAD");
  }
}

export class ProviderFailureError extends SimulationError {
  constructor(message: string, readonly provider: string) {
    super(message, "PROVIDER_FAILURE");
  }
}

export class InvalidActionError extends SimulationError {
  constructor(message: string) {
    super(message, "INVALID_ACTION");
  }
}
