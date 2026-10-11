/** Core skill provenance follows installed paths, never package version equality. */
import { readFileSync, realpathSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { packageRoot } from "../../package-version.js";

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function corePackage(dir: string): boolean {
  try {
    if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "@schlessera/brain") return false;
    const skills = join(dir, "skills");
    if (!statSync(skills).isDirectory()) return false;
    readdirSync(skills); // An unreadable install must not look like an empty skill set.
    return true;
  } catch {
    return false;
  }
}

/** Keep the lexical node_modules path so even symlinked installs get relative links. */
export function selectCoreSkills(root: string, override?: string): { dir?: string; warning?: string } {
  if (override !== undefined) return { dir: override };
  const local = resolve(root, "node_modules/@schlessera/brain");
  if (corePackage(local)) return { dir: join(local, "skills") };
  const running = realpathSync(packageRoot());
  // A source checkout can run its own package without installing it in node_modules.
  if (inside(running, realpathSync(root)) && corePackage(running)) return { dir: join(running, "skills") };
  return {
    warning: `Skills sync refused: no usable @schlessera/brain installation at ${local}; running CLI installation is ${running}. Run \`bun install\` in ${resolve(root)} and retry. No skills were linked, pruned or emitted.`,
  };
}

/** Only core-package targets count; absolute module links are legitimate. */
export function foreignCoreSkill(root: string, target: string): boolean {
  const realTarget = realpathSync(target);
  let dir = realTarget;
  while (dirname(dir) !== dir) {
    if (corePackage(dir)) {
      if (!inside(realTarget, join(dir, "skills"))) return false;
      const selected = selectCoreSkills(root).dir;
      return selected === undefined || !inside(realTarget, realpathSync(selected));
    }
    dir = dirname(dir);
  }
  return false;
}
