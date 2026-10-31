import { expect, test } from "bun:test";
import { join } from "node:path";

test("owned-loop file-only observability controls", () => {
  const child = Bun.spawnSync(["python3", "-I", "-S", join(import.meta.dir, "../scripts/native-proof/loop-evidence-control.py"), "Controls"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, `OWNED_LOOP_CONTROLS ${child.stderr.toString()}`).toBe(0);
});

test("owned-loop lowest-layer append writer protocol", () => {
  const child = Bun.spawnSync(["python3", "-I", "-S", join(import.meta.dir, "../scripts/native-proof/loop-evidence-control.py"), "WriterControls"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, `TRACEFS_WRITER_PROTOCOL ${child.stderr.toString()}`).toBe(0);
});
