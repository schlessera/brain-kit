import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { join, resolve } from "node:path";

for (const side of ["private", "brain"] as const) for (const operation of ["rename", "remove", "persistent failure"] as const) {
  test(`alias verification contains ${side} ${operation} between readdir and lstat`, () => {
    const root = mkdtempSync("/var/tmp/odysseus-alias-race-");
    const brain = join(root, "brain"), state = join(root, "state"), source = join(side === "private" ? state : brain, "a-object");
    mkdirSync(brain); mkdirSync(state); mkdirSync(join(side === "private" ? state : brain, "0-quarantine"));
    writeFileSync(source, "private journal object");
    if (operation === "rename" || operation === "remove" && side === "brain") linkSync(source, join(side === "private" ? brain : state, "alias"));
    if (operation === "persistent failure" && side === "brain") {
      writeFileSync(join(state, "outside"), "private state"); linkSync(join(state, "outside"), join(root, "outside-alias"));
    }
    try {
      const program = `
        import * as fs from "node:fs";
        import { mock } from "bun:test";
        const original = fs.readdirSync, originalStat = fs.lstatSync, target = ${JSON.stringify(side === "private" ? state : brain)};
        let calls = 0, moved = false, broken = true;
        mock.module("node:fs", () => ({ ...fs, readdirSync(path, options) {
          const entries = original(path, options);
          if (fs.realpathSync(path) === target && entries.some(name => String(name) === "a-object")) {
            calls++;
            if (broken && ${JSON.stringify(operation)} === "persistent failure") throw Object.assign(Error("fixture state I/O unavailable"), {code:"EIO"});
          }
          // Visit quarantine first, so skipping a vanished source would miss it.
          return entries.sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        }, lstatSync(path, options) {
          const name = String(path);
          if (!moved && ${JSON.stringify(operation)} !== "persistent failure" && name.endsWith("/a-object") && fs.realpathSync(name.slice(0, -9)) === target) {
            moved = true;
            if (${JSON.stringify(operation)} === "remove") fs.unlinkSync(${JSON.stringify(source)});
            else fs.renameSync(${JSON.stringify(source)}, target + "/0-quarantine/moved");
          }
          return originalStat(path, options);
        }}));
        const { operationalStateRefusal, assertOperationalStateOutsideBrain } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/brain/operational-state.ts"))});
        let result, error;
        try { result = operationalStateRefusal({brainPath:${JSON.stringify(brain)},privateStatePaths:[{setting:"journal",path:${JSON.stringify(state)}}]}); }
        catch (failure) { error = String(failure); }
        const attempts = calls;
        let bootError;
        try { if (${JSON.stringify(operation)} === "persistent failure") assertOperationalStateOutsideBrain({brainPath:${JSON.stringify(brain)},privateStatePaths:[{setting:"journal",path:${JSON.stringify(state)}}]}); }
        catch (failure) { bootError = {name:failure.name,cause:failure.cause?.message}; }
        broken = false;
        const recovered = operationalStateRefusal({brainPath:${JSON.stringify(brain)},privateStatePaths:[{setting:"journal",path:${JSON.stringify(state)}}]});
        console.log(JSON.stringify({result,error,calls:attempts,moved,bootError,recovered}));`;
      const child = Bun.spawnSync([process.execPath, "--preload", resolve(import.meta.dir, "../../../scripts/test-network-child-preload.ts"), "-e", program], { env: { PATH: "/usr/bin:/bin" }, timeout: watchdogMs(30_000) });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const receipt = JSON.parse(child.stdout.toString());
      expect(receipt.error, "ALIAS_CHURN_NEVER_ESCAPES_STATUS_OR_ADMISSION").toBeUndefined();
      if (operation === "persistent failure") {
        expect(receipt.result, "UNVERIFIED_STATE_REFUSES_BRAIN_READS").toMatchObject({ available: false, reason: "private_state_unverified", detail: expect.stringContaining("fixture state I/O unavailable") });
        expect(receipt.calls, "ALIAS_RETRY_IS_BOUNDED").toBe(3);
        expect(receipt.bootError, "PERSISTENT_UNCERTAINTY_REFUSES_BOOT_WITH_CAUSE").toMatchObject({ name: "OperationalStateAliasVerificationUnavailable", cause: "fixture state I/O unavailable" });
        expect(receipt.recovered, "NEXT_CHECK_AUTOMATICALLY_VERIFIES_WITHOUT_A_LIVE_ALIAS").toBeUndefined();
      } else if (operation === "rename") {
        expect(receipt.result, "MOVED_ALIAS_IS_STILL_CHECKED").toMatchObject({ available: false, reason: "private_state_in_brain" });
        expect(receipt.moved).toBe(true);
      } else expect(receipt.result, "REMOVED_ENTRY_RESCANS_AND_RECOVERS").toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
