import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { watchdogMs } from "../../../scripts/test-deadlines.js";

test("a later confirmed exposure refuses boot after an earlier private path cannot be scanned", () => {
  const root = mkdtempSync("/var/tmp/odysseus-state-precedence-"), brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state); mkdirSync(join(brain, "exposed")); writeFileSync(join(state, "object"), "private state");
  try {
    const program = `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const original = fs.readdirSync;
      let calls = 0;
      mock.module("node:fs", () => ({...fs, readdirSync(path, options) {
        if (fs.realpathSync(path) === ${JSON.stringify(state)}) { calls++; throw Object.assign(Error("fixture scan unavailable"), {code:"EIO"}); }
        return original(path, options);
      }}));
      const {assertOperationalStateOutsideBrain} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/brain/operational-state.ts"))});
      let refusal;
      try { assertOperationalStateOutsideBrain({brainPath:${JSON.stringify(brain)},privateStatePaths:[{setting:"first",path:${JSON.stringify(state)}},{setting:"exposed",path:${JSON.stringify(join(brain, "exposed"))}}]}); }
      catch (error) { refusal = {name:error.name,...error.status}; }
      console.log(JSON.stringify({refusal,calls}));`;
    const child = Bun.spawnSync([process.execPath, "--preload", resolve(import.meta.dir, "../../../scripts/test-network-child-preload.ts"), "-e", program], { env: { PATH: "/usr/bin:/bin" }, timeout: watchdogMs(30_000) });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const receipt = JSON.parse(child.stdout.toString());
    expect(receipt.refusal, "CONFIRMED_EXPOSURE_WINS_OVER_EARLIER_INCOMPLETE_SCAN").toMatchObject({ name: "OperationalStateInBrainError", reason: "private_state_in_brain", detail: expect.stringContaining("exposed resolves inside") });
    expect(receipt.calls, "EARLIER_SCAN_RETRY_REMAINS_BOUNDED").toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
