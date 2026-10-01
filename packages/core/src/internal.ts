/**
 * First-party native-handle implementation helpers, not supported query APIs.
 * No compatibility guarantee; consumers must use the same lockstep version.
 * Public export removal is tracked separately in #534. Content-index reads
 * use @schlessera/brain/queries instead of this entry.
 */
export { archiveDocument } from "./lib/archiver.js";
export { assembleContext } from "./lib/context-assembler.js";
export { loadVecSupport, openDatabase } from "./lib/db.js";
export { indexAll } from "./lib/indexer.js";
export { ingest } from "./lib/ingestion.js";
export { hybridSearch } from "./lib/search-engine.js";
