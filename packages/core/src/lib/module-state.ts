/**
 * The per-module state area (#3380): one gitignored directory per module,
 * inside the brain, where a module keeps small durable state between runs.
 *
 * A scheduled module job runs in a maintenance worker while the host execution
 * boundary holds. There, the host and every home directory are read-only and
 * `XDG_STATE_HOME` is a per-run temporary directory; the brain is the one
 * durable writable place, and what a run writes in it is published back
 * through output staging. So the state area lives in the brain, under the
 * same `.brain-ui/` the server's other non-canonical state uses, and carries
 * its own `.gitignore` so it never reaches the brain's history, whatever the
 * brain's root `.gitignore` says.
 *
 * Paths resolve against the brain root the CLI resolved (`BRAIN_ROOT`), which
 * inside a worker is the writable output stage, never the read-only startup
 * view the worker's working directory shows.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { join, relative } from "path";

/** The brain-relative parent of every module's state directory. */
export const MODULE_STATE_DIR = ".brain-ui/modules";

/** The `.gitignore` written into {@link MODULE_STATE_DIR}: everything below it, itself included. */
export const MODULE_STATE_GITIGNORE = "# Module state (brain-kit): never committed.\n*\n";

/** The module names the loader and the crontab accept, so a state path never needs escaping. */
const MODULE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The state area is missing its protections: a link redirects it, or the name cannot be a directory. */
export class ModuleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleStateError";
  }
}

/** The brain-relative state directory of one module, without touching the disk. */
export function moduleStatePath(moduleName: string): string {
  if (!MODULE_NAME.test(moduleName)) {
    throw new ModuleStateError(`module name ${JSON.stringify(moduleName)} cannot name a state directory: use kebab-case, max 64 chars`);
  }
  return `${MODULE_STATE_DIR}/${moduleName}`;
}

/**
 * The absolute state directory of one module under `root`, created on first
 * use with the area's own `.gitignore`. Refuses a symlink anywhere on the way
 * (`.brain-ui`, `.brain-ui/modules`, the module's directory), so state never
 * lands outside the brain or somewhere publication would not carry it.
 */
export function moduleStateDir(root: string, moduleName: string): string {
  const rel = moduleStatePath(moduleName);
  const rootReal = realpathSync(root);
  let current = rootReal;
  for (const part of rel.split("/")) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new ModuleStateError(`${relative(rootReal, current)} is a symlink, so module state is not written through it`);
    if (info && !info.isDirectory()) throw new ModuleStateError(`${relative(rootReal, current)} exists and is not a directory`);
    if (!info) mkdirSync(current, { mode: 0o700 });
    if (realpathSync(current) !== current) throw new ModuleStateError(`${relative(rootReal, current)} does not resolve to itself`);
    if (current === join(rootReal, MODULE_STATE_DIR)) {
      const ignore = join(current, ".gitignore");
      if (lstatSync(ignore, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ModuleStateError(`${MODULE_STATE_DIR}/.gitignore is a symlink`);
      if (!existsSync(ignore)) writeFileSync(ignore, MODULE_STATE_GITIGNORE, { mode: 0o644, flag: "wx" });
    }
  }
  return current;
}

/**
 * Whether an error is a write refused by a read-only file system. Inside a
 * maintenance worker that is the host execution boundary, not a fault.
 */
export function isReadOnlyFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EROFS");
}

/**
 * The message for a write a module command made to a read-only path. Inside
 * a maintenance worker (`BRAIN_WORKER_DATA_ROOT` set) it names the boundary
 * and the state area; elsewhere it still names the path and the area.
 */
export function readOnlyBoundaryMessage(input: { moduleName: string; command: string; path?: string; worker: boolean }): string {
  const target = input.path ? `${input.path} is read-only` : "a read-only path";
  const state = `${MODULE_STATE_DIR}/${input.moduleName}/ (CommandContext.stateDir())`;
  return input.worker
    ? `brain ${input.command}: ${target}. Module "${input.moduleName}" runs in a maintenance worker (the host execution boundary): ` +
      `the host, home directories and XDG state are read-only or per-run, and only the brain is writable and kept. ` +
      `Keep durable module state in ${state}.`
    : `brain ${input.command}: ${target}. Keep durable module state in ${state}.`;
}
