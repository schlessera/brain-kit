/**
 * Skills distribution layer: discover skills from three layers, materialize the
 * canonical `.agents/skills/` home, run per-agent emitters, and lint.
 */

export {
  discoverSkills,
  type DiscoverOptions,
  type DiscoveryResult,
  type SkillSources,
} from "./discover.js";
export {
  syncSkills,
  installBinLinks,
  type SyncOptions,
  type SyncResult,
  type BinLinkResult,
} from "./sync.js";
export { lintSkills, type LintFinding, type LintSeverity } from "./lint.js";

export { claudeEmitter } from "./emitters/claude.js";
export { codexEmitter } from "./emitters/codex.js";
export { geminiEmitter } from "./emitters/gemini.js";
export { piEmitter } from "./emitters/pi.js";
export {
  INDEX_START,
  INDEX_END,
  renderIndexBlock,
  readManagedNames,
  upsertIndexBlock,
} from "./emitters/index-block.js";

import { claudeEmitter } from "./emitters/claude.js";
import { codexEmitter } from "./emitters/codex.js";
import { geminiEmitter } from "./emitters/gemini.js";
import { piEmitter } from "./emitters/pi.js";
import type { SkillEmitter } from "../seams.js";

/** All built-in emitters. syncSkills defaults to [claudeEmitter]; the others are opt-in. */
export const BUILTIN_EMITTERS: Record<string, SkillEmitter> = {
  claude: claudeEmitter,
  codex: codexEmitter,
  gemini: geminiEmitter,
  pi: piEmitter,
};
