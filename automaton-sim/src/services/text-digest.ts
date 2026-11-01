/**
 * TextDigestService — research digest / summarisation.
 *
 * v1: extractive summary by term-frequency sentence scoring
 * v2: + weights sentences with numbers/named entities, removes boilerplate
 * v3: + uses the configured model (simulated in SIMULATION mode) to refine
 *     the selection; quality then depends on the model tier
 */

import type { DigitalService, ServiceContext, ServiceJob, ServiceOutput } from "./types.js";

const STOPWORDS = new Set(
  "the a an and or but of to in on for with by from as is are was were be been it this that these those at into over under about we you they he she our their its not no yes also than then so such very can could would should may might will just more most other some any each".split(" "),
);

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function extractiveDigest(text: string, maxSentences: number, version: number): string[] {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return sentences;
  const freq = new Map<string, number>();
  const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß\s]/g, " ").split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  for (const s of sentences) for (const w of tokenize(s)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const boilerplate = /^(click here|subscribe|all rights reserved|cookie|terms of service)/i;
  const scored = sentences.map((s, idx) => {
    const words = tokenize(s);
    let score = words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) / Math.max(1, words.length);
    if (version >= 2) {
      if (/\d/.test(s)) score *= 1.35; // numbers = facts
      if (/[A-Z][a-z]+\s[A-Z][a-z]+/.test(s)) score *= 1.15; // likely named entity
      if (boilerplate.test(s)) score = 0;
      if (words.length < 4) score *= 0.5;
    }
    return { idx, score };
  });
  const chosen = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => sentences[x.idx]);
  return chosen;
}

export class TextDigestService implements DigitalService {
  readonly category = "text_digest" as const;
  readonly capabilities: readonly string[];

  constructor(readonly version: number) {
    if (version < 1 || version > 3) throw new RangeError(`unknown text digest version ${version}`);
    this.capabilities =
      version === 1 ? ["extractive_summary"] : version === 2 ? ["extractive_summary", "fact_weighting", "boilerplate_removal"] : ["extractive_summary", "fact_weighting", "boilerplate_removal", "model_refinement"];
  }

  get usesInference(): boolean {
    return this.version >= 3;
  }

  async execute(job: ServiceJob, ctx: ServiceContext): Promise<ServiceOutput> {
    if (job.input.kind !== "text_digest") throw new Error("wrong input kind");
    const base = extractiveDigest(job.input.text, job.input.maxSentences, this.version);
    const notes: string[] = [`${base.length} sentence(s) selected`];
    if (this.version >= 3 && ctx.llm) {
      const candidates = extractiveDigest(job.input.text, job.input.maxSentences + 2, 2);
      const prompt = `Select the ${job.input.maxSentences} most informative sentences, return them verbatim, one per line:\n${candidates.join("\n")}`;
      const res = await ctx.llm(prompt, "You are a precise research assistant.");
      if (res.text.trim().length > 0) {
        const lines = res.text.split(/\n+/).map((l) => l.trim()).filter((l) => candidates.includes(l));
        if (lines.length >= Math.min(2, job.input.maxSentences)) {
          notes.push("model refined selection");
          return { category: this.category, version: this.version, digest: lines.slice(0, job.input.maxSentences).join(" "), notes };
        }
      }
      // Simulated model: refine deterministically using the quality factor as
      // the number of extra candidates we are allowed to evaluate.
      const extra = Math.round(res.qualityFactor * 2);
      const refined = extractiveDigest(job.input.text, job.input.maxSentences + extra, 2).slice(0, job.input.maxSentences);
      notes.push(`simulated model refinement (quality factor ${res.qualityFactor})`);
      return { category: this.category, version: this.version, digest: refined.join(" "), notes };
    }
    return { category: this.category, version: this.version, digest: base.join(" "), notes };
  }

  async selfTest(): Promise<boolean> {
    const text = "Revenue grew 12 percent in 2025. The office has a plant. Costs fell by 3 percent. The weather was fine.";
    const d = extractiveDigest(text, 2, this.version).join(" ");
    return d.includes("Revenue") || d.includes("Costs");
  }
}
