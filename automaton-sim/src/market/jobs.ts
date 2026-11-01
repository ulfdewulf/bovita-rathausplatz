/**
 * Synthetic customer jobs with hidden ground truth.
 *
 * The generator plants known defects; the scorer checks the service output
 * against them. The agent's service only ever sees the input.
 */

import type { SeededRandom } from "../core/rng.js";
import type { ProductCategory } from "../core/types.js";
import type { ServiceInput, ServiceOutput } from "../services/types.js";
import type { MarketConfig } from "./config.js";
import { parseCsv } from "../services/csv-cleaner.js";

export interface JobGroundTruth {
  category: ProductCategory;
  /** website_audit: planted finding codes; data_cleaning: planted defect types */
  planted: string[];
  /** data_cleaning: canonical clean CSV */
  expectedCsv?: string;
  /** text_digest: key fact sentences and boilerplate sentences */
  keyFacts?: string[];
  boilerplate?: string[];
}

export interface GeneratedJob {
  input: ServiceInput;
  truth: JobGroundTruth;
}

// ─── Website audit ──────────────────────────────────────────────────────

const AUDIT_DEFECT_WEIGHTS: Array<[string, number]> = [
  ["missing_title", 3],
  ["missing_meta_description", 4],
  ["h1_count", 3],
  ["img_missing_alt", 4],
  ["missing_lang", 2],
  ["title_length", 2],
  ["meta_description_length", 2],
  ["missing_viewport", 2],
  ["heading_skip", 2],
  ["dangling_anchor", 1.5],
  ["duplicate_id", 1],
  ["empty_link_text", 1.5],
  ["unlabeled_input", 1.5],
  ["missing_canonical", 2],
  ["mixed_content", 1],
  ["thin_content", 1.5],
];

const WORDS = "service product quality customer analysis report insight growth market strategy digital platform data audit performance accessibility content structure page visitor conversion value offer plan review".split(" ");

function paragraph(rng: SeededRandom, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(rng.pick(WORDS));
  return out.join(" ") + ".";
}

export function generateAuditJob(rng: SeededRandom, cfg: MarketConfig): GeneratedJob {
  const [min, max] = cfg.jobs.auditDefects;
  const count = rng.nextInt(min, max);
  const pool = AUDIT_DEFECT_WEIGHTS.slice();
  const planted = new Set<string>();
  while (planted.size < count && pool.length) {
    const idx = pool.findIndex(([k]) => k === rng.pickWeighted(pool.map(([k]) => k), pool.map(([, w]) => w)));
    planted.add(pool[idx][0]);
    pool.splice(idx, 1);
  }
  const has = (d: string) => planted.has(d);

  const title = has("missing_title") ? "" : has("title_length") ? "Hi" : "Example Business Services and Products";
  const meta = has("missing_meta_description")
    ? ""
    : `<meta name="description" content="${has("meta_description_length") ? "Short." : "We provide professional digital services, audits and reports for small businesses across Europe."}">`;
  const viewport = has("missing_viewport") ? "" : `<meta name="viewport" content="width=device-width, initial-scale=1">`;
  const canonical = has("missing_canonical") ? "" : `<link rel="canonical" href="https://example-${rng.nextInt(1, 999)}.test/">`;
  const lang = has("missing_lang") ? "" : ` lang="en"`;
  const h1 = has("h1_count") ? (rng.chance(0.5) ? "" : "<h1>One</h1><h1>Two</h1>") : "<h1>Welcome to our services</h1>";
  const headings = has("heading_skip") ? "<h2>Section</h2><h4>Deep</h4>" : "<h2>Section</h2><h3>Details</h3>";
  const img = has("img_missing_alt") ? `<img src="https://cdn.example.test/hero.png">` : `<img src="https://cdn.example.test/hero.png" alt="Team at work">`;
  const anchor = has("dangling_anchor") ? `<a href="#pricing">Pricing</a>` : `<a href="#contact">Contact</a>`;
  const ids = has("duplicate_id") ? `<div id="box">A</div><div id="box">B</div>` : `<div id="box">A</div><div id="box2">B</div>`;
  const link = has("empty_link_text") ? `<a href="/more"></a>` : `<a href="/more">Read more</a>`;
  const form = has("unlabeled_input")
    ? `<form><input type="email" id="email"><button type="submit">Go</button></form>`
    : `<form><label for="email">Email</label><input type="email" id="email"><button type="submit">Go</button></form>`;
  const mixed = has("mixed_content") ? `<script src="http://cdn.example.test/app.js"></script>` : `<script src="https://cdn.example.test/app.js"></script>`;
  const wordCount = has("thin_content") ? 80 : 420;
  const body = paragraph(rng, wordCount);

  const html = `<!doctype html>
<html${lang}>
<head>
<meta charset="utf-8">
${title ? `<title>${title}</title>` : ""}
${meta}
${viewport}
${canonical}
${mixed}
</head>
<body>
${h1}
${headings}
${img}
<p>${body}</p>
${anchor}
${ids}
${link}
${form}
<section id="contact"><p>Contact us.</p></section>
</body>
</html>`;

  return {
    input: { kind: "website_audit", url: `https://example-${rng.nextInt(1, 9999)}.test/`, html },
    truth: { category: "website_audit", planted: [...planted] },
  };
}

