#!/usr/bin/env bun
/** Thin argv dispatcher for the ui-server's container cron jobs. */

import { resolveCronConfig } from "../config/env.js";
import { runDigest } from "../cron/digest.js";
import { runJob } from "../cron/run-job.js";

export const USAGE = "usage: brain-ui-cron run <job-name> -- <command...> | digest";

function usage(): never {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
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

usage();
