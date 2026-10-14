/**
 * One brain's host execution boundary, wired to the UI database (#1648): the
 * boundary itself, the writer gate and the durable governed-turn manifests.
 * The server builds one at boot; the cron runner builds one per job. Both
 * reconcile turns a dead server left behind before anything evaluates the
 * brain.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import type { ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import type { WorkerHostProbe, WorkerStateLimits } from "@schlessera/brain-ui-sdk/internal";
import { assertOperationalStateOutsideBrain, type OperationalStateLayout } from "./operational-state.js";
import { createUiDb } from "../db/client.js";
import { createHostBoundary, type HostBoundary } from "./host-boundary.js";
import { assertReconciled, createGovernedManifests, type GovernedManifests, type Reconciliation } from "./governed-manifest.js";
import { createWriterGate, type WriterGate } from "./writer-gate.js";

/**
 * Where quarantined files go: a host-private directory beside the UI
 * database, masked from every maintenance worker with the database itself.
 * An in-memory database gets a private temporary directory.
 */
export function quarantineDirFor(dbPath: string): string {
  if (dbPath === ":memory:") return mkdtempSync(join(tmpdir(), "brain-ui-quarantine-"));
  return join(dirname(resolve(dbPath)), "brain-ui-quarantine");
}

/**
 * `task` run once at a time: a call while it runs schedules exactly one more
 * run after it, however many calls arrive meanwhile. `idle()` settles once no
 * run is pending.
 */
export function coalesced(task: () => Promise<unknown>, onError: (error: unknown) => void): (() => void) & { idle(): Promise<void> } {
  let current: Promise<void> | null = null;
  let again = false;
  const run = (): void => {
    if (current) { again = true; return; }
    again = false;
    current = task().then(() => undefined, onError).finally(() => {
      current = null;
      if (again) run();
    });
  };
  return Object.assign(run, { async idle() { while (current) await current; } });
}

export interface HostExecution {
  boundary: HostBoundary;
  /** Null until the database is attached. */
  gate(): WriterGate | null;
  manifests(): GovernedManifests | null;
  /**
   * Reconciles every abandoned governed turn on an existing database (with
   * none, nothing is created, so a refused boot leaves no database behind),
   * remembers whether the brain has a governed history, and holds the writer
   * gate on that handle until `attach` or `release`.
   */
  reconcileExisting(): Reconciliation[];
  /** Reconciles every abandoned governed turn on `db` (refusing if any path stayed), then opens the gate and manifests on it. */
  attach(db: Database): Reconciliation[];
  /** Closes the early handle `reconcileExisting` kept, when a boot refuses before `attach`. */
  release(): void;
}

export function createHostExecution(options: { brainPath: string; dbPath: string; exec?: ExecWrapperConfig; home?: string; log?: Logger;
  nativeManager?: import("./host-boundary.js").HostBoundaryOptions["nativeManager"];
  nativeMaskPaths?: readonly string[];
  maintenanceTemp?: WorkerStateLimits;
  privateStatePaths?: OperationalStateLayout["privateStatePaths"]; profile?: "governed" | "strict"; requireGate?: boolean; workerHost?: () => WorkerHostProbe | undefined }): HostExecution {
  assertOperationalStateOutsideBrain(options);
  let gate: WriterGate | null = null;
  let manifests: GovernedManifests | null = null;
  let history = false;
  let early: Database | undefined;
  let quarantineDir: string | undefined;
  const open = (db: Database) => createGovernedManifests(db, { brainPath: options.brainPath,
    quarantineDir: quarantineDir ??= quarantineDirFor(options.dbPath), ...(options.log ? { log: options.log } : {}) });
  const boundary = createHostBoundary({ profile: options.profile, brainPath: options.brainPath, dbPath: options.dbPath, privateStatePaths: options.privateStatePaths,
    ...(options.nativeManager ? { nativeManager: options.nativeManager } : {}),
    ...(options.nativeMaskPaths ? { nativeMaskPaths: options.nativeMaskPaths } : {}),
    ...(options.maintenanceTemp ? { maintenanceTemp: options.maintenanceTemp } : {}),
    ...(options.exec ? { exec: options.exec } : {}), ...(options.home ? { home: options.home } : {}),
    ...(options.log ? { log: options.log } : {}), ...(options.requireGate ? { requireGate: true } : {}),
    ...(options.workerHost ? { workerHost: options.workerHost } : {}),
    gate: () => gate, history: () => manifests ? manifests.hasHistory() : history });
  return {
    boundary,
    gate: () => gate,
    manifests: () => manifests,
    reconcileExisting() {
      if (options.dbPath === ":memory:" || !existsSync(options.dbPath)) return [];
      const db = createUiDb(options.dbPath);
      try {
        const opened = open(db);
        const results = opened.reconcileAbandoned();
        history = opened.hasHistory();
        assertReconciled(results);
        // The gate is held on this handle until `attach`, so maintenance at
        // boot (the CLI version probe) already meets the cron runner's holds.
        gate = createWriterGate(db, options.brainPath);
        early = db;
        return results;
      } catch (error) { db.close(); throw error; }
    },
    attach(db) {
      // Reconciled first: a failure refuses before the gate exists, so no
      // gated maintenance can start on a brain still holding such a path.
      const opened = open(db);
      const results = opened.reconcileAbandoned();
      history = opened.hasHistory();
      assertReconciled(results);
      manifests = opened;
      gate = createWriterGate(db, options.brainPath);
      early?.close();
      early = undefined;
      return results;
    },
    release() {
      early?.close();
      early = undefined;
    },
  };
}
