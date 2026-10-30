import { expect, test } from "bun:test";
import { join } from "node:path";

test("owned-loop file-only observability controls", () => {
  const child = Bun.spawnSync(["python3", "-I", "-S", join(import.meta.dir, "../scripts/native-proof/loop-evidence-control.py")], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, `OWNED_LOOP_CONTROLS ${child.stderr.toString()}`).toBe(0);
});
