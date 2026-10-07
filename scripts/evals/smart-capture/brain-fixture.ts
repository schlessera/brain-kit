import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { descriptions, vocabulary } from "./pipeline";

/** Install the actual shipped /add skill and runtime module in a disposable brain. */
export function installBrainSurface(root: string, source: string) {
  mkdirSync(join(root, ".claude/skills/add"), { recursive: true });
  copyFileSync(join(source, "packages/core/skills/add/SKILL.md"), join(root, ".claude/skills/add/SKILL.md"));
  mkdirSync(join(root, "modules/study"), { recursive: true });
  writeFileSync(join(root, "modules/study/module.ts"), `import {defineModule} from ${JSON.stringify(join(source, "packages/core/src/index.ts"))};
import {z} from ${JSON.stringify(join(source, "node_modules/zod/index.js"))};
export default defineModule({name:"fixture-study",configSchema:z.strictObject({}),setup:()=>({taxonomy:{types:{study:{dir:"studies"}}}})});\n`);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({
    reranker: { enabled: false }, modules: { "./modules/study": {} },
    taxonomy: { types: { project: { dir: "projects/active", appendMatch: true }, ritual: { dir: "rituals" } } },
  }, null, 2));
  writeFileSync(join(root, "AGENTS.md"), `# Fictional capture brain\n\nThe reference date is 2026-07-12. Content belongs to the canonical Odysseus example world. The brain CLI is on PATH; use its current add skill and commands.\n\nCapture taxonomy descriptions supplied for this experiment (not new configuration fields):\n${Object.entries(descriptions).map(([type, description]) => `- ${type}: ${description}`).join("\n")}\n\nExisting tag vocabulary: ${vocabulary.join(", ")}.\n`);
  // The source and its worktree-owned dependencies are mounted read-only for
  // native tools; the fixture never installs or mutates them.
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "bin"), { recursive: true });
  const script = `#!/bin/sh\nexec ${shell(process.execPath)} --preload ${shell(join(source, "scripts/captures/clock.ts"))} ${shell(join(source, "packages/core/src/cli/brain.ts"))} "$@"\n`;
  writeFileSync(join(root, "bin/brain"), script); chmodSync(join(root, "bin/brain"), 0o755);
  return { root: resolve(root), bin: join(root, "bin") };
}
function shell(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
