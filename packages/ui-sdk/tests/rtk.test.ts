import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resetRtkProbe, rtkRewriteCommand } from "../src/server/rtk.js";

let directory: string | undefined;

// Earlier backend tests can warm the process-wide probe. This test needs to
// observe its own fake binary's version call, not reuse that earlier answer.
beforeEach(resetRtkProbe);

afterEach(() => {
  resetRtkProbe();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("rtk subprocess environment", () => {
  test("an oracle closing stdin keeps the parent alive and falls back before its late reply", async () => {
    directory = mkdtempSync(join(tmpdir(), "ui-sdk-rtk-pipe-"));
    const binary = join(directory, "rtk");
    const closed = join(directory, "closed");
    writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nexec 0<&-\ntouch '${closed}'\nsleep 0.05\nprintf '%s\\n' '{"hookSpecificOutput":{"updatedInput":{"command":"rtk git status"}}}'\n`);
    chmodSync(binary, 0o755);
    const probe = join(directory, "probe.ts");
    // Keep the real request/spawn/stream, but order the native read-end closure
    // before the helper returns to the production writer. No timing inference.
    writeFileSync(probe, `import { existsSync } from "node:fs";
const cp = require("node:child_process");
const execFile = cp.execFile;
let closedBeforeDelivery = false;
let hookResult;
let hookFinished;
const hookDone = new Promise(resolve => { hookFinished = resolve; });
cp.execFile = (...args) => {
  if (args[1][0] === "hook") {
    const callback = args[args.length - 1];
    args[args.length - 1] = (error, stdout, stderr) => {
      hookResult = { failed: !!error, reply: stdout.trim() };
      callback(error, stdout, stderr);
      hookFinished();
    };
  }
  const child = execFile(...args);
  if (args[1][0] === "hook") {
    const deadline = Date.now() + 1000;
    while (!existsSync(${JSON.stringify(closed)})) {
      if (Date.now() > deadline) throw new Error("oracle did not close stdin");
      Bun.sleepSync(1);
    }
    closedBeforeDelivery = true;
  }
  return child;
};
const { rtkRewriteCommand } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/rtk.ts"))});
const original = "echo " + "x".repeat(1024 * 1024);
const command = await rtkRewriteCommand(original, { PATH: ${JSON.stringify(`${directory}:/usr/bin:/bin`)} });
await hookDone;
console.log(JSON.stringify({ same: command === original, length: original.length, closedBeforeDelivery, hookResult }));
`);
    const child = Bun.spawn([process.execPath, probe], {
      cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      same: true, length: 1024 * 1024 + 5, closedBeforeDelivery: true,
      hookResult: {
        failed: false,
        reply: '{"hookSpecificOutput":{"updatedInput":{"command":"rtk git status"}}}',
      },
    });
    expect(stderr).not.toContain("EPIPE");
  });

  test("the version probe and rewrite hook both receive only the resolved child environment", async () => {
    directory = mkdtempSync(join(tmpdir(), "ui-sdk-rtk-env-"));
    const tracePath = join(directory, "trace");
    const rtkPath = join(directory, "rtk");
    writeFileSync(
      rtkPath,
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$1" "\${ADMITTED_TOKEN-unset}" "\${SERVER_SECRET-unset}" >> '${tracePath}'\nif [ "$1" = "--version" ]; then exit 0; fi\ncat > /dev/null\nprintf '%s\\n' '{"hookSpecificOutput":{"updatedInput":{"command":"rtk git status"}}}'\n`,
      "utf8"
    );
    chmodSync(rtkPath, 0o755);

    const childEnv = {
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      ADMITTED_TOKEN: "admitted",
    };
    const previousServerSecret = process.env.SERVER_SECRET;
    process.env.SERVER_SECRET = "must-not-pass";
    try {
      expect(await rtkRewriteCommand("git status", childEnv)).toBe(
        "rtk git status"
      );
      expect(readFileSync(tracePath, "utf8")).toBe(
        "--version|admitted|unset\nhook|admitted|unset\n"
      );
    } finally {
      if (previousServerSecret === undefined) delete process.env.SERVER_SECRET;
      else process.env.SERVER_SECRET = previousServerSecret;
    }
  });
});
