import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { digestRetentionFloor, generateActivityDigest } from "../src/activity/digest";
import { runDigest } from "../src/cron/digest";
import { createUiDb } from "../src/db/client";

function textSink() {
  let text = "";
  return {
    sink: { write(chunk: string) { text += chunk; } },
    read: () => text,
  };
}

describe("cron digest", () => {
  test("success advances covered-until and returns zero", () => {
    const stdout = textSink();
    const stderr = textSink();
    const directory = mkdtempSync(join(tmpdir(), "brain-ui-cron-digest-"));
    const dbPath = join(directory, "brain-ui.db");
    const now = 1_700_000_000_000;

    const exitCode = runDigest(
      { dbPath, stdout: stdout.sink, stderr: stderr.sink },
      {
        generateDigest: (opened) => generateActivityDigest(opened, now),
      }
    );

    expect(exitCode).toBe(0);
    const db = createUiDb(dbPath);
    expect(digestRetentionFloor(db)).toBe(now);
    db.close();
    rmSync(directory, { recursive: true, force: true });
    expect(stdout.read()).toBe("[brain-digest] generated: 0 runs, 0 failures, $0.00\n");
    expect(stderr.read()).toBe("");
  });

  test("an unsupported digest implementation fails loud", () => {
    const stderr = textSink();
    const exitCode = runDigest(
      { dbPath: ":memory:", stdout: textSink().sink, stderr: stderr.sink },
      {
        generateDigest() {
          throw new Error("digest support unavailable");
        },
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("[brain-digest] failed: digest support unavailable");
  });

  test("a database failure fails loud", () => {
    const stderr = textSink();
    const exitCode = runDigest(
      { dbPath: "unopenable", stderr: stderr.sink },
      {
        createDb() {
          throw new Error("cannot open database");
        },
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain("[brain-digest] failed: cannot open database");
  });
});
