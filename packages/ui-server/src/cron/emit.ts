import {
  parseSubprocessEnvExtra,
  SUBPROCESS_ENV,
  type SubprocessEnvAudience,
} from "@schlessera/brain-ui-sdk/server";

/** One cron manifest entry in `brain module list --json`. */
export interface BrainModuleListCronEntry {
  name: string;
  schedule: string;
  command: string;
}

/** One enabled module in the core CLI's module-list payload. */
export interface BrainModuleListEnabledModule {
  name: string;
  key: string;
  description: string | null;
  types: string[];
  commands: string[];
  cron: BrainModuleListCronEntry[];
}

/** One disabled-but-available module in the core CLI's module-list payload. */
export interface BrainModuleListAvailableModule {
  key: string;
  description: string | null;
  enabled: false;
}

/** The payload emitted by `brain module list --json`. */
export interface BrainModuleListPayload {
  enabled: BrainModuleListEnabledModule[];
  available: BrainModuleListAvailableModule[];
}

export interface EmitCrontabOptions {
  /** Null means the core CLI was unavailable or did not return JSON. */
  modules: BrainModuleListPayload | null;
  /** Command prefix that records and runs one job. */
  wrapperCommand: string;
  /** Command executed inside the wrapper's `digest` job. */
  digestCommand: string;
  /** Complete `PATH=...` crontab line. */
  pathLine: string;
  /** System crontab user field. */
  user: string;
  /** Whether `scripts/jobs/scrape-all.ts` exists in the brain repository. */
  legacyScraperPresent: boolean;
  /** Valid names carried into each wrapper so the run process re-admits them. */
  subprocessEnvExtraNames?: readonly string[];
  /**
   * Schedule the weekly `hygiene` job, which runs `brain hygiene reconcile`.
   * Default true; BRAIN_UI_CRON_HYGIENE=off turns it off.
   */
  hygiene?: boolean;
}

/**
 * Jobs the cron runner executes on the server's own behalf, not the
 * repository's, and therefore does not launch through the exec wrapper: the
 * digest writes the UI database, which a privilege-dropping wrapper puts out
 * of reach. `runJob` matches on these names, so {@link emitCrontab} refuses
 * any module job that would carry one — a repository must never be able to
 * choose to run unwrapped.
 */
export const TRUSTED_JOB_NAMES: ReadonlySet<string> = new Set(["digest"]);

/**
 * The base `sync` job's command (#290): the whole sync as one result on
 * stdout, then the reindex with its output on stderr, so stdout holds nothing
 * but the result. `runJob` reads a result only from a `sync` job running
 * exactly this argv ({@link isSyncJob}); the crontab line below is its shell
 * spelling.
 */
export const SYNC_JOB_COMMAND: readonly string[] = ["sh", "-c", "brain sync --json && brain index >&2"];

/** Whether a job is the base sync job this module emits, and no other. */
export function isSyncJob(jobName: string, command: readonly string[]): boolean {
  return (
    jobName === "sync" &&
    command.length === SYNC_JOB_COMMAND.length &&
    command.every((arg, i) => arg === SYNC_JOB_COMMAND[i])
  );
}

const MODULE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CRON_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CRON_SCHEDULE = /^[-0-9*,/ ]{1,100}$/;
const CRON_COMMAND = /^[A-Za-z0-9 _.:=@,/-]{1,200}$/;

// These use ^...$ without the `m` flag deliberately. In JavaScript `$`
// matches only at the true end of the string, so these are the correct
// translation of the bash jq/Oniguruma guards, which needed \A...\z because
// Oniguruma's `$` can match before a trailing newline.
function validModuleName(value: unknown): value is string {
  return typeof value === "string" && MODULE_NAME.test(value);
}

function validCronEntry(value: unknown): value is BrainModuleListCronEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BrainModuleListCronEntry>;
  return (
    typeof entry.name === "string" &&
    CRON_NAME.test(entry.name) &&
    typeof entry.schedule === "string" &&
    CRON_SCHEDULE.test(entry.schedule) &&
    typeof entry.command === "string" &&
    CRON_COMMAND.test(entry.command)
  );
}

