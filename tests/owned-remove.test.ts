import { expect, test } from "bun:test";
import { verifyOwnedRemove } from "../scripts/native-proof/verify-owned-remove";
const busy = { startNs: 100, endNs: 200, errno: 16, error: "[Errno 16] busy" };
const success = { startNs: 20_000_200, endNs: 20_000_300, errno: null };
test("owned removal receipt retains EBUSY and accepts only bounded success", () => {
  expect(verifyOwnedRemove({ outcome: "removed", attempts: [busy, success] })).toBe(true);
  expect(verifyOwnedRemove({ outcome: "removed", attempts: [{ startNs: 1, endNs: 2, errno: null }] })).toBe(true);
  for (const value of [undefined, {}, { outcome: "removed", attempts: [] },
    { outcome: "failed", attempts: [busy] },
    { outcome: "removed", attempts: [{ ...busy, errno: 1 }, success] },
    { outcome: "removed", attempts: [busy, { ...success, startNs: 201 }] },
    { outcome: "removed", attempts: [busy, { ...success, startNs: 1_000_000_200, endNs: 1_000_000_300 }] },
    { outcome: "removed", attempts: [busy, { ...success, errno: 16 }] }]) expect(verifyOwnedRemove(value)).toBe(false);
});
test("file-only removal and refusal controls", () => {
  const child = Bun.spawnSync(["python3", "-B", "scripts/native-proof/owned-remove-control.py"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
