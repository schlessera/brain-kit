/** Hosted operational state never belongs in the agent-writable brain (#1649). */
import { lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GovernedUnavailableReason } from "@schlessera/brain-ui-sdk/protocol";

/** Follow filesystem components in order: link/.. must traverse the link first. */
function canonical(path: string, links = 0): string {
  if (links > 40) throw new Error("Operational state path has too many symbolic links");
  const parts = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split("/");
  let current = "/";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part || part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    let info;
    try { info = lstatSync(next); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (info?.isSymbolicLink()) {
      const target = readlinkSync(next);
      // Keep both the target and remaining components unnormalized. This
      // also handles dangling links selecting a not-yet-created database.
      return canonical(`${isAbsolute(target) ? target : `${current}/${target}`}/${parts.slice(i + 1).join("/")}`, links + 1);
    }
    current = next;
  }
  return current;
}
const within = (root: string, path: string) => root === "/" || path === root || path.startsWith(`${root}/`);
export interface OperationalStateLayout {
  brainPath: string;
  dbPath?: string;
  privateStatePaths?: readonly { setting: string; path: string }[];
}
export interface OperationalStateRefusal {
  available: false;
  reason: GovernedUnavailableReason;
  detail: string;
}

/** The boot check and status surface share the exact resolution and migration guidance. */
export function operationalStateRefusal(input: OperationalStateLayout): OperationalStateRefusal | undefined {
  const brain = canonical(input.brainPath);
  const paths = [...(input.dbPath && input.dbPath !== ":memory:" ? [{ setting: "DB_PATH", path: input.dbPath }] : []),
    ...(input.dbPath === ":memory:" ? [{ setting: "TMPDIR", path: `${tmpdir()}/brain-ui-quarantine` }] : []),
    ...(input.dbPath !== undefined && input.dbPath !== ":memory:" ? [{ setting: "DB_PATH quarantine", path: join(dirname(resolve(input.dbPath)), "brain-ui-quarantine") }] : []),
    ...(input.privateStatePaths ?? [])];
  for (const { setting, path } of paths) {
    // Both the state file and its directory matter: sibling WAL/quarantine data
    // share that directory, while a file itself can be a link into the brain.
    if (within(brain, canonical(path)) || within(brain, canonical(dirname(path)))) {
      return { available: false, reason: setting === "DB_PATH" ? "database_in_brain" : "private_state_in_brain",
        detail: `OperationalStateInBrainError: ${setting} resolves inside the brain; stop the server, move the state directory outside the brain (including database WAL/SHM and quarantine siblings), point ${setting === "DB_PATH quarantine" ? "DB_PATH" : setting} at the moved path, then restart. Do not remove the worker masks.` };
    }
  }
}

/** Refuse before opening state, reconciling manifests or evaluating any brain code. */
export function assertOperationalStateOutsideBrain(input: OperationalStateLayout): void {
  const refusal = operationalStateRefusal(input);
  if (!refusal) return;
  const error = new Error(refusal.detail);
  error.name = "OperationalStateInBrainError";
  // An embedder can show the same diagnostic even though a refused app has no HTTP listener.
  throw Object.assign(error, { status: refusal });
}
