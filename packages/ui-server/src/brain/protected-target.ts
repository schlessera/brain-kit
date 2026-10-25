import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isEnvName } from "@schlessera/brain-common/internal/protected-paths";

/** The refusal every host writer gives for a target in the turn's admitted protection set. */
export const PROTECTED_TARGET_REFUSAL = "This target is protected by the policy admitted for this turn; no change was applied.";

/** A host writer's refusal of a protected target (#2876), with the code an application result carries. */
export class ProtectedTargetRefusedError extends Error {
  readonly code = "policy_denied";
  constructor() { super(PROTECTED_TARGET_REFUSAL); this.name = "ProtectedTargetRefusedError"; }
}

/** Links followed before a path counts as looping, as the kernel's own bound. */
const MAX_LINKS = 40;

/**
 * Where a brain-relative path lands once every link on the way is followed:
 * what a writer that follows links changes. The walk ends at the first
 * missing component, and the rest is taken as named. Undefined where no
 * writer could land: links that loop, a component below a file, or `..`
 * after a missing component.
 */
function landing(root: string, path: string): string | undefined {
  const pending = path.split("/");
  let current = root, links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = join(current, part);
    let link: string;
    try {
      const info = lstatSync(next);
      if (!info.isSymbolicLink()) {
        if (!info.isDirectory() && pending.some(rest => rest && rest !== ".")) return undefined;
        current = next; continue;
      }
      link = readlinkSync(next);
    } catch { return pending.includes("..") ? undefined : join(next, ...pending); }
    if (++links > MAX_LINKS) return undefined;
    if (isAbsolute(link)) current = sep;
    pending.unshift(...link.split("/"));
  }
  return current;
}

const within = (path: string, folder: string) => path === folder || path.startsWith(folder === sep ? folder : `${folder}${sep}`);

/** A brain-relative path as named, and where its links lead when that differs. */
function places(brain: string, path: string): string[] {
  const named = join(brain, path), landed = landing(brain, path);
  return landed === undefined || landed === named ? [named] : [named, landed];
}

/**
 * Every absolute place the admitted protection covers now: each protected
 * path as named and where its links lead, and the same for each `.env*` name
 * at the brain root, which is protected by prefix rather than listed.
 */
export function protectedPlaces(root: string, protectedPaths: readonly string[]): string[] {
  const brain = realpathSync(root);
  let env: string[] = [];
  try { env = readdirSync(brain).filter(isEnvName); } catch { /* An unreadable root lists no names. */ }
  return [...protectedPaths, ...env].flatMap(path => places(brain, path));
}

/**
 * Whether a host writer must refuse a brain-relative target as protected by
 * the turn's admitted policy (#2876): the hosted application's rule,
 * extended to aliases. A target is protected when it, one of its ancestors or
 * one of its descendants is protected, compared both as named and where every
 * link on the way leads, so a link to a protected path and a protected path
 * that is itself a link both count; the `.env*` names are protected by
 * prefix, including one a target would create. Links are read at each call,
 * as close to the write as the caller can make it.
 */
export function createProtectedTargetCheck(root: string, protectedPaths: readonly string[]): (path: string) => boolean {
  const brain = realpathSync(root), admitted = [...protectedPaths];
  return path => {
    const targets = places(brain, path);
    if (targets.some(target => within(target, brain) && isEnvName(relative(brain, target).split(sep)[0]!))) return true;
    const covered = protectedPlaces(brain, admitted);
    return targets.some(target => covered.some(place => within(target, place) || within(place, target)));
  };
}
