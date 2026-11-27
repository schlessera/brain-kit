/**
 * Launch qualification against host private state (#4301): the provider
 * registry, the typed refusal and the host-side qualification of a launched
 * sandbox's mount table while its start gate is closed. The verdict itself
 * is `evaluateNamespace` (`namespace-qualification.ts`).
 */
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, statSync, constants } from "node:fs";
import { resolve } from "node:path";
import { evaluateNamespace, holdsPath, namespaceComplete, parseMountinfo, type MountRow, type NamespaceExposure, type StateRootObservation } from "./namespace-qualification.js";
import { workerStepSleep, type WorkerSteps } from "./worker-steps.js";

/** What a launch refused for private state reports, at its top level. */
export type WorkerPrivateStateReason = "private_state_exposed" | "private_state_in_brain" | "database_in_brain" | "private_state_unverified";

/**
 * A launch refused before its payload started because host private state is
 * reachable in its namespace (`private_state_exposed`), or because the
 * fallback walk refused (its own reason). Not a `WorkerHostError`: it never
 * reads as an unavailable worker host and never selects strict.
 */
export class WorkerPrivateStateError extends Error {
  readonly errorClass: WorkerPrivateStateReason;
  constructor(readonly reason: WorkerPrivateStateReason, message: string, readonly exposure?: NamespaceExposure) {
    super(message);
    this.name = "WorkerPrivateStateError";
    this.errorClass = reason;
  }
}

/** The refusal carried by this error or by any error in its `cause` chain. */
export function privateStateRefusalOf(error: unknown): WorkerPrivateStateError | undefined {
  for (let depth = 0, current = error; depth < 16 && current; depth++) {
    if (current instanceof WorkerPrivateStateError) return current;
    current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

/** One observation a provider is told about; diagnostics only, never a verdict another launch reads. */
export type WorkerPrivateStateEvent =
  | { kind: "refused"; reason: WorkerPrivateStateReason; detail: string; exposure?: NamespaceExposure }
  | { kind: "ownership_only"; entries: NamespaceExposure[] }
  | { kind: "namespace_unverified"; cause: string };

/** The host's private-state layout for one brain, from the builder that produces `privateStatePaths`. */
export interface WorkerPrivateStateProvider {
  /** Current state roots, resolved per launch. A root that does not exist yet is not judged. */
  roots(): readonly { setting: string; path: string }[];
  /** Today's alias walk; its refusal, or `undefined` when it passes. */
  walk(): { reason: Exclude<WorkerPrivateStateReason, "private_state_exposed">; detail: string } | undefined;
  /** Diagnostics; a failure here never changes the launch's result. */
  report?(event: WorkerPrivateStateEvent): void;
}

const providers = new Map<string, Set<WorkerPrivateStateProvider>>();
const brainKey = (brain: string) => { try { return realpathSync(brain); } catch { return resolve(brain); } };

/** Register the private-state layout of one brain; returns its disposer. */
export function registerWorkerPrivateState(brain: string, provider: WorkerPrivateStateProvider): () => void {
  const key = brainKey(brain);
  const set = providers.get(key) ?? new Set();
  set.add(provider); providers.set(key, set);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true; set.delete(provider);
    if (!set.size && providers.get(key) === set) providers.delete(key);
  };
}

/** The providers of a brain, if any registered. */
export function workerPrivateStateProviders(brain: string): readonly WorkerPrivateStateProvider[] {
  return [...providers.get(brainKey(brain)) ?? []];
}

const O_PATH = 0o10000000;
/** The host's mount table row the kernel resolved an open of `path` into. */
function hostRow(path: string, rows: readonly MountRow[]): MountRow {
  const fd = openSync(path, O_PATH | constants.O_NOFOLLOW);
  try {
    const id = Number(/^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1]);
    const row = rows.find(candidate => candidate.id === id);
    if (!row) throw new Error(`the host mount of ${path} is not in its mount table`);
    return row;
  } finally { closeSync(fd); }
}
/** Backing coordinates of a canonical host path inside the host row it resolves into. */
function coordinates(path: string, row: MountRow): { sb: string; fspath: string } {
  const rest = path === row.point ? "" : row.point === "/" ? path : path.slice(row.point.length);
  return { sb: row.sb, fspath: row.root === "/" ? (rest || "/") : `${row.root}${rest}` };
}

/**
 * The existing roots in backing coordinates, plus every host mount strictly
 * inside a directory root, each a further root in its own coordinates. An
 * absent root is skipped. Any other failure throws: the caller treats it as
 * unknown.
 */
