#!/usr/bin/env bun
/** Thin argv dispatcher for the ui-server's container cron jobs. */

import { statSync } from "fs";
import { join } from "path";

import { execConfig, resolveCronConfig } from "../config/env.js";
import { execWrapperSpawnOptions, wrapCommand } from "@schlessera/brain-ui-sdk/internal";
import { runDigest } from "../cron/digest.js";
import {
  emitCrontab,
  emitEnvironment,
  type BrainModuleListPayload,
} from "../cron/emit.js";
import { runJob } from "../cron/run-job.js";

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

async function readModuleList(
  brainPath: string,
  env: Record<string, string | undefined>
): Promise<BrainModuleListPayload | null> {
  try {
    // The CLI imports the repository's config, so this read goes through the
    // wrapper like every other CLI launch.
    const exec = execConfig();
    const proc = Bun.spawn(wrapCommand(["brain", "module", "list", "--json"], exec.wrapper), {
      cwd: brainPath,
      env,
      stdout: "pipe",
      stderr: "ignore",
      ...execWrapperSpawnOptions(exec.wrapper),
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
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
  process.exit(
    await runJob({
      jobName,
      command,
      dbPath: config.dbPath,
      childEnv: config.childEnv,
    })
  );
}

if (subcommand === "digest" && args.length === 0) {
  const config = resolveCronConfig();
  process.exit(runDigest({ dbPath: config.dbPath }));
}

if (subcommand === "crontab") {
  const config = resolveCronConfig();
  const options = crontabOptions(args);
  const modules = await readModuleList(
    config.brainPath,
    config.moduleDiscoveryEnv
  );
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
