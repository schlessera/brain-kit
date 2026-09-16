// Build-time registration of tool-renderer packs. A contributor adds one
// import line + registerToolRenderers call here (React.lazy for heavy packs).
// Runtime plugin loading into the compiled PWA is deliberately not supported.

import { registerToolRenderers } from "@schlessera/brain-ui-sdk/client";
import { claudeToolPack } from "./claude-tools.js";
import { piToolPack } from "./pi-tools.js";
import { genericToolPack, GENERIC_RENDERER } from "./generic.js";

/**
 * Register the built-in packs (idempotent).
 *
 * Idempotence belongs to the REGISTRY, which dedupes by pack identity, not to
 * a module-level `registered` latch here: a latch survives
 * `resetToolRenderers()`, so the first reset anywhere — one story, one test —
 * permanently un-registered the builtins for everything that ran after it.
 */
export function registerBuiltinRenderers(): void {
  registerToolRenderers(claudeToolPack);
  registerToolRenderers(piToolPack);
  registerToolRenderers(genericToolPack);
}

export { GENERIC_RENDERER };
