/**
 * `@schlessera/brain/module` (#1397): a module outside this repository can
 * write a document with only the supported entries. The fixture module
 * (tests/fixtures/third-party-module) imports nothing else, and runs through
 * the real loader and CLI as a path module.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const FIXTURE = join(import.meta.dir, "fixtures/third-party-module");
const SUPPORTED = new Set(["@schlessera/brain", "@schlessera/brain/module", "zod"]);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

function brainWithLogbook(): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  cpSync(FIXTURE, join(root, "modules/logbook"), { recursive: true });
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({
    exclude: { dirs: ["modules"] },
    modules: { "./modules/logbook": {} },
  }, null, 2) + "\n");
  return root;
}

test("the fixture module imports only supported entries", () => {
  const source = readFileSync(join(FIXTURE, "module.ts"), "utf8");
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  expect(specifiers).toContain("@schlessera/brain/module");
  expect(specifiers.filter((specifier) => !SUPPORTED.has(specifier))).toEqual([]);
  expect(source).not.toMatch(/import\(|require\(/);
});

test("a third-party-style module writes a document through the real loader", async () => {
  const root = brainWithLogbook();
  const entry = "Raft lashed | sail at dawn <!-- hidden";

  const first = await runCli(root, ["logbook", "ogygia-raft", "2026-07-12", entry, "--json"]);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual({ path: "logbook/ogygia-raft.md" });

  expect(existsSync(join(root, "logbook/ogygia-raft.md"))).toBe(true);
  const written = readFileSync(join(root, "logbook/ogygia-raft.md"), "utf8");
  expect(written).toStartWith("---\ntitle: Logbook ogygia-raft\ntype: logbook\n");
  expect(written).toContain([
    "<!-- brain:generated:logbook-entry -->",
    "",
    "Raft lashed \\| sail at dawn &lt;!-- hidden",
    "",
    "<!-- /brain:generated:logbook-entry -->",
  ].join("\n"));

  const validated = await runCli(root, ["validate", "--json"]);
  expect(validated.code, validated.stderr + validated.stdout).toBe(0);
  expect(JSON.parse(validated.stdout).errors).toBe(0);

  const again = await runCli(root, ["logbook", "ogygia-raft", "2026-07-12", "Overwrite attempt"]);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("logbook/ogygia-raft.md already exists");
  expect(readFileSync(join(root, "logbook/ogygia-raft.md"), "utf8")).toBe(written);
});
