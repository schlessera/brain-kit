#!/usr/bin/env bun
/** Thin argv dispatcher for the ui-server's container cron jobs. */

import { statSync, realpathSync } from "fs";
import { join, resolve } from "path";

import { resolveCronConfig, resolveStandalonePricingConfig, type CronConfig } from "../config/env.js";
import { createTurnBudgets } from "../brain/turn-budgets.js";
import { maintenanceProviderMeter } from "../brain/provider-meter.js";
import { createModelPricing } from "../pricing/model-pricing.js";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createNativeBrainLeaseManager } from "../brain/native-brain-leases.js";
import { assertOperationalStateOutsideBrain } from "../brain/operational-state.js";
import { runDigest } from "../cron/digest.js";
import {
  emitCrontab,
  emitEnvironment,
  type BrainModuleListPayload,
} from "../cron/emit.js";
import { discoverModules, persistModuleDiscovery, readModuleList } from "../cron/module-discovery.js";
import { runJob } from "../cron/run-job.js";
import { createUiDb } from "../db/client.js";
import { createHostExecution } from "../brain/host-execution.js";
import type { Reconciliation } from "../brain/governed-manifest.js";

/**
 * The bash this replaced tested `[ -f … ]`, which is true only for a regular
 * file (following symlinks). `existsSync` would also accept a directory, and a
 * directory at that path would put a root cron line in the crontab that the
 * shell has always skipped.
 */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const USAGE = `usage: brain-ui-cron run [--subprocess-env-extra <names>] <job-name> -- <command...>
       brain-ui-cron digest
       brain-ui-cron crontab [--wrapper-command <command>] [--digest-command <command>] [--path-line <line>] [--user <user>]
       brain-ui-cron environment`;

const DEFAULT_WRAPPER_COMMAND = "bun /opt/brain-ui/server/scripts/cron-run.ts";
const DEFAULT_DIGEST_COMMAND = "bun /opt/brain-ui/server/scripts/brain-digest.ts";
const DEFAULT_PATH_LINE =
  "PATH=/root/.local/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_USER = "root";

