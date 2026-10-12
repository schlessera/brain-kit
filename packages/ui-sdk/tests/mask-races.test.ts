import { expect, test } from "bun:test";

const child = new URL("./mask-race-child.ts", import.meta.url).pathname;

for (const writer of ["scratch", "ordinary"] as const) {
  for (const stage of ["temp-open", "rename", "cleanup", "mkdir", "directory-open"] as const) {
    test(`${writer} mask fallback ${stage} swap leaves every outside byte and directory unchanged`, () => {
      const result = Bun.spawnSync([process.execPath, "test", "--timeout", "30000", child], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MASK_RACE_STAGE: stage, MASK_RACE_WRITER: writer } });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).not.toContain("error:");
      const receipt = JSON.parse(result.stdout.toString().split("\n").find((line) => line.startsWith("{"))!);
      expect(receipt.injected).toBe(true);
      expect(receipt.outsideOperations).toEqual([]);
      expect(receipt.actualOutside).toEqual(receipt.expectedOutside);
      expect(receipt.error).toBeString();
    });
  }
}

test("scratch ignore check's mkdir swap never creates an outside scratch directory", () => {
  const result = Bun.spawnSync([process.execPath, "test", "--timeout", "30000", child], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MASK_RACE_STAGE: "ignore-mkdir", MASK_RACE_WRITER: "scratch" } });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain("error:");
  const receipt = JSON.parse(result.stdout.toString().split("\n").find((line) => line.startsWith("{"))!);
  expect(receipt.injected).toBe(true);
  expect(receipt.outsideOperations).toEqual([]);
  expect(receipt.actualOutside).toEqual(receipt.expectedOutside);
  expect(receipt.error).toBeString();
});


// These exercise the platform refusal using real Linux fixture files; they
// do not claim a qualified native macOS runtime or descriptor implementation.
for (const writer of ["scratch", "ordinary"] as const) test(`${writer} direct scratch fallback refuses a simulated non-Linux host before any scratch mutation`, () => {
  const result = Bun.spawnSync([process.execPath, "test", "--timeout", "30000", child], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MASK_RACE_STAGE: "nonlinux-refusal", MASK_RACE_WRITER: writer } });
  expect(result.exitCode).toBe(0);
  const receipt = JSON.parse(result.stdout.toString().split("\n").find((line) => line.startsWith("{"))!);
  expect(receipt.outsideOperations).toEqual([]);
  expect(receipt.actualOutside).toEqual(receipt.expectedOutside);
  expect(receipt.error).toContain("requires Linux descriptor paths");
  expect(receipt.injected).toBe(false);
});

test("ordinary non-scratch fallback preserves bytes on the simulated non-Linux branch", () => {
  const result = Bun.spawnSync([process.execPath, "test", "--timeout", "30000", child], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MASK_RACE_STAGE: "nonlinux-ordinary", MASK_RACE_WRITER: "ordinary" } });
  expect(result.exitCode).toBe(0);
  const receipt = JSON.parse(result.stdout.toString().split("\n").find((line) => line.startsWith("{"))!);
  expect(receipt.error).toBeNull();
  expect(receipt.savedBytes).toBe("0b16212c");
  expect(receipt.outsideOperations).toEqual([]);
});

for (const stage of ["write-error", "stat-error"] as const) test(`scratch fallback ${stage} closes every held descriptor and leaves no temporary file`, () => {
  const result = Bun.spawnSync([process.execPath, "test", "--timeout", "30000", child], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MASK_RACE_STAGE: stage, MASK_RACE_WRITER: "scratch" } });
  expect(result.exitCode).toBe(0);
  const receipt = JSON.parse(result.stdout.toString().split("\n").find((line) => line.startsWith("{"))!);
  expect(receipt.injected).toBe(true);
  expect(receipt.outsideOperations).toEqual([]);
  expect(receipt.remainingTemps).toEqual([]);
  expect(receipt.afterDescriptors).toBe(receipt.beforeDescriptors);
  expect(receipt.error).toContain("fixture");
});


for (const stage of ["scratch-root", "scratch-traversal"] as const) test(`scratch fallback ${stage} refuses before temporary bytes can leave scratch`, () => {
  const result = Bun.spawnSync([process.execPath, "test", "--timeout", "30000", child], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MASK_RACE_STAGE: stage, MASK_RACE_WRITER: "scratch" } });
  expect(result.exitCode).toBe(0);
  const receipt = JSON.parse(result.stdout.toString().split("\n").find((line) => line.startsWith("{"))!);
  expect(receipt.outsideOperations).toEqual([]);
  expect(receipt.error).toBeString();
});