function assertSingleLine(name: string, value: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be a single line`);
  }
}

/**
 * Emit `/etc/cron.d/brain-ui` with the same byte layout as the deployment
 * shell's historical `generate_crontab` function.
 */
export function emitCrontab(options: EmitCrontabOptions): string {
  const {
    modules,
    wrapperCommand,
    digestCommand,
    pathLine,
    user,
    legacyScraperPresent,
    subprocessEnvExtraNames = [],
    hygiene = true,
  } = options;

  assertSingleLine("wrapperCommand", wrapperCommand);
  assertSingleLine("digestCommand", digestCommand);
  assertSingleLine("pathLine", pathLine);
  assertSingleLine("user", user);

  const validatedExtraNames = parseSubprocessEnvExtra(
    subprocessEnvExtraNames.join(",")
  );
  const wrapper =
    validatedExtraNames.length === 0
      ? wrapperCommand
      : `${wrapperCommand} --subprocess-env-extra ${validatedExtraNames.join(",")}`;

  const lines = [
    "# Generated by entrypoint.sh — regenerated on each container start.",
    pathLine,
    "",
    "# Base jobs",
    `0 2 * * * ${user} cd /data/brain && ${wrapper} sync -- sh -c '${SYNC_JOB_COMMAND[2]}' 2>&1 | logger -t brain-sync`,
    `0 3 * * * ${user} cd /data/brain && ${wrapper} validate -- brain validate 2>&1 | logger -t brain-validate`,
    `0 7 * * * ${user} cd /data/brain && ${wrapper} maintain -- brain maintain 2>&1 | logger -t brain-maintain`,
    `30 7 * * * ${user} cd /data/brain && ${wrapper} digest -- ${digestCommand} 2>&1 | logger -t brain-digest`,
    // Weekly, and only the deterministic half of content hygiene: the log's
    // backlog and last-run date move, and no content is edited. It runs
    // repository code, so it goes through the wrapper and is never trusted.
    ...(hygiene
      ? [`0 6 * * 1 ${user} cd /data/brain && ${wrapper} hygiene -- brain hygiene reconcile 2>&1 | logger -t brain-hygiene`]
      : []),
    "",
    "# Module jobs (from enabled modules' cron manifests, when exposed)",
  ];

  const enabled = modules && Array.isArray(modules.enabled) ? modules.enabled : [];
  if (modules === null) {
    lines.push("# (brain module list unavailable — module cron skipped)");
  } else {
    for (const module of enabled) {
      if (!module || typeof module !== "object" || !validModuleName(module.name)) continue;
      const entries = Array.isArray(module.cron) ? module.cron : [];
      for (const entry of entries) {
        if (!validCronEntry(entry)) continue;
        const jobName = `${module.name}-${entry.name}`;
        // Defence in depth (#81): the namespacing above already keeps a
        // module job off every trusted name, since none contains a `-`. This
        // keeps it off them if that ever changes, from this same set.
        if (TRUSTED_JOB_NAMES.has(jobName)) continue;
        lines.push(
          `${entry.schedule} ${user} cd /data/brain && ${wrapper} ${jobName} -- brain ${entry.command} 2>&1 | logger -t brain-${jobName}`
        );
      }
    }
  }

  const jobsModuleEnabled = enabled.some(
    (module) =>
      module &&
      typeof module === "object" &&
      Array.isArray(module.commands) &&
      module.commands.includes("jobs")
  );
  // Keep the historical standalone scraper fallback for brain repositories
  // that have not moved their jobs workflow to an enabled module.
  if (!jobsModuleEnabled && legacyScraperPresent) {
    lines.push(
      `0 4 * * * ${user} cd /data/brain && ${wrapper} jobs -- bun scripts/jobs/scrape-all.ts --api-only 2>&1 | logger -t brain-jobs`
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * NODE_ENV is in the descriptor because Bun uses it to choose `.env.<mode>` in
 * every child spawned by the server. Scheduled jobs take a different path:
 * they historically receive their environment through pam_env without
 * NODE_ENV, and adding it would change which brain-repo env file their Bun
 * commands load. The 0.33.1 allowlist keeps that historical behavior while
 * widening the explicitly approved capability settings below.
 */
export const CRON_ENV_EXCLUSIONS: ReadonlySet<string> = new Set(["NODE_ENV"]);

/**
 * The order the shell emitted `/etc/environment` in. pam_env does not care,
 * but the historical golden is byte-exact and this is what it is compared
 * against.
 *
 * Order lives HERE, not in the SDK descriptor: the SET is owned by
 * `SUBPROCESS_ENV`'s cron audience (see {@link CRON_ENV_NAMES}, which fails
 * loudly if the two ever disagree), and making an unrelated file's declaration
 * order load-bearing for a cosmetic property would be a trap for whoever next
 * tidies it.
 */
const CRON_ENV_ORDER: readonly string[] = [
  "PATH",
  "BRAIN_PATH",
  "BRAIN_ROOT",
  "TZ",
  "XDG_BIN_HOME",
  "DB_PATH",
  "BRAIN_RERANK_MODE",
  "SCRAPE_CHROME_URL",
  "CHROME_CDP_URL",
  "SCRAPE_CHROME_PATH",
  "SCRAPE_CHROME_NO_SANDBOX",
  "SCRAPE_USER_AGENT",
  "SCRAPE_RESPECT_ROBOTS",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GITHUB_TOKEN",
  "BRAIN_UI_SYNC_GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "BRAIN_UI_PRICING_DISCOVERY",
  "BRAIN_UI_PRICING_TTL_HOURS",
];

/**
 * Names emitted into `/etc/environment`: the SDK's cron audience minus the
 * explicit exclusions, in {@link CRON_ENV_ORDER}.
 *
 * A variable that joins or leaves the cron audience and is not accounted for
 * here throws at module load rather than silently changing what scheduled jobs
 * can see.
 */
export const CRON_ENV_NAMES = Object.freeze(
  (() => {
    const audience = Object.entries(SUBPROCESS_ENV)
      .filter(([, audiences]) =>
        (audiences as readonly SubprocessEnvAudience[]).includes("cron")
      )
      .map(([name]) => name)
      .filter((name) => !CRON_ENV_EXCLUSIONS.has(name));
    const ordered = new Set(CRON_ENV_ORDER);
    const missing = audience.filter((name) => !ordered.has(name));
    const extra = CRON_ENV_ORDER.filter((name) => !audience.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        "cron environment list drifted from SUBPROCESS_ENV's cron audience: " +
          `unordered=[${missing.join(", ")}] unknown=[${extra.join(", ")}]`
      );
    }
    return CRON_ENV_ORDER.slice();
  })()
);

/** Emit the pam_env input consumed by scheduled jobs. */
/**
 * Control configuration the cron RUNNER reads, as opposed to environment its
 * jobs receive.
 *
 * `/etc/environment` is how the runner gets an environment at all, so a
 * wrapper configured for the server reaches scheduled jobs only if it is
 * emitted here — otherwise the boundary quietly stops at the crontab, which is
 * the worst place for a privilege boundary to stop quietly.
 *
 * Deliberately NOT part of `SUBPROCESS_ENV`'s cron audience: these are read by
 * the runner before it spawns, and forwarding control configuration into the
 * job itself is the thing `BRAIN_UI_SUBPROCESS_ENV_EXTRA` is careful not to do.
 * Appended after the audience names so an unset wrapper leaves the emitted
 * file byte-identical.
 */
export const CRON_CONTROL_ENV_NAMES: readonly string[] = [
  "BRAIN_UI_EXEC_WRAPPER",
  "BRAIN_UI_EXEC_KILLER",
];

export function emitEnvironment(
  env: Record<string, string | undefined>,
  extraNames: readonly string[] = []
): string {
  const lines: string[] = [];
  const names = [
    ...CRON_ENV_NAMES,
    ...parseSubprocessEnvExtra(extraNames.join(",")).filter(
      (name) => !CRON_ENV_NAMES.includes(name)
    ),
    ...CRON_CONTROL_ENV_NAMES.filter((name) => !CRON_ENV_NAMES.includes(name)),
  ];
  for (const name of names) {
    const value = env[name];
    // Match the shell's `[ -n ]`: both unset and empty values are omitted.
    if (!value) continue;
    // /etc/environment has no shell-safe interpolation layer. Reject anything
    // that could terminate/escape the quoted value or create another line.
    if (/[\0"\\\r\n]/.test(value)) {
      throw new Error(`cannot emit unsafe /etc/environment value for ${name}`);
    }
    lines.push(`${name}="${value}"`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
