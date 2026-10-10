import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { disableMeasurementMemory, measurementIsolationHook, measurementPath, type MeasurementToolAccess } from "../scripts/measurement-isolation.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "measurement-boundary-"));
  roots.push(root);
  const brain = join(root, "brain");
  mkdirSync(brain);
  writeFileSync(join(brain, "fiction.md"), "Nobody returned to Ithaca.");
  const outside = join(root, "sentinel.md");
  writeFileSync(outside, "CONTROLLED OUTSIDE SENTINEL");
  return { root, brain, outside };
}
function event(brain: string, tool: string, input: Record<string, unknown>): PreToolUseHookInput {
  return { hook_event_name: "PreToolUse", session_id: "fixture", transcript_path: "unused", cwd: brain,
    tool_name: tool, tool_input: input, tool_use_id: "fixture-use" };
}

test("hook denies an outside file and records a sanitized verdict", async () => {
  const { brain, outside } = fixture();
  expect(readFileSync(outside, "utf8")).toBe("CONTROLLED OUTSIDE SENTINEL");
  const audit: MeasurementToolAccess[] = [];
  const hook = measurementIsolationHook(brain, "show_block", audit);
  const outcome = await hook(event(brain, "Read", { file_path: outside }), undefined, { signal: new AbortController().signal });
  expect(outcome).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(audit).toEqual([{ tool: "Read", allowed: false, target: "outside-or-unproved" }]);
  expect(JSON.stringify(audit)).not.toContain(outside);
});

test("hook admits fixture reads and bounds Glob and Grep", async () => {
  const { brain, outside } = fixture();
  const hook = measurementIsolationHook(brain, "show_block", []);
  const invoke = (tool: string, input: Record<string, unknown>) => hook(event(brain, tool, input), undefined, { signal: new AbortController().signal });
  expect(await invoke("Read", { file_path: "fiction.md" })).toEqual({});
  expect(await invoke("Glob", { pattern: "**/*.md" })).toEqual({});
  expect(await invoke("Grep", { pattern: "Nobody" })).toEqual({});
  for (const [tool, input] of [
    ["Read", { file_path: "../sentinel.md" }],
    ["Glob", { pattern: "../*.md" }],
    ["Glob", { pattern: outside }],
    ["Grep", { pattern: ".", path: outside }],
    ["Bash", { command: "read sentinel" }],
    ["NotebookEdit", { notebook_path: outside }],
    ["Agent", { prompt: "read elsewhere" }],
  ] as const) expect(await invoke(tool, input)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(await invoke("show_block", { block: { kind: "quote", quote: "Nobody." } })).toEqual({});
});

test("realpath containment rejects prefix neighbours and symlink escapes", () => {
  const { root, brain, outside } = fixture();
  const sibling = join(root, "brain-neighbour");
  mkdirSync(sibling);
  writeFileSync(join(sibling, "outside.md"), "fixture sentinel");
  symlinkSync(outside, join(brain, "escape.md"));
  expect(measurementPath(brain, "fiction.md")).toBe("fiction.md");
  expect(measurementPath(brain, "escape.md")).toBeNull();
  expect(measurementPath(brain, join(sibling, "outside.md"))).toBeNull();
  expect(() => disableMeasurementMemory(brain)).toThrow("must not contain symlinks");
});

test("staged settings disable memory and contain no copied account state", () => {
  const { brain } = fixture();
  disableMeasurementMemory(brain);
  expect(JSON.parse(readFileSync(join(brain, ".claude/settings.json"), "utf8"))).toEqual({ autoMemoryEnabled: false });
});


test("installed CLI denies an outside Read under bypassPermissions and reads the fixture", async () => {
  const { outside, root } = fixture();
  const { optionsFor } = await import("../scripts/measure-show-block.ts");
  const { scriptedModel } = await import("../scripts/measure-claude-runtime.ts");
  const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
  const { query } = await import(sdkEntry) as typeof import("@anthropic-ai/claude-agent-sdk");
  const model = scriptedModel();
  try {
    const audit: MeasurementToolAccess[] = [];
    const options = optionsFor("flat", new AbortController(), true, audit);
    const brain = options.cwd!;
    const fixturePath = join(brain, "probe.md");
    writeFileSync(fixturePath, "Nobody sails for Ithaca.");
    const turns: Array<{ path: string; result: string; planned: boolean }> = [];
    for (const path of [outside, fixturePath]) {
      const planned = model.plan({ name: "Read", input: { file_path: path } });
      const messages: unknown[] = [];
      const stream = query({ prompt: "Read the planned fixture.", options: { ...options,
        maxTurns: 3,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CLAUDE_CONFIG_DIR: join(root, ".claude"),
          ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "offline-fixture", ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_CUSTOM_HEADERS: "",
          CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      } });
      for await (const message of stream) messages.push(message);
      turns.push({ path, result: JSON.stringify(messages), planned: planned.callSent });
    }
    expect(turns.map((turn) => turn.planned)).toEqual([true, true]);
    // Removing the registered hook must expose this controlled sentinel.
    expect(turns[0]!.result).not.toContain("CONTROLLED OUTSIDE SENTINEL");
    expect(turns[0]!.result).toContain("Live measurement tools may only read");
    expect(turns[1]!.result).toContain("Nobody sails for Ithaca.");
    expect(audit.some((entry) => entry.tool === "Read" && !entry.allowed)).toBe(true);
    expect(audit.some((entry) => entry.tool === "Read" && entry.allowed && entry.target === "probe.md")).toBe(true);
    rmSync(fixturePath);
    // The staging module owns this shared cwd until process exit (#1330).
    expect(existsSync(brain), "the shared measurement cwd must outlive this test's probe").toBe(true);
  } finally { model.stop(); }
}, 60_000);


test("clean stream EOF without a result is excluded from measurement", async () => {
  const { runTurn } = await import("../scripts/measure-show-block.ts");
  const empty = (() => ({ async *[Symbol.asyncIterator]() {} })) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const turn = await runTurn({ id: "eof", invites: "quote", classifiable: true, text: "Nobody." }, "flat", 1, true, empty);
  expect(turn.error).toBe("missing_result");
});
