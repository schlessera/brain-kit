// Build-time registration of tool-renderer packs. A contributor adds one
// import line + registerToolRenderers call here (React.lazy for heavy packs).
// Runtime plugin loading into the compiled PWA is deliberately not supported.

import { defaultToolRendererRegistry, type ToolRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { claudeToolPack } from "./claude-tools.js";
import { piToolPack } from "./pi-tools.js";
import { genericToolPack, GENERIC_RENDERER } from "./generic.js";
import { brainUiToolPack } from "./brain-ui-tools.js";

/**
 * Register the built-in packs (idempotent).
 *
 * Idempotence belongs to the REGISTRY, which dedupes by pack identity, not to
 * a module-level `registered` latch here: a latch survives
 * `resetToolRenderers()`, so the first reset anywhere — one story, one test —
 * permanently un-registered the builtins for everything that ran after it.
 */
export function registerBuiltinRenderers(registry: ToolRendererRegistry = defaultToolRendererRegistry): void {
  registry.register(brainUiToolPack);
  registry.register(claudeToolPack);
  registry.register(piToolPack);
  registry.register(genericToolPack);
}

export { GENERIC_RENDERER };
