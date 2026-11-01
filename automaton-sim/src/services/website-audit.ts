/**
 * WebsiteAuditService — a real HTML audit.
 *
 * v1: basic on-page SEO + accessibility checks
 * v2: + length checks, viewport, heading hierarchy, dangling anchors
 * v3: + duplicate ids, link text, form labels, canonical, mixed content, thin content
 */

import type { DigitalService, ServiceContext, ServiceJob, ServiceOutput, WebsiteAuditFinding } from "./types.js";

const V1_CHECKS = ["missing_title", "missing_meta_description", "h1_count", "img_missing_alt", "missing_lang"] as const;
const V2_CHECKS = [...V1_CHECKS, "title_length", "meta_description_length", "missing_viewport", "heading_skip", "dangling_anchor"] as const;
const V3_CHECKS = [...V2_CHECKS, "duplicate_id", "empty_link_text", "unlabeled_input", "missing_canonical", "mixed_content", "thin_content"] as const;

export const WEBSITE_AUDIT_CHECKS: Record<number, readonly string[]> = {
  1: V1_CHECKS,
  2: V2_CHECKS,
  3: V3_CHECKS,
};

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
}

export function auditHtml(html: string, version: number): WebsiteAuditFinding[] {
  const checks = new Set(WEBSITE_AUDIT_CHECKS[version] ?? V1_CHECKS);
  const findings: WebsiteAuditFinding[] = [];
  const add = (code: string, severity: WebsiteAuditFinding["severity"], message: string) => {
    if (checks.has(code)) findings.push({ code, severity, message });
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  if (!titleMatch || title.length === 0) add("missing_title", "high", "Page has no <title>.");
  else if (title.length < 10 || title.length > 60) add("title_length", "low", `Title length ${title.length} outside 10-60 characters.`);

  const metaTags = html.match(/<meta[^>]*>/gi) ?? [];
  const metaDesc = metaTags.find((t) => (attr(t, "name") ?? "").toLowerCase() === "description");
  if (!metaDesc) add("missing_meta_description", "medium", "No meta description.");
  else {
    const content = attr(metaDesc, "content") ?? "";
    if (content.length < 50 || content.length > 160) add("meta_description_length", "low", `Meta description length ${content.length} outside 50-160.`);
  }
  if (!metaTags.some((t) => (attr(t, "name") ?? "").toLowerCase() === "viewport")) add("missing_viewport", "medium", "No viewport meta tag.");

  const h1s = html.match(/<h1[\s>]/gi) ?? [];
  if (h1s.length !== 1) add("h1_count", "medium", `Found ${h1s.length} <h1> elements (expected exactly 1).`);

  const imgs = html.match(/<img[^>]*>/gi) ?? [];
  const missingAlt = imgs.filter((t) => attr(t, "alt") === null).length;
  if (missingAlt > 0) add("img_missing_alt", "medium", `${missingAlt} image(s) without alt attribute.`);

  const htmlTag = html.match(/<html[^>]*>/i)?.[0] ?? "";
  if (!attr(htmlTag, "lang")) add("missing_lang", "low", "<html> has no lang attribute.");

  // Heading hierarchy skips (e.g. h1 -> h3)
  const headingLevels = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => Number(m[1]));
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i] > headingLevels[i - 1] + 1) {
      add("heading_skip", "low", `Heading level jumps from h${headingLevels[i - 1]} to h${headingLevels[i]}.`);
      break;
    }
  }

  // Dangling in-page anchors
  const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const anchors = [...html.matchAll(/<a[^>]*>/gi)].map((m) => m[0]);
  const dangling = anchors.filter((a) => {
    const href = attr(a, "href") ?? "";
    return href.startsWith("#") && href.length > 1 && !ids.has(href.slice(1));
  });
  if (dangling.length > 0) add("dangling_anchor", "medium", `${dangling.length} anchor(s) point to missing ids.`);

  // Duplicate ids
  const idList = [...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  if (new Set(idList).size !== idList.length) add("duplicate_id", "medium", "Duplicate id attributes found.");

  // Empty link text
  const emptyLinks = [...html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].filter((m) => stripTags(m[1]).length === 0 && !/<img/i.test(m[1]));
  if (emptyLinks.length > 0) add("empty_link_text", "medium", `${emptyLinks.length} link(s) without text.`);

  // Inputs without labels
  const inputs = [...html.matchAll(/<input[^>]*>/gi)].map((m) => m[0]).filter((t) => !/type\s*=\s*["']?(hidden|submit|button)/i.test(t));
  const labelFor = new Set([...html.matchAll(/<label[^>]*\sfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const unlabeled = inputs.filter((t) => {
    const id = attr(t, "id");
    const ariaLabel = attr(t, "aria-label");
    return !(id && labelFor.has(id)) && !ariaLabel;
  });
  if (unlabeled.length > 0) add("unlabeled_input", "medium", `${unlabeled.length} form input(s) without label.`);

  if (!/<link[^>]*rel\s*=\s*["']canonical["']/i.test(html)) add("missing_canonical", "low", "No canonical link.");
  if (/\s(src|href)\s*=\s*["']http:\/\//i.test(html)) add("mixed_content", "high", "Resources loaded over plain http://.");

  const words = stripTags(html).split(/\s+/).filter(Boolean).length;
  if (words < 300) add("thin_content", "low", `Only ${words} words of visible text.`);

  return findings;
}

const SAMPLE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><h2>Hello</h2><img src="a.png"><a href="#x">x</a></body></html>`;

export class WebsiteAuditService implements DigitalService {
  readonly category = "website_audit" as const;
  readonly usesInference = false;
  readonly capabilities: readonly string[];

  constructor(readonly version: number) {
    if (!WEBSITE_AUDIT_CHECKS[version]) throw new RangeError(`unknown website audit version ${version}`);
    this.capabilities = WEBSITE_AUDIT_CHECKS[version];
  }

  async execute(job: ServiceJob, _ctx: ServiceContext): Promise<ServiceOutput> {
    if (job.input.kind !== "website_audit") throw new Error("wrong input kind");
    const findings = auditHtml(job.input.html, this.version);
    return {
      category: this.category,
      version: this.version,
      findings,
      notes: [`${findings.length} finding(s) across ${this.capabilities.length} checks for ${job.input.url}`],
    };
  }

  async selfTest(): Promise<boolean> {
    const f = auditHtml(SAMPLE_PAGE, this.version).map((x) => x.code);
    return f.includes("missing_title") && f.includes("img_missing_alt") && f.includes("h1_count");
  }
}
