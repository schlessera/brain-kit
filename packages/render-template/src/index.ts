export { buildHtmlDocument, DEFAULT_TITLE, documentTitle, isFullDocument } from "./template.js";
export type { BuildHtmlDocumentOptions, RenderContentType } from "./template.js";
export { ACCENTS, DOCUMENT_BLOCKS, DOCUMENT_CLASSES, OPENER_CLASSES, SWITCH_CLASSES } from "./components.js";
export type { Accent, DocumentBlock } from "./components.js";
export { lintDocument } from "./lint.js";
export type { DocumentWarning } from "./lint.js";
export { applyExportLinkPolicy, protectExportLinkDestinations } from "./link-policy.js";
export type { ExportLinkPolicy } from "./link-policy.js";
