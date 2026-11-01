/**
 * StateStore — persistence for runs.
 *
 * JsonFileStore keeps one directory per run:
 *   snapshot.json     full world state (atomic write: tmp + rename)
 *   ledger.jsonl      append-only ledger entries
 *   decisions.jsonl   append-only decision log
 *   summary.json      run summary for comparisons
 * Zero dependencies, human-inspectable, works on every Node >= 20.
 */

import fs from "node:fs";
import path from "node:path";

export interface RunSummary {
  runId: string;
  label: string;
  scenario: string;
  seed: string;
  mode: string;
  days: number;
  agents: number;
  finalState: string;
  startingCapitalUsd: number;
  finalBalanceUsd: number;
  totalRevenueUsd: number;
  totalCostsUsd: number;
  children: number;
  customers: number;
  orders: number;
  updatedAtWallClock: string;
  disclaimer: string;
}

export interface StateStore {
  saveSnapshot(runId: string, snapshot: unknown): void;
  loadSnapshot<T>(runId: string): T | null;
  appendJsonl(runId: string, name: string, records: readonly unknown[]): void;
  readJsonl<T>(runId: string, name: string): T[];
  truncateJsonl(runId: string, name: string, keep: number): void;
  saveSummary(runId: string, summary: RunSummary): void;
  listRuns(): RunSummary[];
  deleteRun(runId: string): void;
  hasRun(runId: string): boolean;
}

export class MemoryStore implements StateStore {
  private snapshots = new Map<string, string>();
  private jsonl = new Map<string, unknown[]>();
  private summaries = new Map<string, RunSummary>();

  saveSnapshot(runId: string, snapshot: unknown): void {
    this.snapshots.set(runId, JSON.stringify(snapshot));
  }
  loadSnapshot<T>(runId: string): T | null {
    const s = this.snapshots.get(runId);
    return s ? (JSON.parse(s) as T) : null;
  }
  appendJsonl(runId: string, name: string, records: readonly unknown[]): void {
    const key = `${runId}/${name}`;
    const arr = this.jsonl.get(key) ?? [];
    for (const r of records) arr.push(JSON.parse(JSON.stringify(r)));
    this.jsonl.set(key, arr);
  }
  readJsonl<T>(runId: string, name: string): T[] {
    return ((this.jsonl.get(`${runId}/${name}`) ?? []) as T[]).map((r) => JSON.parse(JSON.stringify(r)) as T);
  }
  truncateJsonl(runId: string, name: string, keep: number): void {
    const key = `${runId}/${name}`;
    const arr = this.jsonl.get(key) ?? [];
    this.jsonl.set(key, arr.slice(0, keep));
  }
  saveSummary(runId: string, summary: RunSummary): void {
    this.summaries.set(runId, summary);
  }
  listRuns(): RunSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.updatedAtWallClock.localeCompare(a.updatedAtWallClock));
  }
  deleteRun(runId: string): void {
    this.snapshots.delete(runId);
    this.summaries.delete(runId);
    for (const k of [...this.jsonl.keys()]) if (k.startsWith(`${runId}/`)) this.jsonl.delete(k);
  }
  hasRun(runId: string): boolean {
    return this.snapshots.has(runId);
  }
}

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(runId)) throw new Error(`invalid run id ${runId}`);
  return runId;
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

export class JsonFileStore implements StateStore {
  constructor(readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  private runDir(runId: string, create = false): string {
    const dir = path.join(this.rootDir, safeRunId(runId));
    if (create) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveSnapshot(runId: string, snapshot: unknown): void {
    const dir = this.runDir(runId, true);
    atomicWrite(path.join(dir, "snapshot.json"), JSON.stringify(snapshot));
  }

  loadSnapshot<T>(runId: string): T | null {
    const file = path.join(this.runDir(runId), "snapshot.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  }

  appendJsonl(runId: string, name: string, records: readonly unknown[]): void {
    if (records.length === 0) return;
    const dir = this.runDir(runId, true);
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(path.join(dir, `${safeRunId(name)}.jsonl`), lines, "utf8");
  }

  readJsonl<T>(runId: string, name: string): T[] {
    const file = path.join(this.runDir(runId), `${safeRunId(name)}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const out: T[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        break; // a torn trailing line after a crash: stop here
      }
    }
    return out;
  }

  truncateJsonl(runId: string, name: string, keep: number): void {
    const records = this.readJsonl<unknown>(runId, name);
    if (records.length <= keep) return;
    const file = path.join(this.runDir(runId), `${safeRunId(name)}.jsonl`);
    atomicWrite(file, records.slice(0, keep).map((r) => JSON.stringify(r)).join("\n") + (keep ? "\n" : ""));
  }

  saveSummary(runId: string, summary: RunSummary): void {
    const dir = this.runDir(runId, true);
    atomicWrite(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  }

  listRuns(): RunSummary[] {
    if (!fs.existsSync(this.rootDir)) return [];
    const out: RunSummary[] = [];
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.rootDir, entry.name, "summary.json");
      if (!fs.existsSync(file)) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(file, "utf8")) as RunSummary);
      } catch {
        // skip corrupt summary
      }
    }
    return out.sort((a, b) => b.updatedAtWallClock.localeCompare(a.updatedAtWallClock));
  }

  deleteRun(runId: string): void {
    const dir = this.runDir(runId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  hasRun(runId: string): boolean {
    return fs.existsSync(path.join(this.runDir(runId), "snapshot.json"));
  }
}