function usage(): never {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function crontabOptions(args: string[]): {
  wrapperCommand: string;
  digestCommand: string;
  pathLine: string;
  user: string;
} {
  const values = new Map<string, string>();
  const accepted = new Set([
    "--wrapper-command",
    "--digest-command",
    "--path-line",
    "--user",
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!accepted.has(flag) || value === undefined || value === "" || value.startsWith("--")) {
      usage();
    }
    values.set(flag, value);
  }
  return {
    wrapperCommand: values.get("--wrapper-command") ?? DEFAULT_WRAPPER_COMMAND,
    digestCommand: values.get("--digest-command") ?? DEFAULT_DIGEST_COMMAND,
    pathLine: values.get("--path-line") ?? DEFAULT_PATH_LINE,
    user: values.get("--user") ?? DEFAULT_USER,
  };
}

function runOptions(args: string[]): {
  jobName: string;
  command: string[];
  subprocessEnvExtraNames: string[];
} {
  let remaining = args;
  let subprocessEnvExtraNames: string[] = [];
  if (remaining[0] === "--subprocess-env-extra") {
    const value = remaining[1];
    if (value === undefined || value === "") usage();
    subprocessEnvExtraNames = value.split(",");
    remaining = remaining.slice(2);
  }
  const [jobName, separator, ...command] = remaining;
  if (!jobName || separator !== "--" || command.length === 0) usage();
  return { jobName, command, subprocessEnvExtraNames };
}

/**
 * The host execution boundary for this cron process (#1648), on the UI
 * database the server shares. Turns a dead server left mid-turn are
 * reconciled here too, before this process evaluates anything in the brain.
 * Gated jobs refuse rather than run without the gate.
 */
async function cronHostExecution(config: CronConfig, options: { gate: boolean }) {
  if (!config.nativeBrain) throw Error("Repository cron jobs require configured managed Btrfs storage and BRAIN_UI_NATIVE_BRAIN_SOCKET; no full-copy fallback is supported.");
  const raw = createNativeBrainManagerClient(config.nativeBrain), ready = await raw.ready();
  if (realpathSync(config.brainPath) !== ready.brainPath) throw Error("The native manager serves a different cron brain; no repository code can run.");
  const ephemeral = !config.dbPath || config.dbPath === ":memory:";
  if (ephemeral && !config.nativeBrain.leasePath) throw Error("Ephemeral cron UI state requires explicit BRAIN_UI_NATIVE_BRAIN_LEASE_PATH.");
  const statePath = resolve(config.nativeBrain.leasePath ?? `${config.dbPath}.native-leases.sqlite`);
  const privateStatePaths = [{ setting: "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", path: statePath }];
  assertOperationalStateOutsideBrain({ brainPath: config.brainPath, dbPath: config.dbPath, privateStatePaths });
  const leases = await createNativeBrainLeaseManager(raw, { statePath, brainPath: ready.brainPath, fsid: ready.fsid, brainUuid: ready.brainUuid });
  try {
  const recovered = await leases.recoverDeadOwners();
  if (recovered.unknown.length || recovered.retainedUnverifiable) process.stderr.write(`[brain-ui-cron] native ownership recovery retained ${recovered.unknown.length} unknown outcomes and ${recovered.retainedUnverifiable} unverifiable PID namespaces.\n`);
  // A credentialed job reaches the CLI's providers through a metered relay,
  // charged to its UTC day on the database the server shares (#1673).
  let relayBudgets: ReturnType<typeof createTurnBudgets> | undefined;
  const providerRelay = maintenanceProviderMeter({ brainPath: config.brainPath, origins: config.cliProviderOrigins, budgets: () => relayBudgets,
    report: message => process.stderr.write(`[brain-ui-cron] ${message}\n`) });
  const execution = createHostExecution({ nativeManager: leases.client, nativeMaskPaths: ready.privatePaths, privateStatePaths, providerRelay,
    brainPath: config.brainPath, dbPath: config.dbPath, exec: config.exec, maintenanceTemp: config.maintenanceTemp, requireGate: options.gate });
  const report = (results: Reconciliation[]) => {
    for (const result of results) {
      if (!result.quarantined.length && !result.failed.length) continue;
      process.stderr.write(`[brain-ui-cron] governed turn ${result.turnId}: quarantined ${result.quarantined.map(q => q.path).join(", ") || "nothing"}`
        + `${result.failed.length ? `; could not move ${result.failed.map(f => f.path).join(", ")}` : ""}\n`);
    }
  };
  let db: ReturnType<typeof createUiDb> | undefined;
  let reconciled = true;
  try {
    // A job holds the gate on the database; emitting a crontab only needs
    // whatever an existing database says about the brain.
    report(execution.reconcileExisting());
    await execution.boundary.prepare();
    if (options.gate) {
      db = createUiDb(config.dbPath);
      report(execution.attach(db));
      relayBudgets = createTurnBudgets(db, createModelPricing(resolveStandalonePricingConfig()));
    }
  } catch (error) {
    reconciled = false;
    process.stderr.write(`[brain-ui-cron] the brain cannot be evaluated: ${error instanceof Error ? error.message : String(error)}\n`);
    execution.release(); db?.close();
    throw error;
  }
  return { boundary: execution.boundary, reconciled, close: async () => {
    execution.release(); try { await leases.close(); } finally { try { db?.close(); } catch { /* Closing tracking cannot fail the job. */ } }
  } };
  } catch (error) { await leases.close().catch(() => {}); throw error; }
}

const [subcommand, ...args] = process.argv.slice(2);

if (subcommand === "run") {
  const { jobName, command, subprocessEnvExtraNames } = runOptions(args);
  const config = resolveCronConfig(undefined, subprocessEnvExtraNames);
  const host = await cronHostExecution(config, { gate: true });
  let code: number;
  try {
    code = await runJob({
      jobName,
      command,
      dbPath: config.dbPath,
      childEnv: config.childEnv,
      exec: config.exec,
      brainPath: config.brainPath,
      boundary: host.boundary,
    });
  } finally { await host.close(); }
  process.exit(code);
}

if (subcommand === "digest" && args.length === 0) {
  const config = resolveCronConfig();
  process.exit(runDigest({ dbPath: config.dbPath }));
}

if (subcommand === "crontab") {
  const config = resolveCronConfig();
  const options = crontabOptions(args);
  const report = (line: string) => process.stderr.write(`[brain-ui-cron] ${line}\n`);
  let hostQualified = false;
  // Each attempt qualifies the host afresh: a boot-time failure is most often
  // native readiness still settling, which a retry is meant to outlast (#3381).
  const discovery = await discoverModules({ report, attempt: async () => {
    // A missing native configuration is not transient; retrying cannot change it.
    if (!config.nativeBrain) return { modules: null, retryable: false, cause: "BRAIN_UI_NATIVE_BRAIN_SOCKET is not configured; no repository code can be evaluated" };
    const host = await cronHostExecution(config, { gate: false });
    hostQualified = true;
    try {
      // Nothing evaluates a brain without native qualification and reconciliation.
      if (!host.reconciled) return { modules: null, retryable: true, cause: "host not reconciled" };
      return await readModuleList(config.moduleDiscoveryEnv, host.boundary);
    } finally { await host.close(); }
  } });
  persistModuleDiscovery({ brainPath: config.brainPath, dbPath: config.dbPath, hostQualified, outcome: discovery, report });
  const modules: BrainModuleListPayload | null = discovery.modules;
  process.stdout.write(
    emitCrontab({
      ...options,
      modules,
      subprocessEnvExtraNames: config.subprocessEnvExtraNames,
      hygiene: config.hygiene,
      propagation: config.propagation,
      legacyScraperPresent: isRegularFile(
        join(config.brainPath, "scripts", "jobs", "scrape-all.ts")
      ),
    })
  );
  process.exit(0);
}

if (subcommand === "environment" && args.length === 0) {
  const config = resolveCronConfig();
  try {
    // The runner's control configuration is merged back in here, not carried
    // in childEnv: childEnv is filtered to the cron audience, which is what a
    // scheduled job receives, and the wrapper is read by the runner before it
    // spawns anything. Emitting it is what carries the privilege boundary past
    // the crontab.
    process.stdout.write(
      emitEnvironment(
        { ...config.childEnv, ...config.controlEnv },
        config.subprocessEnvExtraNames
      )
    );
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[brain-ui-cron] ${message}\n`);
    process.exit(1);
  }
}

usage();