// ─── CSV cleaning ───────────────────────────────────────────────────────

const CITIES = ["Berlin", "Zurich", "Vienna", "Hamburg", "Munich", "Basel"];
const CATEGORIES = ["Retail", "Services", "Software", "Consulting"];
const CSV_DEFECTS = ["whitespace", "duplicates", "empty_rows", "date_formats", "decimal_comma", "casing", "headers"] as const;

export function generateCsvJob(rng: SeededRandom, cfg: MarketConfig): GeneratedJob {
  const rows = rng.nextInt(cfg.jobs.csvRows[0], cfg.jobs.csvRows[1]);
  const [dmin, dmax] = cfg.jobs.csvDefects;
  const count = rng.nextInt(dmin, dmax);
  const pool = [...CSV_DEFECTS];
  const planted: string[] = [];
  while (planted.length < count && pool.length) {
    const d = rng.pick(pool);
    planted.push(d);
    pool.splice(pool.indexOf(d), 1);
  }
  const has = (d: string) => planted.includes(d);

  const header = ["id", "customer_name", "city", "order_date", "amount", "category"];
  const clean: string[][] = [];
  for (let i = 0; i < rows; i++) {
    const y = 2024 + rng.nextInt(0, 1);
    const m = rng.nextInt(1, 12);
    const d = rng.nextInt(1, 28);
    const amount = (rng.nextInt(100, 99999) / 100).toFixed(2);
    clean.push([
      String(1000 + i),
      `Customer ${i + 1}`,
      rng.pick(CITIES),
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      amount,
      rng.pick(CATEGORIES),
    ]);
  }
  const expectedCsv = [header.join(","), ...clean.map((r) => r.join(","))].join("\n");

  // Apply defects to a copy.
  let dirtyHeader = header.slice();
  if (has("headers")) dirtyHeader = ["ID", "Customer Name", "City", "Order Date", "Amount", "Category"];
  const dirty: string[][] = clean.map((r) => r.slice());
  if (has("date_formats")) {
    for (const r of dirty) {
      if (rng.chance(0.5)) {
        const [y, m, d] = r[3].split("-");
        r[3] = rng.chance(0.5) ? `${Number(d)}.${Number(m)}.${y}` : `${Number(m)}/${Number(d)}/${y}`;
      }
    }
  }
  if (has("decimal_comma")) {
    for (const r of dirty) {
      if (rng.chance(0.6)) r[4] = r[4].replace(".", ",");
    }
  }
  if (has("casing")) {
    for (const r of dirty) {
      if (rng.chance(0.3)) r[2] = rng.chance(0.5) ? r[2].toLowerCase() : r[2].toUpperCase();
    }
  }
  if (has("whitespace")) {
    for (const r of dirty) {
      if (rng.chance(0.5)) {
        const col = rng.nextInt(0, 5);
        r[col] = ` ${r[col]}  `;
      }
    }
  }
  const lines: string[][] = [...dirty];
  if (has("duplicates")) {
    const extra = rng.nextInt(1, Math.max(1, Math.floor(rows / 6)));
    for (let i = 0; i < extra; i++) lines.push(rng.pick(dirty).slice());
  }
  if (has("empty_rows")) {
    const extra = rng.nextInt(1, 3);
    for (let i = 0; i < extra; i++) lines.splice(rng.nextInt(0, lines.length), 0, ["", "", "", "", "", ""]);
  }
  const csv = [dirtyHeader.join(","), ...lines.map((r) => r.join(","))].join("\n");

  return {
    input: { kind: "data_cleaning", csv },
    truth: { category: "data_cleaning", planted, expectedCsv },
  };
}

// ─── Text digest ────────────────────────────────────────────────────────

