import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
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
      "usage: brain-ui-cron run <job-name> -- <command...> | digest\n"
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
});