export function observeStateRoots(roots: readonly { setting: string; path: string }[]): StateRootObservation[] {
  const rows = parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8"));
  if (!rows) throw new Error("the host mount table is empty");
  const observed: StateRootObservation[] = [];
  for (const root of roots) {
    let path: string;
    try { path = realpathSync(root.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    observed.push({ setting: root.setting, path, ...coordinates(path, hostRow(path, rows)) });
    if (!lstatSync(path).isDirectory()) continue;
    for (const row of rows) if (row.point !== path && holdsPath(path, row.point))
      observed.push({ setting: root.setting, path: row.point, sb: row.sb, fspath: row.root });
  }
  return observed;
}

/** Real, effective, saved and filesystem UIDs of a process, as the host sees them. */
function processUids(pid: number): number[] {
  const line = /^Uid:\s+(.+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
  const uids = line?.trim().split(/\s+/).map(Number) ?? [];
  if (uids.length !== 4 || uids.some(uid => !Number.isSafeInteger(uid))) throw new Error("the sandbox's UIDs could not be read");
  return uids;
}

const UNDECLARED = "private state was declared for a brain with no registered private-state provider; nothing can qualify this launch";
/** Refuse before spawning a launch that names private paths for a brain nothing can qualify. */
export function requirePrivateStateProvider(brain: string, declared: boolean): void {
  if (declared && !workerPrivateStateProviders(brain).length) throw new Error(UNDECLARED);
}

/** How a launch's namespace qualified. `unqualified`: no provider for this brain. */
export type NamespaceQualification =
  | { result: "unqualified" }
  | { result: "hidden" | "ownership_only" | "namespace_unverified" };

const report = (provider: WorkerPrivateStateProvider, event: WorkerPrivateStateEvent) => {
  try { provider.report?.(event); } catch { /* Diagnostics never change the launch's result. */ }
};

/**
 * Qualify one held sandbox before its payload starts: observe its mount table
 * until it is complete (the seal and one row at `/`), then judge every
 * existing state root of the brain's providers. An exposure throws
 * `WorkerPrivateStateError`; the caller kills the sandbox. An unreadable,
 * incomplete or ambiguous table is unknown: the providers' walk runs now, and
 * its refusal throws with the walk's reason while a pass releases. The walk's
 * time is not counted against `deadline`, which bounds the observation only.
 */
export function* qualifyWorkerNamespaceSteps(pid: number, brain: string, deadline: number, declared: boolean): WorkerSteps<NamespaceQualification> {
  const registered = workerPrivateStateProviders(brain);
  if (!registered.length) {
    if (declared) throw new Error(UNDECLARED);
    return { result: "unqualified" };
  }
  let cause: string | undefined;
  try {
    const roots = observeStateRoots(registered.flatMap(provider => provider.roots()));
    let rows: MountRow[] | undefined;
    for (;;) {
      rows = parseMountinfo(readFileSync(`/proc/${pid}/mountinfo`, "utf8"));
      if (rows && namespaceComplete(rows)) break;
      if (Date.now() >= deadline) throw new Error(rows ? "the sandbox's mount table was not complete in time" : "the sandbox's mount table stayed empty");
      yield* workerStepSleep(1);
    }
    const verdict = evaluateNamespace(rows, roots, processUids(pid), {
      owner: path => { try { const info = statSync(path); return { uid: info.uid, mode: info.mode }; } catch { return undefined; } },
      layer: path => {
        try {
          const real = realpathSync(path), host = parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8"));
          return host ? coordinates(real, hostRow(real, host)) : undefined;
        } catch { return undefined; }
      },
    });
    if (verdict.result === "exposed") {
      const { result: _result, ...exposure } = verdict;
      const detail = `WorkerPrivateStateError: ${exposure.setting} is reachable in the worker's namespace at ${exposure.name} (mount ${exposure.row}); remove or mask that mount or alias, or make the state owner-only for a separate worker identity. The next launch is checked again.`;
      for (const provider of registered) report(provider, { kind: "refused", reason: "private_state_exposed", detail, exposure });
      throw new WorkerPrivateStateError("private_state_exposed", detail, exposure);
    }
    if (verdict.result === "ownership_only") {
      for (const provider of registered) report(provider, { kind: "ownership_only", entries: verdict.entries });
      return { result: "ownership_only" };
    }
    if (verdict.result === "hidden") return { result: "hidden" };
    cause = verdict.cause;
  } catch (error) {
    if (error instanceof WorkerPrivateStateError) throw error;
    cause = error instanceof Error ? error.message : String(error);
  }
  // Unknown never refuses by itself and never releases on boundary evidence alone.
  for (const provider of registered) {
    const refusal = provider.walk();
    if (refusal) {
      for (const each of registered) report(each, { kind: "refused", ...refusal });
      throw new WorkerPrivateStateError(refusal.reason, refusal.detail);
    }
  }
  for (const provider of registered) report(provider, { kind: "namespace_unverified", cause: cause! });
  return { result: "namespace_unverified" };
}
