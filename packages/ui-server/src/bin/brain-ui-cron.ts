#!/usr/bin/env bun
/** Thin argv dispatcher for the ui-server's container cron jobs. */

import { statSync } from "fs";
import { join } from "path";

import { resolveCronConfig } from "../config/env.js";
import type { ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import { runDigest } from "../cron/digest.js";
import {
  emitCrontab,
  emitEnvironment,
  type BrainModuleListPayload,
} from "../cron/emit.js";
import { runJob } from "../cron/run-job.js";
import { createUiDb } from "../db/client.js";
import { brainCommandClass, type HostBoundary } from "../brain/host-boundary.js";
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
function cronHostExecution(config: { brainPath: string; dbPath: string; exec: ExecWrapperConfig }, options: { gate: boolean }) {
  const execution = createHostExecution({ brainPath: config.brainPath, dbPath: config.dbPath, exec: config.exec, requireGate: options.gate });
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
    if (options.gate) {
      db = createUiDb(config.dbPath);
      report(execution.attach(db));
    } else report(execution.reconcileExisting());
  } catch (error) {
    reconciled = false;
    process.stderr.write(`[brain-ui-cron] the brain cannot be evaluated: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return { boundary: execution.boundary, reconciled, close: () => { execution.release(); try { db?.close(); } catch { /* Closing cannot fail the job. */ } } };
}

async function readModuleList(
  brainPath: string,
  env: Record<string, string | undefined>,
  boundary: HostBoundary
): Promise<BrainModuleListPayload | null> {
  try {
    // The CLI imports the repository's config, so this read goes through the
    // host boundary like every other CLI launch: a maintenance worker while
    // it holds, the exec wrapper otherwise.
    const result = await boundary.run({ argv: ["brain", "module", "list", "--json"], env,
      ...brainCommandClass(["module", "list"]), purpose: "brain module list" });
    const exitCode = result.exitCode;
    const stdout = result.stdout;
    if (exitCode !== 0 || stdout.trim() === "") return null;
    const parsed: unknown = JSON.parse(stdout);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Partial<BrainModuleListPayload>).enabled) ||
      !Array.isArray((parsed as Partial<BrainModuleListPayload>).available)
    ) {
      return null;
    }
    return parsed as BrainModuleListPayload;
  } catch {
    return null;
  }
}

const [subcommand, ...args] = process.argv.slice(2);

if (subcommand === "run") {
  const { jobName, command, subprocessEnvExtraNames } = runOptions(args);
  const config = resolveCronConfig(undefined, subprocessEnvExtraNames);
  const host = cronHostExecution(config, { gate: true });
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
  } finally { host.close(); }
  process.exit(code);
}

if (subcommand === "digest" && args.length === 0) {
  const config = resolveCronConfig();
  process.exit(runDigest({ dbPath: config.dbPath }));
}

if (subcommand === "crontab") {
  const config = resolveCronConfig();
  const options = crontabOptions(args);
  const host = cronHostExecution(config, { gate: false });
  let modules: BrainModuleListPayload | null;
  try {
    // Nothing evaluates a brain that still holds an unreconciled protected path.
    modules = host.reconciled ? await readModuleList(config.brainPath, config.moduleDiscoveryEnv, host.boundary) : null;
  } finally { host.close(); }
  process.stdout.write(
    emitCrontab({
      ...options,
      modules,
      subprocessEnvExtraNames: config.subprocessEnvExtraNames,
      hygiene: config.hygiene,
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
