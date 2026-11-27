/**
 * Launch qualification against host private state (#4301): the provider
 * registry, the typed refusal and the host-side qualification of a launched
 * sandbox's mount table while its start gate is closed. The verdict itself
 * is `evaluateNamespace` (`namespace-qualification.ts`).
 */
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, statSync, constants } from "node:fs";
import { resolve } from "node:path";
import { evaluateNamespace, holdsPath, namespaceComplete, parseMountinfo, resolveMount, type MountRow, type NamespaceExposure, type StateRootObservation } from "./namespace-qualification.js";
import { workerStepSleep, type WorkerSteps } from "./worker-steps.js";

/** What a launch refused for private state reports, at its top level. */
export type WorkerPrivateStateReason = "private_state_exposed" | "private_state_in_brain" | "database_in_brain" | "private_state_unverified";

/**
 * A launch refused before its payload started because host private state is
 * reachable in its namespace (`private_state_exposed`), or because the
 * fallback walk refused (its own reason). Not a `WorkerHostError`: it never
 * reads as an unavailable worker host and never selects strict.
 */
/** Shared by every loaded copy of this SDK in one process (#4301 F12). */
const REFUSAL_BRAND = Symbol.for("@schlessera/brain-ui-sdk/worker-private-state-refusal");
export class WorkerPrivateStateError extends Error {
  readonly errorClass: WorkerPrivateStateReason;
  readonly [REFUSAL_BRAND] = true;
  constructor(readonly reason: WorkerPrivateStateReason, message: string, readonly exposure?: NamespaceExposure) {
    super(message);
    this.name = "WorkerPrivateStateError";
    this.errorClass = reason;
  }
}

/**
 * The refusal carried by this error or by any error in its `cause` chain,
 * including one thrown by another loaded copy of this SDK.
 */
export function privateStateRefusalOf(error: unknown): WorkerPrivateStateError | undefined {
  for (let depth = 0, current = error; depth < 16 && current; depth++) {
    if (current instanceof WorkerPrivateStateError || (typeof current === "object" && (current as Record<symbol, unknown>)[REFUSAL_BRAND] === true))
      return current as WorkerPrivateStateError;
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

/**
 * Brain -> layout key -> providers with that layout. One registry per process,
 * whichever copy of this SDK a caller loaded (#4301 F12). Providers sharing a
 * key are one layout: it is judged once, and each is told the result.
 */
const REGISTRY = Symbol.for("@schlessera/brain-ui-sdk/worker-private-state-registry");
const providers: Map<string, Map<unknown, Set<WorkerPrivateStateProvider>>> =
  ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new Map()) as Map<string, Map<unknown, Set<WorkerPrivateStateProvider>>>;
const brainKey = (brain: string) => { try { return realpathSync(brain); } catch { return resolve(brain); } };

/**
 * Register the private-state layout of one brain; returns its disposer. A
 * `layout` key makes registrations of the same layout one entry, so repeated
 * boundaries add no work to later launches.
 */
export function registerWorkerPrivateState(brain: string, provider: WorkerPrivateStateProvider, layout: unknown = Symbol("layout")): () => void {
  const key = brainKey(brain);
  const layouts = providers.get(key) ?? new Map<unknown, Set<WorkerPrivateStateProvider>>();
  const set = layouts.get(layout) ?? new Set<WorkerPrivateStateProvider>();
  set.add(provider); layouts.set(layout, set); providers.set(key, layouts);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true; set.delete(provider);
    if (!set.size && layouts.get(layout) === set) layouts.delete(layout);
    if (!layouts.size && providers.get(key) === layouts) providers.delete(key);
  };
}

/** One provider per registered layout of a brain, if any registered. */
export function workerPrivateStateProviders(brain: string): readonly WorkerPrivateStateProvider[] {
  return [...providers.get(brainKey(brain))?.values() ?? []].flatMap(set => [...set].slice(0, 1));
}
/** Every registered provider of a brain: each is told what a launch saw. */
function workerPrivateStateReporters(brain: string): readonly WorkerPrivateStateProvider[] {
  return [...providers.get(brainKey(brain))?.values() ?? []].flatMap(set => [...set]);
}

/**
 * Host mounts strictly inside a directory state root that the host itself
 * reaches (`resolveMount` on its own table): a row stacked under another is
 * not what that path shows, so its coordinates never stand for the path
 * (#4301 F4).
 */
export function liveDescendantMounts(rows: readonly MountRow[], path: string): MountRow[] {
  return rows.filter(row => {
    if (row.point === path || !holdsPath(path, row.point)) return false;
    const reached = resolveMount(rows, row.point);
    return "row" in reached && reached.row.id === row.id;
  });
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
    for (const row of liveDescendantMounts(rows, path))
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
export function* qualifyWorkerNamespaceSteps(pid: number, brain: string, deadline: number): WorkerSteps<NamespaceQualification> {
  const registered = workerPrivateStateProviders(brain), reporters = workerPrivateStateReporters(brain);
  // No layout registered for this brain in this process (a backend or library
  // used on its own, whose masks are credential files): nothing to judge or
  // walk, so the launch runs unqualified, as before #4301.
  if (!registered.length) return { result: "unqualified" };
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
      for (const provider of reporters) report(provider, { kind: "refused", reason: "private_state_exposed", detail, exposure });
      throw new WorkerPrivateStateError("private_state_exposed", detail, exposure);
    }
    if (verdict.result === "ownership_only") {
      for (const provider of reporters) report(provider, { kind: "ownership_only", entries: verdict.entries });
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
      for (const each of reporters) report(each, { kind: "refused", ...refusal });
      throw new WorkerPrivateStateError(refusal.reason, refusal.detail);
    }
  }
  for (const provider of reporters) report(provider, { kind: "namespace_unverified", cause: cause! });
  return { result: "namespace_unverified" };
}
