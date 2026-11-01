import type { ProductCategory } from "../core/types.js";
import type { DigitalService } from "./types.js";
import { WebsiteAuditService } from "./website-audit.js";
import { CsvCleanerService } from "./csv-cleaner.js";
import { TextDigestService } from "./text-digest.js";

export const MAX_SERVICE_VERSION = 3;

export interface ProductTemplate {
  category: ProductCategory;
  name: string;
  description: string;
  /** Does fulfilment need model calls (affects per-order cost)? */
  fulfilmentUsesInference: boolean;
}

export const PRODUCT_TEMPLATES: Readonly<Record<ProductCategory, ProductTemplate>> = Object.freeze({
  website_audit: {
    category: "website_audit",
    name: "Website Audit Report",
    description: "Automated on-page SEO and accessibility audit of a web page",
    fulfilmentUsesInference: false,
  },
  data_cleaning: {
    category: "data_cleaning",
    name: "CSV Data Cleaning",
    description: "Cleans and normalises messy CSV files",
    fulfilmentUsesInference: false,
  },
  text_digest: {
    category: "text_digest",
    name: "Research Digest",
    description: "Condenses long documents into a short factual digest",
    fulfilmentUsesInference: true,
  },
});

export function createService(category: ProductCategory, version: number): DigitalService {
  switch (category) {
    case "website_audit":
      return new WebsiteAuditService(version);
    case "data_cleaning":
      return new CsvCleanerService(version);
    case "text_digest":
      return new TextDigestService(version);
  }
}
