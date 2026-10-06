/**
 * Browser-safe first-party implementation sharing (ui-react). Not a
 * supported API: no compatibility guarantee, and consumers must use the same
 * lockstep version. Unlike ./internal it imports no Node built-in.
 * See docs/decisions/public-export-boundary.md.
 */
export { defaultAsrClientRegistry, speechUiHints } from "./client/asr.js";
export { defaultToolRendererRegistry } from "./client/renderers.js";
export { askUserFormPayload, askUserFormSpec, resolveAskUserFormLimits } from "./tool-contracts/form.js";
