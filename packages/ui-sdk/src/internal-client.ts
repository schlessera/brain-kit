/**
 * Browser-safe first-party implementation sharing (ui-react). Not a
 * supported API: no compatibility guarantee, and consumers must use the same
 * lockstep version. Unlike ./internal it imports no Node built-in.
 * See docs/decisions/public-export-boundary.md.
 */
export { defaultAsrClientRegistry, speechUiHints } from "./client/asr.js";
export { createToolRendererRegistry, defaultToolRendererRegistry } from "./client/renderers.js";
export { canonicalModelId, describeRetry, resolveThinkingLevel } from "./protocol-helpers.js";
export { pruneStoredShares } from "./client/share-store.js";
export { handleShareTargetRequest, isShareTargetRequest, type ShareTargetError } from "./client/share-target-handler.js";
export { askUserFormPayload, askUserFormSpec, resolveAskUserFormLimits } from "./tool-contracts/form.js";