const ENTITIES = ["Nordwind AG", "Helvetia Labs", "Baltic Retail", "Alpen Logistik", "Rhein Capital", "Tessin Foods"];
const METRICS = ["revenue", "operating margin", "customer base", "headcount", "churn", "export volume"];
const FILLER = [
  "The office was repainted in a neutral tone last spring.",
  "Several employees prefer tea over coffee in the afternoon.",
  "The meeting room has a view of the parking lot.",
  "Visitors are asked to sign in at the front desk.",
  "The company newsletter is published on Fridays.",
  "A new plant was placed next to the reception.",
  "The cafeteria menu changes every week.",
  "Parking is available behind the building.",
  "The lobby features artwork from local artists.",
  "Employees celebrated a colleague's birthday on Tuesday.",
  "The printer on the second floor was replaced.",
  "The annual picnic took place in a nearby park.",
];
const BOILERPLATE = [
  "Click here to subscribe to our newsletter.",
  "All rights reserved by the publisher.",
  "Cookie settings can be adjusted in your browser.",
  "Terms of service apply to all content on this page.",
];

export function generateDigestJob(rng: SeededRandom, cfg: MarketConfig): GeneratedJob {
  const k = rng.nextInt(cfg.jobs.digestKeyFacts[0], cfg.jobs.digestKeyFacts[1]);
  const f = rng.nextInt(cfg.jobs.digestFiller[0], cfg.jobs.digestFiller[1]);
  const keyFacts: string[] = [];
  for (let i = 0; i < k; i++) {
    const entity = rng.pick(ENTITIES);
    const metric = rng.pick(METRICS);
    const pct = rng.nextInt(2, 48);
    const year = 2023 + rng.nextInt(0, 3);
    const dir = rng.chance(0.6) ? "increased" : "declined";
    keyFacts.push(`${entity} reported that ${metric} ${dir} by ${pct} percent in ${year}.`);
  }
  const fillers: string[] = [];
  for (let i = 0; i < f; i++) fillers.push(rng.pick(FILLER));
  const boilerplate = [rng.pick(BOILERPLATE), rng.pick(BOILERPLATE)];
  const all = [...keyFacts, ...fillers, ...boilerplate];
  // Shuffle deterministically.
  for (let i = all.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return {
    input: { kind: "text_digest", text: all.join(" "), maxSentences: k },
    truth: { category: "text_digest", planted: keyFacts.slice(), keyFacts, boilerplate },
  };
}

export function generateJob(category: ProductCategory, rng: SeededRandom, cfg: MarketConfig): GeneratedJob {
  switch (category) {
    case "website_audit":
      return generateAuditJob(rng, cfg);
    case "data_cleaning":
      return generateCsvJob(rng, cfg);
    case "text_digest":
      return generateDigestJob(rng, cfg);
  }
}

// ─── Scoring ────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns quality in [0, 1]. */
export function scoreOutput(truth: JobGroundTruth, output: ServiceOutput): number {
  switch (truth.category) {
    case "website_audit": {
      const found = new Set((output.findings ?? []).map((f) => f.code));
      const planted = new Set(truth.planted);
      let hits = 0;
      for (const p of planted) if (found.has(p)) hits++;
      let falsePositives = 0;
      for (const f of found) if (!planted.has(f)) falsePositives++;
      const recall = planted.size ? hits / planted.size : 1;
      return clamp01(recall - 0.08 * falsePositives);
    }
    case "data_cleaning": {
      if (!output.csv || !truth.expectedCsv) return 0;
      const out = parseCsv(output.csv);
      const expected = parseCsv(truth.expectedCsv);
      if (out.length === 0) return 0;
      const header = out[0];
      const body = out.slice(1);
      const expectedBody = expected.slice(1);
      const checks: Record<string, () => boolean> = {
        whitespace: () => out.every((r) => r.every((c) => c === c.trim() && !/\s{2,}/.test(c))),
        empty_rows: () => body.every((r) => r.some((c) => c.length > 0)),
        duplicates: () => new Set(body.map((r) => r.join("\u0001"))).size === body.length && body.length === expectedBody.length,
        date_formats: () => body.every((r) => ISO_DATE.test((r[3] ?? "").trim())),
        decimal_comma: () => body.every((r) => /^-?\d+(\.\d+)?$/.test((r[4] ?? "").trim())),
        casing: () => body.every((r) => CITIES.includes((r[2] ?? "").trim())),
        headers: () => header.join(",") === expected[0].join(","),
      };
      let fixed = 0;
      for (const d of truth.planted) if (checks[d]?.()) fixed++;
      const base = truth.planted.length ? fixed / truth.planted.length : 1;
      // Penalise destroying data: row count must not fall below expected.
      const rowPenalty = body.length < expectedBody.length - 1 ? 0.3 : 0;
      return clamp01(base - rowPenalty);
    }
    case "text_digest": {
      const digest = output.digest ?? "";
      const key = truth.keyFacts ?? [];
      const hits = key.filter((s) => digest.includes(s)).length;
      const boiler = (truth.boilerplate ?? []).filter((s) => digest.includes(s)).length;
      const coverage = key.length ? hits / key.length : 1;
      return clamp01(coverage - 0.15 * boiler);
    }
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
