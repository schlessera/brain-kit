import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { SUBPROCESS_ENV } from "@schlessera/brain-ui-sdk/server";

import {
  CRON_ENV_EXCLUSIONS,
  CRON_ENV_NAMES,
  emitCrontab,
  emitEnvironment,
  type BrainModuleListPayload,
  type EmitCrontabOptions,
} from "../src/cron/emit";

const FIXTURES = join(import.meta.dir, "fixtures", "cron");
const CRON_ENV_ORDER = [
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
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GITHUB_TOKEN",
  "BRAIN_UI_SYNC_GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "BRAIN_UI_PRICING_DISCOVERY",
  "BRAIN_UI_PRICING_TTL_HOURS",
] as const;

const HISTORICAL_OPTIONS = {
  wrapperCommand: "bun /opt/brain-ui/server/scripts/cron-run.ts",
  digestCommand: "bun /opt/brain-ui/server/scripts/brain-digest.ts",
  pathLine:
    "PATH=/root/.local/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  user: "root",
  legacyScraperPresent: false,
} satisfies Omit<EmitCrontabOptions, "modules">;

function jsonFixture(name: string): BrainModuleListPayload | null {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as
    | BrainModuleListPayload
    | null;
}

function render(
  modules: BrainModuleListPayload | null,
  overrides: Partial<Omit<EmitCrontabOptions, "modules">> = {}
): string {
  return emitCrontab({ modules, ...HISTORICAL_OPTIONS, ...overrides });
}

describe("emitCrontab", () => {
  test("is byte-equal to the historical bash output", () => {
    expect(render(jsonFixture("valid-multi-module.json"))).toBe(
      readFileSync(join(FIXTURES, "historical.crontab"), "utf8")
    );
  });

  test("renders the production cutover with both bin subcommands by absolute path", () => {
    const bin = "/opt/brain-ui/server/node_modules/.bin/brain-ui-cron";
    expect(
      render(jsonFixture("valid-multi-module.json"), {
        wrapperCommand: `${bin} run`,
        digestCommand: `${bin} digest`,
        subprocessEnvExtraNames: ["CUSTOM_CRON_TOKEN"],
      })
    ).toBe(readFileSync(join(FIXTURES, "production-cutover.crontab"), "utf8"));
  });

  test("drops every entry from a module whose name has a trailing newline", () => {
    const output = render(jsonFixture("module-name-trailing-newline.json"), {
      legacyScraperPresent: true,
    });
    expect(output).not.toContain("jobs-scrape");
    expect(output).not.toContain("scripts/jobs/scrape-all.ts");
    expect(output).toContain("finance-remind -- brain finance reminders");
    expect(output.match(/brain-finance-remind/g)).toHaveLength(1);
  });

  test("drops a command with a smuggled second line and keeps its valid sibling", () => {
    const output = render(jsonFixture("command-smuggled-newline.json"));
    expect(output).not.toContain("jobs-scrape");
    expect(output).not.toContain("0 6 25 12 0 root brain maintain");
    expect(output).toContain("jobs-score -- brain jobs score");
    expect(output.match(/brain-jobs-score/g)).toHaveLength(1);
  });

  test("an empty module list emits neither an unavailable note nor module jobs", () => {
    const output = render(jsonFixture("empty.json"));
    expect(output).not.toContain("module list unavailable");
    expect(output).not.toContain("scripts/jobs/scrape-all.ts");
    expect(output.endsWith("when exposed)\n\n")).toBe(true);
  });

  test("keeps the standalone scraper fallback when no enabled module exposes jobs", () => {
    const output = render(jsonFixture("no-jobs.json"), { legacyScraperPresent: true });
    expect(output).toContain("finance-remind -- brain finance reminders");
    expect(output).toContain(
      "jobs -- bun scripts/jobs/scrape-all.ts --api-only 2>&1 | logger -t brain-jobs"
    );
  });

  test("reports an unavailable CLI and still uses the legacy fallback when present", () => {
    const output = render(jsonFixture("unavailable.json"), { legacyScraperPresent: true });
    expect(output).toContain("# (brain module list unavailable — module cron skipped)");
    expect(output).toContain("bun scripts/jobs/scrape-all.ts --api-only");
  });

  test("re-validates cron name, schedule, and command independently", () => {
    const base = jsonFixture("valid-multi-module.json");
    if (!base) throw new Error("valid fixture unexpectedly null");
    const valid = base.enabled[0].cron[0];
    const modules: BrainModuleListPayload = {
      enabled: [
        {
          ...base.enabled[0],
          cron: [
            { ...valid, name: "bad\n" },
            { ...valid, name: "bad-schedule", schedule: "0 6 * * *\n" },
            { ...valid, name: "bad-command", command: "jobs scrape; reboot" },
            { ...valid, name: "kept", command: "jobs scrape" },
          ],
        },
      ],
      available: [],
    };
    const output = render(modules);
    expect(output).not.toContain("jobs-bad ");
    expect(output).not.toContain("jobs-bad-schedule");
    expect(output).not.toContain("jobs-bad-command");
    expect(output).toContain("jobs-kept -- brain jobs scrape");
  });

  test("rejects a newline in trusted deployment parameters", () => {
    expect(() =>
      render(jsonFixture("empty.json"), { user: "root\n* * * * * root reboot" })
    ).toThrow("user must be a single line");
  });

  test("carries validated escape-hatch names into every generated wrapper call", () => {
    const output = render(jsonFixture("valid-multi-module.json"), {
      subprocessEnvExtraNames: [
        " CUSTOM_CRON_TOKEN ",
        "bad-name",
        "CUSTOM_CRON_TOKEN",
      ],
      legacyScraperPresent: true,
    });

    expect(output).toContain(
      "brain-ui/server/scripts/cron-run.ts --subprocess-env-extra CUSTOM_CRON_TOKEN sync --"
    );
    expect(output).toContain(
      "brain-ui/server/scripts/cron-run.ts --subprocess-env-extra CUSTOM_CRON_TOKEN jobs-scrape --"
    );
    expect(output).not.toContain("bad-name");

    const legacyOutput = render(jsonFixture("no-jobs.json"), {
      subprocessEnvExtraNames: ["CUSTOM_CRON_TOKEN"],
      legacyScraperPresent: true,
    });
    expect(legacyOutput).toContain(
      "brain-ui/server/scripts/cron-run.ts --subprocess-env-extra CUSTOM_CRON_TOKEN jobs --"
    );
  });
});

