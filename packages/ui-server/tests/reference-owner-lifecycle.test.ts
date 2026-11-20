import { expect, test } from "bun:test";
import { readdirSync, readlinkSync } from "node:fs";
import { httpContractApp } from "./helpers/http-contract-app";

function rootDescriptors(root: string): string[] {
  return readdirSync("/proc/self/fd").filter(fd => {
    try { return readlinkSync(`/proc/self/fd/${fd}`) === root; } catch { return false; }
  });
}

test("normal app shutdown releases the policy-root continuity descriptor on every create/close cycle", async () => {
  for (let cycle = 0; cycle < 2; cycle++) {
    const t = await httpContractApp();
    try {
      expect(rootDescriptors(t.brainPath).length, "RUNNING_APP_HOLDS_POLICY_ROOT_CONTINUITY").toBeGreaterThan(0);
      await t.app.close();
      expect(rootDescriptors(t.brainPath), "NORMAL_APP_CLOSE_RELEASES_POLICY_ROOT_CONTINUITY").toEqual([]);
    } finally { await t.close(); }
  }
});
