import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { collectorInventoryVariant } from "../scripts/prove-worker-identity.js";
const collector = await Bun.file(new URL("../packages/ui-server/src/brain/maintenance-git-source.ts", import.meta.url)).text();
const host = await Bun.file(new URL("../packages/ui-server/src/brain/maintenance-git.ts", import.meta.url)).text();
test("collector inventory variant pins the original bytes and keeps the original child execution", () => {
  const variant = collectorInventoryVariant(collector, host);
  expect(variant.hashes.originalCollector).toBe(createHash("sha256").update(collector).digest("hex"));
  expect(variant.shim).toContain(variant.hashes.originalCollector);
  expect(variant.shim).toContain('identity !== process.argv[4]');
  expect(variant.shim).toContain('original, ...process.argv.slice(2)');
  expect(variant.shim).toContain('cwd: root, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit"');
  expect(variant.shim).toContain('process.exitCode = code');
  for (const source of [variant.shim, variant.host]) expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
  expect(() => collectorInventoryVariant(collector, host.replace('const entry = Bun.resolveSync', 'const movedEntry = Bun.resolveSync'))).toThrow("anchor changed");
});
test("diagnostic variant forwards only bounded exact inventory metadata to its local artifact", () => {
  const variant = collectorInventoryVariant(collector, host), start = variant.host.indexOf("  // Diagnostic variant only");
  const stop = variant.host.indexOf("  if (result.exitCode !== 0 || result.killed) {", start);
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(variant.host.slice(start, stop));
  const execute = new Function("result", "expectedRoot", "console", "Buffer", body);
  const entry = { name: "odysseus-proof", uid: 21001, gid: 21001, mode: 0o700, dev: "1", ino: "2", type: "directory" };
  const base = { collectorHash: variant.hashes.originalCollector, rootIdentity: "1:2", entries: [entry] };
  const line = (value: unknown) => "LOCAL_FIXTURE_GIT_ROOT " + JSON.stringify(value);
  const output: string[] = [];
  execute({ stderr: line(base) }, "1:2", { error: (value: string) => output.push(value) }, Buffer);
  expect(output).toEqual([line(base)]);
  for (const text of [line({ ...base, private: "Odysseus hidden content" }), line({ ...base, entries: [{ ...entry, private: "Odysseus hidden content" }] }),
    line({ ...base, rootIdentity: "3:4" }), line({ ...base, entries: Array(513).fill(entry) }), "LOCAL_FIXTURE_GIT_ROOT " + "x".repeat(65537),
    "Odysseus hidden content", "LOCAL_FIXTURE_GIT_ROOT not-json"]) {
    output.length = 0; execute({ stderr: text }, "1:2", { error: (value: string) => output.push(value) }, Buffer);
    expect(output, "LOCAL_INVENTORY_REJECTS_ARBITRARY_FIELDS_AND_BYTES").toEqual([]);
  }
});
