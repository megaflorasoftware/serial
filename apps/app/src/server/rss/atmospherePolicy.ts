import { MAX_EMBEDDED_RECORDS_PER_DOCUMENT } from "@serial/standard-site";

export const ATMOSPHERE_INITIAL_ITEMS = 200;
export const ATMOSPHERE_PAGES_PER_REFRESH = 10;
export const ATMOSPHERE_DOCUMENT_CONCURRENCY = 4;
export const ATMOSPHERE_DOCUMENTS_PER_REFRESH = 200;
// Enough for all active conversions to finish at least one document, so retry
// batches containing only documents with sixteen references cannot starve.
export const ATMOSPHERE_EMBEDDED_RECORDS_PER_REFRESH =
  ATMOSPHERE_DOCUMENT_CONCURRENCY * MAX_EMBEDDED_RECORDS_PER_DOCUMENT;
