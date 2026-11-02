/**
 * Where external compute keeps its durable state: job records, intents,
 * leases, reservations and artifacts. Never the brain checkout and never
 * brain.db; `brain index --force` neither reads nor rebuilds it
 * (docs/decisions/external-compute.md, "State").
 *
 * Standalone, it defaults to a per-brain directory under the user's state
 * home. A host passes its own operational directory. It is not a
 * brain.config key: the brain is agent-editable, and an agent must not be able
 * to point job records into the content it can read or commit.
 */

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveEnv } from "../../config/env.js";

/** A host misconfiguration of the state directory. Not a refusal: nothing can be admitted. */
export class ComputeStateError extends Error {
  override name = "ComputeStateError";
}

/** The brain's identity in compute state: a hash of its canonical root. */
export function computeBrainKey(root: string): string {
  return createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve, create (mode 0700) and canonicalise the state directory. An
 * explicit `override` wins, then BRAIN_COMPUTE_STATE_DIR, then
 * `$XDG_STATE_HOME/brain/compute/<brain key>`. A relative path, or one inside
 * the brain checkout, is refused.
 */
export function resolveComputeStateDir(opts: { root: string; override?: string; env?: NodeJS.ProcessEnv }): string {
  const env = resolveEnv(opts.env);
  const configured = opts.override ?? env.computeStateDir;
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new ComputeStateError(`the compute state directory must be absolute: ${configured}`);
  }
  const root = realpathSync(opts.root);
  const dir = configured ?? join(env.stateHome, "brain", "compute", computeBrainKey(root));
  if (!isAbsolute(dir)) throw new ComputeStateError(`the compute state directory must be absolute: ${dir}`);
  // Refuse before creating anything: resolve the deepest existing ancestor,
  // which may be a link into the checkout, and check where the rest would land.
  const refuseInside = (path: string) => {
    if (inside(root, path)) {
      throw new ComputeStateError(`the compute state directory ${path} is inside the brain checkout; it must live outside it`);
    }
  };
  refuseInside(prospectivePath(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(dir);
  refuseInside(canonical);
  return canonical;
}

/** Where `dir` would resolve once created: its deepest existing ancestor's real path plus the rest. */
function prospectivePath(dir: string): string {
  const missing: string[] = [];
  let current = resolve(dir);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(dir);
      missing.push(basename(current));
      current = parent;
    }
  }
}
