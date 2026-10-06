/**
 * First-party implementation sharing for brain-kit packages. Not a supported
 * API: no compatibility guarantee, and consumers must use the same lockstep
 * version. See docs/decisions/public-export-boundary.md.
 */
export { applyExportLinkPolicy, protectExportLinkDestinations } from "./link-policy.js";
export { documentTitle, isFullDocument } from "./template.js";
