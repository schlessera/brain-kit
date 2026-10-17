import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerChildLine } from "../../ui-sdk/tests/maintenance-temp-ledger-protocol";

const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// These are controlled input failures, not an explanation of historical CI EOF.
for (const fault of ["native-fixture", "db-open"] as const) test(`actual boundary child exposes controlled ${fault} failure before its receipt`, async () => {
  const root = mkdtempSync("/tmp/odysseus-boundary-diagnostic-"); roots.push(root);
  const brain = join(root, "brain"), state = join(root, "state"), temporary = join(root, "temporary");
  for (const directory of [brain, state, temporary]) mkdirSync(directory);
  const dbPath = join(state, "ui.db");
  if (fault === "db-open") writeFileSync(dbPath, "controlled invalid SQLite input");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "maintenance-temp-boundary-child.ts"), brain,
    join(brain, "must-not-run"), "cron", JSON.stringify({ allowanceBytes: 268435456, budgetBytes: 268435456 }), dbPath], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TMPDIR: fault === "native-fixture" ? join(root, "absent") : temporary },
  });
  children.push(child);
  let failure: Error | undefined;
  try { await ledgerChildLine(child, "controlled startup"); }
  catch (error) { failure = error as Error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure!.cause)).toBe("Error: owned ledger child exited before its receipt: ");
  const evidence = JSON.parse(failure!.message.slice(failure!.message.indexOf("{"))) as {
    exitStatus: number; signalCode: string | null; stdout: string; stderr: string;
  };
  expect(evidence.exitStatus).toBe(1);
  expect(evidence.signalCode).toBeNull();
  expect(evidence.stdout).toBe("");
  expect(evidence.stderr).toContain(`maintenance-boundary phase=${fault}`);
  expect(evidence.stderr).toContain(fault === "native-fixture" ? "ENOENT" : "file is not a database");
  expect(await child.exited).toBe(1);
});
