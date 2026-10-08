import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeTempBrain, runCli } from "../../core/tests/cli-harness.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
const URL = "https://www.youtube.com/watch?v=Odysseus001";
function fixture(options: { capability?: boolean; builtin?: boolean; declared?: boolean; dormant?: boolean; answer?: string; emptyAnswer?: boolean } = {}) {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  writeFileSync(join(root, "brain.config.ts"), `
import { defineConfig } from "@schlessera/brain";
import { join } from "node:path";
export default defineConfig({
  skills: { emitters: ["codex"] },
  ${options.builtin ? "" : `completions: { provider: {
    id: "gemini:fictional-model", capabilities: { vision: true, video: ${options.capability ?? true} },
    async complete(req) {
      console.error("fictional-provider-invoked");
      await Bun.write(join(${JSON.stringify(root)}, "request.json"), JSON.stringify({ prompt: req.prompt, parts: req.parts }));
      return ${JSON.stringify(options.emptyAnswer ? "" : options.answer ?? "00:10 Odysseus checks the supplies.")};
    },
  } },`}
  modules: ${options.declared === false ? "{}" : `{ "@schlessera/brain-module-video": { ${options.dormant ? "enabled: false" : ""} } }`},
});
`);
  return root;
}

describe("real brain video CLI", () => {
  test("pins success JSON, verbatim question, clip and disclosure before completion", async () => {
    const root = fixture();
    const question = 'What does Odysseus mean by "ready"?';
    const result = await runCli(root, ["video", "watch", URL, "--question", question, "--start", "0:00", "--end", "2:00", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      source: { kind: "youtube", url: URL, path: null, title: null, durationSeconds: null },
      engine: "gemini", model: "fictional-model", clip: { start: 0, end: 120 },
      answer: "00:10 Odysseus checks the supplies.", timestamps: ["00:10"],
      warnings: ["Source title and duration are unavailable; they were not inferred from model observations."],
    });
    expect(JSON.parse(readFileSync(join(root, "request.json"), "utf8"))).toEqual({
      prompt: question, parts: [{ kind: "video", uri: URL, mimeType: "video/mp4", clip: { start: 0, end: 120 } }],
    });
    expect(result.stderr).toContain("Google receives");
    expect(result.stderr).toContain("training");
    expect(result.stderr.indexOf("Google receives")).toBeLessThan(result.stderr.indexOf("fictional-provider-invoked"));
  });
  test("local source is an explicit root-relative path and filename, not guessed metadata", async () => {
    const root = fixture(); writeFileSync(join(root, "odysseus.mp4"), "fictional video");
    const result = await runCli(root, ["video", "watch", "odysseus.mp4", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).source).toEqual({ kind: "file", url: null, path: "odysseus.mp4", title: "odysseus.mp4", durationSeconds: null });
    expect(JSON.parse(readFileSync(join(root, "request.json"), "utf8")).parts[0]).toEqual({ kind: "video", path: join(root, "odysseus.mp4"), mimeType: "video/mp4" });
  });
  test("missing GEMINI_API_KEY names environment variable and module docs", async () => {
    const root = fixture({ builtin: true });
    const result = await runCli(root, ["video", "watch", URL, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("GEMINI_API_KEY");
    expect(result.stderr).toContain("packages/module-video/README.md");
  });
  test("configured incompatible provider refuses before invoking completion", async () => {
    const root = fixture({ capability: false });
    const result = await runCli(root, ["video", "watch", URL, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not support video");
    expect(existsSync(join(root, "request.json"))).toBe(false);
    expect(result.stdout).toBe("");
  });
  test("undeclared module contributes no namespace, watch skill or instructions", async () => {
    const root = fixture({ declared: false });
    const help = await runCli(root, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toMatch(/^\s+video\s/m);
    const sync = await runCli(root, ["skills", "sync", "--json"]);
    expect(sync.code, sync.stderr).toBe(0);
    expect(existsSync(join(root, ".agents/skills/watch"))).toBe(false);
    const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(instructions).not.toContain("The video module is enabled");
  });
  test("active skill lints and disappears on dormancy with its instruction block", async () => {
    const root = fixture();
    const sync = await runCli(root, ["skills", "sync", "--json"]);
    expect(sync.code, sync.stderr).toBe(0);
    expect(existsSync(join(root, ".agents/skills/watch/SKILL.md"))).toBe(true);
    const enable = await runCli(root, ["module", "enable", "video", "--json"]);
    expect(enable.code, enable.stderr).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("The video module is enabled");
    const lint = await runCli(root, ["skills", "lint", "--json"]);
    expect(lint.code, lint.stderr + lint.stdout).toBe(0);
    const disable = await runCli(root, ["module", "disable", "video", "--json"]);
    expect(disable.code, disable.stderr).toBe(0);
    expect(existsSync(join(root, ".agents/skills/watch"))).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).not.toContain("The video module is enabled");
    const watch = await runCli(root, ["video", "watch", URL, "--json"]);
    expect(watch.code).toBe(1);
    expect(watch.stderr).toContain("dormant");
  });
  test("missing/outside citations are warned, answer stays unchanged", async () => {
    const answer = "00:10 Supplies. 03:00 Later. 00:10 Supplies again.";
    const root = fixture({ answer });
    const result = await runCli(root, ["video", "watch", URL, "--end", "2:00", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.answer).toBe(answer); expect(report.timestamps).toEqual(["00:10"]);
    expect(report.warnings.join(" ")).toContain("outside the requested clip");
    const missing = await runCli(fixture({ answer: "No reliable timing is visible." }), ["video", "watch", URL, "--json"]);
    expect(missing.code).toBe(0);
    expect(JSON.parse(missing.stdout).timestamps).toEqual([]);
    expect(JSON.parse(missing.stdout).warnings.join(" ")).toContain("no usable timestamps");
  });
  for (const args of [
    [URL, "--end", "0"], [URL, "--start", "2:00", "--end", "1:00"],
    [URL, "--start", "1:60"], [URL, "--engine", "local"], [URL, "--question"],
    [URL, "--start", "0", "--start", "1"], ["https://youtube.com.attacker.invalid/watch?v=Odysseus001"],
    ["https://www.youtube.com/playlist?list=Odysseus001"], ["https://user:secret@www.youtube.com/watch?v=Odysseus001"],
    ["https://www.youtube.com:8443/watch?v=Odysseus001"], ["missing.mp4"],
  ]) {
    test(`rejects invalid input without invocation ${JSON.stringify(args)}`, async () => {
      const root = fixture();
      const result = await runCli(root, ["video", "watch", ...args, "--json"]);
      expect(result.code).toBe(1); expect(result.stdout).toBe("");
      expect(existsSync(join(root, "request.json"))).toBe(false);
    });
  }
  test("empty answer fails without success JSON", async () => {
    const root = fixture({ emptyAnswer: true });
    const result = await runCli(root, ["video", "watch", URL, "--json"]);
    expect(result.code).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("empty answer");
  });
});
