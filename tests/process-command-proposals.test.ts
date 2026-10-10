// The shipped `brain process` command, which the note-disposition eval first
// exercised (#1386 split it from the eval's guard and scorer tests in
// experiments/note-disposition-eval.test.ts). tests/fixtures/note-disposition/
// only builds the brain; the assertions are about what the real command
// proposes and leaves.
import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { prepare } from "./fixtures/note-disposition/prepare";
import { processCommand } from "../packages/core/src/cli/commands/process";
import { indexAll } from "../packages/core/src/lib/indexer";
import { openDatabase } from "../packages/core/src/lib/db";

test("actual process command returns proposals without applying, reading full targets, or validating operation paths", async () => {
  const f = { id: "letter-as-is", group: "letter", source: "harbor sentinel note", target: `harbor sentinel target\n${"An unrelated voyage detail. ".repeat(200)}TARGET-END-BEYOND-SNIPPET` };
  const p = prepare(f);
  const dbPath = join(p.env.root, "brain.db");
  const db = openDatabase(dbPath);
  await indexAll(db, { root: p.env.root, taxonomy: p.env.taxonomy, force: true, quiet: true });
  db.close();
  const output = spyOn(console, "log").mockImplementation(() => {});
  let prompt = "";
  const scripted = { action: "merge", reasoning: "scripted control", operations: [{ op: "update", path: "../outside.md", content: "replacement" }] };
  try {
    await processCommand.run([p.env.source.path], {
      json: true, brain: { root: p.env.root, dbPath, config: p.config, configPath: null, modules: [], taxonomy: p.env.taxonomy },
      completions: { id: "fixture", capabilities: { vision: false }, async complete(input) { prompt = input.prompt; return JSON.stringify(scripted); } },
    });
    expect(prompt).toContain(`(${p.env.targets[0]!.path}):`);
    expect(prompt).toContain(">>>harbor<<< >>>sentinel<<< target");
    expect(prompt).not.toContain("TARGET-END-BEYOND-SNIPPET");
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(scripted);
    expect(readFileSync(join(p.env.root, p.env.source.path), "utf8")).toBe(p.env.source.raw);
    expect(readFileSync(join(p.env.root, p.env.targets[0]!.path), "utf8")).toBe(p.env.targets[0]!.raw);
  } finally { output.mockRestore(); p.close(); }
});
