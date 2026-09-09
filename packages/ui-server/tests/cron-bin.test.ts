import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { createUiDb } from "../src/db/client";

const BIN = resolve(import.meta.dir, "../src/bin/brain-ui-cron.ts");
let directory: string;
let dbPath: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "brain-ui-cron-bin-"));
  dbPath = join(directory, "brain-ui.db");
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("brain-ui-cron subprocess", () => {
  test("run records a row and returns the child's exit code", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const proc = Bun.spawn(
      [bun, BIN, "run", "smoke", "--", bun, "-e", "console.log('cron smoke'); process.exit(7)"],
      {
        env: { ...process.env, DB_PATH: dbPath },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    expect(await proc.exited).toBe(7);
    expect(await new Response(proc.stdout).text()).toBe("cron smoke\n");
    const db = createUiDb(dbPath);
    const row = db
      .query("SELECT job_name, status, error_message FROM cron_runs WHERE job_name = ?")
      .get("smoke") as { job_name: string; status: string; error_message: string };
    expect(row.job_name).toBe("smoke");
    expect(row.status).toBe("error");
    expect(row.error_message).toBe("exit code 7");
    db.close();
  });

  test("no arguments prints usage on stderr and exits 2", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const proc = Bun.spawn([bun, BIN], { stdout: "pipe", stderr: "pipe" });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe(
      "usage: brain-ui-cron run <job-name> -- <command...>\n" +
        "       brain-ui-cron digest\n" +
        "       brain-ui-cron crontab [--wrapper-command <command>] [--digest-command <command>] [--path-line <line>] [--user <user>]\n" +
        "       brain-ui-cron environment\n"
    );
  });

  test("an unknown subcommand prints usage on stderr and exits 2", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const proc = Bun.spawn([bun, BIN, "unknown"], { stdout: "pipe", stderr: "pipe" });

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toContain("usage: brain-ui-cron run");
  });

  test("environment emits only the resolved cron audience", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const path = process.env.PATH ?? "/usr/bin";
    const proc = Bun.spawn([bun, BIN, "environment"], {
      env: {
        PATH: path,
        BRAIN_PATH: "/data/example-brain",
        NODE_ENV: "production",
        GITHUB_TOKEN: "example-token",
        ANTHROPIC_API_KEY: "excluded-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(
      `PATH="${path}"\nBRAIN_PATH="/data/example-brain"\nGITHUB_TOKEN="example-token"\n`
    );
    expect(await new Response(proc.stderr).text()).toBe("");
  });

  test("crontab reads the resolved brain path and honors every deployment flag", async () => {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const brainRoot = join(directory, "brain-root");
    mkdirSync(join(brainRoot, "scripts", "jobs"), { recursive: true });
    writeFileSync(join(brainRoot, "scripts", "jobs", "scrape-all.ts"), "");
    const fakeBrain = join(directory, "brain");
    writeFileSync(
      fakeBrain,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"enabled":[],"available":[]}\'\n'
    );
    chmodSync(fakeBrain, 0o755);

    const proc = Bun.spawn(
      [
        bun,
        BIN,
        "crontab",
        "--wrapper-command",
        "/absolute/brain-ui-cron run",
        "--digest-command",
        "/absolute/brain-ui-cron digest",
        "--path-line",
        "PATH=/custom/bin",
        "--user",
        "cronuser",
      ],
      {
        env: {
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          BRAIN_PATH: brainRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    expect(await proc.exited).toBe(0);
    const output = await new Response(proc.stdout).text();
    expect(output).toContain("PATH=/custom/bin\n");
    expect(output).toContain(
      "cronuser cd /data/brain && /absolute/brain-ui-cron run sync --"
    );
    expect(output).toContain(
      "/absolute/brain-ui-cron run digest -- /absolute/brain-ui-cron digest"
    );
    expect(output).not.toContain("module list unavailable");
    expect(output).toContain("bun scripts/jobs/scrape-all.ts --api-only");
    expect(await new Response(proc.stderr).text()).toBe("");
  });

  /**
   * The bash tested `[ -f … ]`, true only for a regular file. A plain
   * existence check would also accept a directory and put a root cron line in
   * the crontab that the shell has always skipped.
   */
  async function crontabWithScraperAt(
    setup: (jobsDir: string) => void
  ): Promise<string> {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const brainRoot = mkdtempSync(join(directory, "legacy-"));
    const jobsDir = join(brainRoot, "scripts", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    setup(jobsDir);
    const fakeBrain = join(directory, "brain");
    writeFileSync(
      fakeBrain,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"enabled":[],"available":[]}\'\n'
    );
    chmodSync(fakeBrain, 0o755);

    const proc = Bun.spawn([bun, BIN, "crontab"], {
      env: {
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        BRAIN_PATH: brainRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    return await new Response(proc.stdout).text();
  }

  test("the legacy scraper fallback fires for a regular file", async () => {
    const output = await crontabWithScraperAt((jobsDir) => {
      writeFileSync(join(jobsDir, "scrape-all.ts"), "");
    });
    expect(output).toContain("bun scripts/jobs/scrape-all.ts --api-only");
  });

  test("a DIRECTORY at the scraper path does not schedule a root job", async () => {
    const output = await crontabWithScraperAt((jobsDir) => {
      mkdirSync(join(jobsDir, "scrape-all.ts"));
    });
    expect(output).not.toContain("scrape-all.ts --api-only");
  });

  test("a missing scraper path does not schedule a root job", async () => {
    const output = await crontabWithScraperAt(() => {});
    expect(output).not.toContain("scrape-all.ts --api-only");
  });

  test("a symlink to a regular file still counts as present", async () => {
    const output = await crontabWithScraperAt((jobsDir) => {
      const real = join(jobsDir, "real-scraper.ts");
      writeFileSync(real, "");
      symlinkSync(real, join(jobsDir, "scrape-all.ts"));
    });
    expect(output).toContain("bun scripts/jobs/scrape-all.ts --api-only");
  });
});
