import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const files = [
  "packages/ui-react/tests/client-environment.test.ts",
  "packages/ui-react/tests/asr-deepgram.test.ts",
  "packages/ui-kit/tests/ghost-text.test.tsx",
];
const keys = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT", "WebSocket", "MediaRecorder"];

// Run the actual ordered suites with native, absent and readonly descriptors.
// The receipt compares values/getters by identity inside the same child.
for (const initial of ["native", "absent", "readonly"] as const) {
  test(`DOM fixtures restore complete ${initial} global descriptors after the ordered ghost suite`, async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), "odysseus-dom-descriptors-"));
    try {
      const preload = resolve(scratch, "descriptors.ts");
      await writeFile(preload, `
import { afterAll } from "bun:test";
const keys = ${JSON.stringify(keys)};
const initial = ${JSON.stringify(initial)};
if (initial === "absent") for (const key of keys) Reflect.deleteProperty(globalThis, key);
if (initial === "readonly") {
  Object.defineProperty(globalThis, "navigator", { configurable: true, enumerable: false, writable: false, value: globalThis.navigator });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, enumerable: false, get: () => undefined });
}
const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterAll(() => {
  const restored = keys.map(key => {
    const before = saved.get(key), after = Object.getOwnPropertyDescriptor(globalThis, key);
    return { key, equal: before === undefined ? after === undefined : after !== undefined &&
      ["value", "get", "set", "writable", "enumerable", "configurable"].every(field => Object.is(before[field], after[field])) };
  });
  console.log("DOM_DESCRIPTOR_RECEIPT " + JSON.stringify(restored));
});
`);
      const child = Bun.spawn([process.execPath, "run", "test", "--preload", preload, ...files], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode, stdout + stderr).toBe(0);
      expect(stderr).toMatch(/\b59 pass\b/);
      const receipts = stdout.split("\n").filter(line => line.startsWith("DOM_DESCRIPTOR_RECEIPT "));
      expect(receipts).toHaveLength(1);
      expect(JSON.parse(receipts[0]!.slice("DOM_DESCRIPTOR_RECEIPT ".length))).toEqual(keys.map(key => ({ key, equal: true })));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 30_000);
}
