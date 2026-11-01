/**
 * Executable digital services — the products the agent actually sells.
 *
 * Each service is real code that transforms a customer input into an
 * output. The customer simulator plants defects in the inputs it generates
 * and scores the output against that hidden ground truth, so product quality
 * is measured, not declared.
 */

import type { ProductCategory } from "../core/types.js";

export interface WebsiteAuditInput {
  kind: "website_audit";
  url: string;
  html: string;
}

export interface DataCleaningInput {
  kind: "data_cleaning";
  csv: string;
}

export interface TextDigestInput {
  kind: "text_digest";
  text: string;
  maxSentences: number;
}

export type ServiceInput = WebsiteAuditInput | DataCleaningInput | TextDigestInput;

export interface ServiceJob {
  jobId: string;
  input: ServiceInput;
}

export interface WebsiteAuditFinding {
  code: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface ServiceOutput {
  category: ProductCategory;
  version: number;
  /** Website audit: finding codes. */
  findings?: WebsiteAuditFinding[];
  /** Data cleaning: cleaned CSV text. */
  csv?: string;
  /** Text digest: digest text. */
  digest?: string;
  notes: string[];
}

export interface ServiceContext {
  /** Optional LLM access for services that use a model. */
  llm?: (prompt: string, system: string) => Promise<{ text: string; qualityFactor: number }>;
}

export interface DigitalService {
  readonly category: ProductCategory;
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly usesInference: boolean;
  execute(job: ServiceJob, ctx: ServiceContext): Promise<ServiceOutput>;
  /** Smoke test used before a new version is published. */
  selfTest(): Promise<boolean>;
}
