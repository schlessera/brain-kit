import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * missing component, and the rest is taken as named. Undefined when the
 * links loop.
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
      if (!lstatSync(next).isSymbolicLink()) { current = next; continue; }
      link = readlinkSync(next);
    } catch { return resolve(next, ...pending); }
    if (++links > MAX_LINKS) return undefined;
    if (isAbsolute(link)) current = sep;
    pending.unshift(...link.split("/"));
  }
  return current;
}

const within = (path: string, folder: string) => path === folder || path.startsWith(folder === sep ? folder : `${folder}${sep}`);

/**
 * Whether a host writer must refuse a brain-relative target as protected by
 * the turn's admitted policy (#2876): the hosted application's rule,
 * extended to aliases. A target is protected when it, one of its ancestors or one of its
 * descendants is protected, compared both as named and where every link on
 * the way leads, so a link to a protected path and a protected path that is
 * itself a link both count; the `.env*` names are protected by prefix. Links
 * are read at each call, as close to the write as the caller can make it.
 */
export function createProtectedTargetCheck(root: string, protectedPaths: readonly string[]): (path: string) => boolean {
  const brain = realpathSync(root), admitted = [...protectedPaths];
  const both = (path: string) => [join(brain, path), landing(brain, path)].filter((place): place is string => place !== undefined);
  return path => {
    const targets = both(path);
    if (targets.some(target => {
      const inside = relative(brain, target);
      return within(target, brain) && isEnvName(inside.split(sep)[0]!);
    })) return true;
    const protectedPlaces = admitted.flatMap(both);
    return targets.some(target => protectedPlaces.some(place => within(target, place) || within(place, target)));
  };
}
