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
  test("the version probe and rewrite hook both receive only the resolved child environment", async () => {
    directory = mkdtempSync(join(tmpdir(), "ui-sdk-rtk-env-"));
    const tracePath = join(directory, "trace");
    const rtkPath = join(directory, "rtk");
    writeFileSync(
      rtkPath,
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$1" "\${ADMITTED_TOKEN-unset}" "\${SERVER_SECRET-unset}" >> '${tracePath}'\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf '%s\\n' '{"hookSpecificOutput":{"updatedInput":{"command":"rtk git status"}}}'\n`,
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