describe("emitEnvironment", () => {
  test("derives the scheduled-job names, in fixed order, from the cron audience", () => {
    expect(CRON_ENV_NAMES).toEqual([...CRON_ENV_ORDER]);

    // The SET comes from the SDK; the ORDER is the emitter's own, so compare
    // the audience as a set. A variable joining or leaving the audience
    // without being accounted for makes CRON_ENV_NAMES throw at module load.
    const cronAudience = Object.entries(SUBPROCESS_ENV)
      .filter(([, audiences]) => (audiences as readonly string[]).includes("cron"))
      .map(([name]) => name);
    expect([...cronAudience].sort()).toEqual(
      [...CRON_ENV_ORDER, "NODE_ENV"].sort()
    );
    expect(SUBPROCESS_ENV.NODE_ENV).toContain("cron");
    expect(CRON_ENV_EXCLUSIONS.has("NODE_ENV")).toBe(true);
    expect(CRON_ENV_NAMES).not.toContain("NODE_ENV");
  });

  test("emits set values in fixed order and excludes unrelated values", () => {
    const env = Object.fromEntries(
      CRON_ENV_ORDER.map((name) => [name, `value-for-${name}`])
    );
    env.NODE_ENV = "production";
    env.ANTHROPIC_API_KEY = "must-not-be-forwarded";
    env.UNRELATED = "must-not-be-forwarded";

    expect(emitEnvironment(env)).toBe(
      `${CRON_ENV_ORDER.map((name) => `${name}="value-for-${name}"`).join("\n")}\n`
    );
  });

  test("appends validated operator extras without forwarding the hatch variable", () => {
    expect(
      emitEnvironment(
        {
          PATH: "/usr/bin",
          CUSTOM_CRON_TOKEN: "custom",
          BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CUSTOM_CRON_TOKEN",
          UNRELATED: "must-not-pass",
        },
        ["CUSTOM_CRON_TOKEN", "CUSTOM_CRON_TOKEN", "bad-name"]
      )
    ).toBe('PATH="/usr/bin"\nCUSTOM_CRON_TOKEN="custom"\n');
  });

  test("omits unset and empty variables like the shell loop", () => {
    expect(
      emitEnvironment({
        PATH: "/usr/bin",
        BRAIN_PATH: "",
        TZ: undefined,
      })
    ).toBe('PATH="/usr/bin"\n');
  });

  test.each([
    ['quote"breakout', "quote"],
    ["line-one\nSMUGGLED=value", "newline"],
    ["carriage\rreturn", "carriage return"],
    ["trailing\\", "backslash"],
    ["nul\0byte", "NUL"],
  ])("rejects an unsafe %s value (%s)", (value) => {
    expect(() => emitEnvironment({ GITHUB_TOKEN: value })).toThrow(
      "cannot emit unsafe /etc/environment value for GITHUB_TOKEN"
    );
  });
});
