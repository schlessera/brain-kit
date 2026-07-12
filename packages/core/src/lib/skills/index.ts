/**
 * Skills distribution layer: discover skills from three layers, materialize the
 * canonical `.agents/skills/` home, run per-agent emitters, and lint.
 */

export {
  discoverSkills,
  type DiscoverOptions,
  type DiscoveryResult,
  type SkillSources,
} from "./discover";
export {
  syncSkills,
  installBinLinks,
  type SyncOptions,
  type SyncResult,
  type BinLinkResult,
} from "./sync";
export { lintSkills, type LintFinding, type LintSeverity } from "./lint";

export { claudeEmitter } from "./emitters/claude";
export { codexEmitter } from "./emitters/codex";
export { geminiEmitter } from "./emitters/gemini";
export {
  INDEX_START,
  INDEX_END,
  renderIndexBlock,
  readManagedNames,
  upsertIndexBlock,
} from "./emitters/index-block";

import { claudeEmitter } from "./emitters/claude";
import { codexEmitter } from "./emitters/codex";
import { geminiEmitter } from "./emitters/gemini";
import type { SkillEmitter } from "../seams";

/** All built-in emitters. syncSkills defaults to [claudeEmitter]; the others are opt-in. */
export const BUILTIN_EMITTERS: Record<string, SkillEmitter> = {
  claude: claudeEmitter,
  codex: codexEmitter,
  gemini: geminiEmitter,
};
