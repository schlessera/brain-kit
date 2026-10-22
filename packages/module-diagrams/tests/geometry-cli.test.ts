import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";

test("check names an edge whose tiny endpoint has no legal connector port", async () => {
  const root = makeTempBrain({ empty: true });
  try {
    writeFileSync(join(root, "brain.config.ts"), `import {defineConfig} from "@schlessera/brain";export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});\n`);
    const file = join(root, "homecoming.diagram.yaml");
    writeFileSync(file, JSON.stringify({ schema_version: 1, type: "architecture", title: "Word reaches Ithaca", desc: "Odysseus sends word home.", size: "doc-inline", nodes: [
      { id: "raft", label: "Raft", at: [40, 120], size: [4, 4] },
      { id: "ithaca", label: "Ithaca", at: [320, 120], size: [148, 64] },
    ], edges: [{ id: "homecoming", from: "raft", to: "ithaca", label: "WORD" }] }));
    const output = await runCli(root, ["diagram", "check", file, "--json"]);
    expect(output.code, "DIAGRAM_UNROUTABLE_EDGE: " + output.stdout + output.stderr).toBe(1);
    const result = JSON.parse(output.stdout);
    expect(result.errors).toContainEqual(expect.objectContaining({ path: "$.edges[0]", code: "unroutable", message: expect.stringContaining("homecoming") }));
  } finally { cleanup(root); }
});
