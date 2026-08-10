// Build-time registration of tool-renderer packs. A contributor adds one
// import line + registerToolRenderers call here (React.lazy for heavy packs).
// Runtime plugin loading into the compiled PWA is deliberately not supported.

import { registerToolRenderers } from "@schlessera/brain-ui-sdk/client";
import { claudeToolPack } from "./claude-tools.js";
import { genericToolPack, GENERIC_RENDERER } from "./generic.js";

let registered = false;

/** Register the built-in packs once (idempotent). */
export function registerBuiltinRenderers(): void {
  if (registered) return;
  registered = true;
  registerToolRenderers(claudeToolPack);
  registerToolRenderers(genericToolPack);
}

export { GENERIC_RENDERER };
