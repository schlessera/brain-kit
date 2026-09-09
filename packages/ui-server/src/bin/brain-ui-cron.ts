#!/usr/bin/env bun
/** Thin argv dispatcher for the ui-server's container cron jobs. */

import { statSync } from "fs";
import { join } from "path";

import { resolveCronConfig } from "../config/env.js";
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

export const USAGE = `usage: brain-ui-cron run <job-name> -- <command...>
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

async function readModuleList(
  brainPath: string,
  env: Record<string, string | undefined>
): Promise<BrainModuleListPayload | null> {
  try {
    const proc = Bun.spawn(["brain", "module", "list", "--json"], {
      cwd: brainPath,
      env,
      stdout: "pipe",
      stderr: "ignore",
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
const config = resolveCronConfig();

if (subcommand === "run") {
  const [jobName, separator, ...command] = args;
  if (!jobName || separator !== "--" || command.length === 0) usage();
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
  process.exit(runDigest({ dbPath: config.dbPath }));
}

if (subcommand === "crontab") {
  const options = crontabOptions(args);
  const modules = await readModuleList(config.brainPath, config.childEnv);
  process.stdout.write(
    emitCrontab({
      ...options,
      modules,
      legacyScraperPresent: isRegularFile(
        join(config.brainPath, "scripts", "jobs", "scrape-all.ts")
      ),
    })
  );
  process.exit(0);
}

if (subcommand === "environment" && args.length === 0) {
  try {
    process.stdout.write(emitEnvironment(config.childEnv));
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[brain-ui-cron] ${message}\n`);
    process.exit(1);
  }
}

usage();
