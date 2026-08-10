import type { BrainContext } from "../lib/context.js";
import type { SkillEmitter } from "../lib/seams.js";
import { BUILTIN_EMITTERS, claudeEmitter } from "../lib/skills/index.js";

/**
 * Resolve the skill emitters to run: the claude emitter always, plus any named
 * in `config.skills.emitters` (deduped). Unknown names become warnings rather
 * than hard failures so a config typo doesn't block a sync.
 */
export function resolveEmitters(brain: BrainContext): {
  emitters: SkillEmitter[];
  warnings: string[];
} {
  const emitters: SkillEmitter[] = [claudeEmitter];
  const seen = new Set(["claude"]);
  const warnings: string[] = [];

  for (const name of brain.config?.skills?.emitters ?? []) {
    if (seen.has(name)) continue;
    const emitter = BUILTIN_EMITTERS[name];
    if (!emitter) {
      warnings.push(`unknown skill emitter "${name}"`);
      continue;
    }
    emitters.push(emitter);
    seen.add(name);
  }

  return { emitters, warnings };
}
