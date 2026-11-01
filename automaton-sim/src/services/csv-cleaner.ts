/**
 * CsvCleanerService — real data cleaning.
 *
 * v1: trim cells, drop empty rows, drop exact duplicates
 * v2: + normalise dates (dd.mm.yyyy, mm/dd/yyyy -> yyyy-mm-dd), decimal commas
 * v3: + normalise headers to snake_case, unify casing of categorical values
 */

import type { DigitalService, ServiceContext, ServiceJob, ServiceOutput } from "./types.js";

export const CSV_CLEANER_CAPABILITIES: Record<number, readonly string[]> = {
  1: ["trim_whitespace", "drop_empty_rows", "drop_duplicates"],
  2: ["trim_whitespace", "drop_empty_rows", "drop_duplicates", "normalize_dates", "normalize_decimals"],
  3: ["trim_whitespace", "drop_empty_rows", "drop_duplicates", "normalize_dates", "normalize_decimals", "normalize_headers", "normalize_casing"],
};

export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(",").map((c) => c.replace(/^"|"$/g, "")));
}

export function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

const DATE_DMY = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const DATE_MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_COMMA = /^-?\d{1,3}(\.\d{3})*,\d+$|^-?\d+,\d+$/;

export function normalizeDate(value: string): string {
  if (DATE_ISO.test(value)) return value;
  let m = value.match(DATE_DMY);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = value.match(DATE_MDY);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return value;
}

export function normalizeDecimal(value: string): string {
  if (DECIMAL_COMMA.test(value)) return value.replace(/\./g, "").replace(",", ".");
  return value;
}

export function snakeCase(header: string): string {
  return header
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function cleanCsv(text: string, version: number): { csv: string; notes: string[] } {
  const caps = new Set(CSV_CLEANER_CAPABILITIES[version] ?? CSV_CLEANER_CAPABILITIES[1]);
  const notes: string[] = [];
  let rows = parseCsv(text);
  if (rows.length === 0) return { csv: "", notes: ["empty input"] };

  if (caps.has("trim_whitespace")) {
    rows = rows.map((r) => r.map((c) => c.trim().replace(/\s+/g, " ")));
  }
  if (caps.has("drop_empty_rows")) {
    const before = rows.length;
    rows = rows.filter((r, i) => i === 0 || r.some((c) => c.length > 0));
    if (rows.length !== before) notes.push(`dropped ${before - rows.length} empty row(s)`);
  }
  const header = rows[0];
  let body = rows.slice(1);

  if (caps.has("normalize_dates")) body = body.map((r) => r.map(normalizeDate));
  if (caps.has("normalize_decimals")) body = body.map((r) => r.map(normalizeDecimal));
  if (caps.has("normalize_casing")) {
    // For each column whose values are short words, unify casing to the most frequent variant (case-insensitive groups).
    for (let col = 0; col < header.length; col++) {
      const values = body.map((r) => r[col] ?? "");
      if (!values.every((v) => v === "" || (/^[a-zA-ZäöüÄÖÜß\s-]+$/.test(v) && v.length <= 30))) continue;
      const groups = new Map<string, Map<string, number>>();
      for (const v of values) {
        if (!v) continue;
        const key = v.toLowerCase();
        const g = groups.get(key) ?? new Map<string, number>();
        g.set(v, (g.get(v) ?? 0) + 1);
        groups.set(key, g);
      }
      const canonical = new Map<string, string>();
      for (const [key, g] of groups) {
        // Prefer the Title Case variant if present, else the most frequent.
        const variants = [...g.entries()].sort((a, b) => b[1] - a[1]);
        const titled = variants.find(([v]) => /^[A-ZÄÖÜ]/.test(v) && v.slice(1) === v.slice(1).toLowerCase());
        canonical.set(key, titled ? titled[0] : variants[0][0]);
      }
      body = body.map((r) => {
        const v = r[col] ?? "";
        if (!v) return r;
        const out = r.slice();
        out[col] = canonical.get(v.toLowerCase()) ?? v;
        return out;
      });
    }
  }
  if (caps.has("drop_duplicates")) {
    const seen = new Set<string>();
    const before = body.length;
    body = body.filter((r) => {
      const key = r.join("\u0001");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (body.length !== before) notes.push(`removed ${before - body.length} duplicate row(s)`);
  }
  const outHeader = caps.has("normalize_headers") ? header.map(snakeCase) : header;
  return { csv: serializeCsv([outHeader, ...body]), notes };
}

export class CsvCleanerService implements DigitalService {
  readonly category = "data_cleaning" as const;
  readonly usesInference = false;
  readonly capabilities: readonly string[];

  constructor(readonly version: number) {
    if (!CSV_CLEANER_CAPABILITIES[version]) throw new RangeError(`unknown csv cleaner version ${version}`);
    this.capabilities = CSV_CLEANER_CAPABILITIES[version];
  }

  async execute(job: ServiceJob, _ctx: ServiceContext): Promise<ServiceOutput> {
    if (job.input.kind !== "data_cleaning") throw new Error("wrong input kind");
    const { csv, notes } = cleanCsv(job.input.csv, this.version);
    return { category: this.category, version: this.version, csv, notes };
  }

  async selfTest(): Promise<boolean> {
    const out = cleanCsv("a,b\n 1 , x \n1,x\n\n2,y", this.version).csv;
    return out === "a,b\n1,x\n2,y";
  }
}
