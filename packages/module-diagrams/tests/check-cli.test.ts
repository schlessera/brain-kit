import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";

test("diagram check validates an actual standalone v1 spec through the enabled CLI", async () => {
  const root = makeTempBrain({ empty: true });
  try {
    writeFileSync(join(root, "brain.config.ts"), `import {defineConfig} from "@schlessera/brain"; export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});\n`);
    const file = join(root, "homecoming.diagram.yaml");
    writeFileSync(file, "schema_version: 1\ntype: architecture\ntitle: The homecoming relay\ndesc: Odysseus sends word to Ithaca.\nsize: doc-inline\nnodes:\n  - id: raft\n    label: The raft\n    at: [40, 120]\n    size: [148, 64]\nedges: []\n");
    const result = await runCli(root, ["diagram", "check", file, "--json"]);
    expect(result.code, "DIAGRAM_CHECK_STANDALONE_V1: " + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, valid: true, type: "architecture", errors: [], warnings: [] });
  } finally { cleanup(root); }
});

test("real CLI family fixtures preserve invalid envelopes and read one fence from stdin", async () => {
  const { BRAIN_BIN, keylessEnv } = await import("../../core/tests/cli-harness.js");
  const root = makeTempBrain({ empty: true });
  try {
    writeFileSync(join(root, "brain.config.ts"), `import {defineConfig} from "@schlessera/brain"; export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});\n`);
    const expected = await Bun.file(new URL("./fixtures/check-results.json", import.meta.url)).json();
    for (const name of ["free-valid", "free-invalid", "axis-valid", "axis-invalid", "fixed-valid", "fixed-invalid"]) {
      const file = new URL(`./fixtures/${name}.diagram.yaml`, import.meta.url).pathname;
      const result = await runCli(root, ["diagram", "check", file, "--json"]);
      expect(result.code, name + result.stderr).toBe(expected[name].valid ? 0 : 1);
      expect(JSON.parse(result.stdout), name).toEqual(expected[name]);
    }
    const source = await Bun.file(new URL("./fixtures/axis-valid.diagram.yaml", import.meta.url)).text();
    const proc = Bun.spawn([process.execPath, BRAIN_BIN, "diagram", "check", "-", "--json"], { env: keylessEnv(root), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await proc.stdin.write("# The homecoming\n\n```diagram\n" + source + "```\n"); await proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr + stdout).toBe(0); expect(JSON.parse(stdout)).toEqual(expected["axis-valid"]);
    const missing = await runCli(root, ["diagram", "check", "missing.diagram.yaml", "--json"]);
    expect(missing.code).toBe(1); expect(JSON.parse(missing.stdout)).toMatchObject({ schema_version: 1, valid: false, type: null, errors: [{ path: "$", code: "input" }], warnings: [] });
    const human = await runCli(root, ["diagram", "check", new URL("./fixtures/free-valid.diagram.yaml", import.meta.url).pathname, "--human"]);
    expect(human.code, human.stderr).toBe(0); expect(human.stdout).toContain("Diagram is valid.");
  } finally { cleanup(root); }
});
