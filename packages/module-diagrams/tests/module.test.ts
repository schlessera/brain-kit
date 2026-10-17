import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";
import manifest, { configSchema } from "../src/module.js";

test("the enabled module lints and exposes diagram validation help", async () => {
  const root = makeTempBrain({ empty: true });
  try {
    writeFileSync(join(root, "brain.config.ts"), `import { defineConfig } from "@schlessera/brain";
export default defineConfig({ modules: { "@schlessera/brain-module-diagrams": {} } });\n`);
    const lint = await runCli(root, ["module", "lint", "diagrams"]);
    expect(lint.code, lint.stderr + lint.stdout).toBe(0);
    const help = await runCli(root, ["diagram", "--help"]);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("check <file|->");
    const unavailable = await runCli(root, ["diagram", "render", "odysseus.yaml"]);
    expect(unavailable.code).toBe(1);
    expect(JSON.parse(unavailable.stdout).errors[0].code).toBe("usage");
    expect(configSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(Object.keys(manifest.setup({}).commands!)).toEqual(["diagram"]);
  } finally { cleanup(root); }
});

test("review procedure and pin preserve the approved upstream provenance", () => {
  const root = resolve(import.meta.dir, "..");
  const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
  expect(pin).toEqual({ repository: "https://github.com/cathrynlavery/diagram-design", commit: "b46c9701f035844a20b13ab0551315977188933b", date: "2026-10-16", plugin_version: "2.6.107" });
  const procedure = readFileSync(join(root, "UPSTREAM.md"), "utf8");
  for (const rule of ["New diagram type", "Rule or budget change", "Checker fix", "Skin, font, icon, export or import change", "Re-author, never copy", "A review that adopts nothing still moves the pin", "Upstream HTML is never vendored"])
    expect(procedure).toContain(rule);
  expect(readFileSync(resolve(root, "../../docs/plans/module-renderers.md"), "utf8")).toContain("../../packages/module-diagrams/UPSTREAM.md");
});
