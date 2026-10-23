/**
 * A withheld provider, end to end (#1666): a real governed worker under
 * bubblewrap runs the real `brain` CLI with a fixture key in the host
 * environment it never receives, and the real turn recorder turns the CLI's
 * notices into `provider_unavailable` governance events.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorker } from "@schlessera/brain-ui-sdk/internal";
import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";
import { MAX_PROVIDER_UNAVAILABLE_PER_TURN, providerUnavailablePayloads } from "../src/governance/provider-unavailable";

const ROOT = resolve(import.meta.dir, "../../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const FIXTURE_KEY = "odysseus-fixture-gemini-key";

function brainFixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/provider-unavailable-"));
  const brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca before the fleet sails.\n");
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ embeddings: { provider: "gemini" }, completions: { provider: "gemini-flash" } }));
  writeFileSync(join(brain, ".env"), `GEMINI_API_KEY=${FIXTURE_KEY}\n`);
  const index = Bun.spawnSync([process.execPath, BRAIN_CLI, "index", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: root, BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file" } });
  if (index.exitCode !== 0) throw new Error(`brain index failed: ${index.stderr.toString()}`);
  return { brain, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The CLI in a governed turn worker whose host environment holds the fixture key. */
async function inWorker(brain: string, args: string[]) {
  const worker = launchAgentWorker({ brainPath: brain, command: [process.execPath, BRAIN_CLI, ...args], turnTempBytes: 64 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", BRAIN_ROOT: brain, GEMINI_API_KEY: FIXTURE_KEY },
    sandbox: { brain, restricted: false, profile: "governed", areas: [], scratchAliasesRemoved: [], protection: { paths: [], ancestors: [] } } });
  try {
    worker.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout as never).text(),
      new Response(worker.stderr as never).text()]);
    return { exit, stdout, stderr };
  } finally { worker.turnTemp?.close(); }
}

describe("withheld provider keys in a governed turn", () => {
  test("brain search falls back to keyword results and the turn records provider_unavailable", async () => {
    const f = brainFixture();
    const db = createUiDb(":memory:");
    const sessionId = "odysseus-provider-session";
    db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?, 'Voyage', 1, 1)").run(sessionId);
    const recorder = createTurnRecorder({ store: createActivityStore(db, { writer: "test" }), governanceDb: db,
      governance: event => { recordGovernanceEvent(db, event); } }, { turnId: "odysseus-provider-turn", sessionId, profile: "governed" });
    recorder.setMainModel("fixture-model");
    const shell = (toolUseId: string, command: string, result: { stdout: string; stderr: string }, isError = false) => {
      recorder.observeFrame({ type: "tool_use_start", sessionId, toolUseId, toolName: "Bash" });
      recorder.observeFrame({ type: "tool_use_complete", sessionId, toolUseId, toolName: "Bash", input: { command } });
      recorder.observeFrame({ type: "tool_result", sessionId, toolUseId, output: `${result.stdout}${result.stderr}`, isError });
    };
    try {
      const search = await inWorker(f.brain, ["search", "Ithaca harbour", "--json"]);
      expect(search.exit, search.stderr).toBe(0);
      const found = JSON.parse(search.stdout) as { results: Array<{ path: string }>; warnings: string[] };
      expect(found.results.map(result => result.path), "PROVIDER_UNAVAILABLE_KEYWORD_FALLBACK").toEqual(["notes/ithaca.md"]);
      expect(`${search.stdout}${search.stderr}`).not.toContain(FIXTURE_KEY);
      shell("search", "brain search \"Ithaca harbour\" --json", search);

      const processed = await inWorker(f.brain, ["process", "notes/ithaca.md"]);
      expect(processed.exit, "PROVIDER_UNAVAILABLE_PROCESS_REFUSED").not.toBe(0);
      shell("process", "brain process notes/ithaca.md", processed, true);

      expect(queryGovernanceEvents(db, { sessionId, kinds: ["provider_unavailable"], limit: 10 }).map((event): Record<string, unknown> => ({
        ...event.payload, turnId: event.turnId, actor: event.actor, profile: event.profile })), "PROVIDER_UNAVAILABLE_GOVERNANCE_EVENTS").toEqual([
        { provider: "gemini", capability: "embeddings", command: "brain search \"Ithaca harbour\" --json", degradedTo: "keyword_search",
          turnId: "odysseus-provider-turn", actor: "interactive", profile: "governed" },
        { provider: "gemini-flash", capability: "completions", command: "brain process notes/ithaca.md", degradedTo: null,
          turnId: "odysseus-provider-turn", actor: "interactive", profile: "governed" },
      ]);
      recorder.finish("success");
    } finally { db.close(); f.cleanup(); }
  });

  test("an autonomous turn and a denied call record nothing, and a turn records at most the cap", () => {
    const db = createUiDb(":memory:");
    const sessionId = "telemachus-provider-session";
    db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES (?, 'Voyage', 1, 1)").run(sessionId);
    const notice = (provider: string) => `[provider_unavailable provider=${provider} capability=embeddings key=GEMINI_API_KEY degraded_to=keyword_search]`;
    const recorder = (turnId: string, origin?: "autonomous") => createTurnRecorder({ store: createActivityStore(db, { writer: "test" }),
      governanceDb: db, governance: event => { recordGovernanceEvent(db, event); } }, { turnId, sessionId, origin, profile: "governed" });
    const events = () => queryGovernanceEvents(db, { sessionId, kinds: ["provider_unavailable"], limit: 100 });
    try {
      const autonomous = recorder("telemachus-autonomous", "autonomous");
      autonomous.observeFrame({ type: "tool_use_start", sessionId, toolUseId: "a", toolName: "Bash" });
      autonomous.observeFrame({ type: "tool_result", sessionId, toolUseId: "a", output: notice("gemini"), isError: false });
      autonomous.finish("success");
      const turn = recorder("telemachus-turn");
      turn.observeFrame({ type: "tool_use_start", sessionId, toolUseId: "denied", toolName: "Bash" });
      turn.onApprovalDecision("denied", "deny", "command");
      turn.observeFrame({ type: "tool_result", sessionId, toolUseId: "denied", output: notice("gemini"), isError: true });
      expect(events()).toHaveLength(0);
      // Across several results, and within the one that crosses the cap.
      expect(MAX_PROVIDER_UNAVAILABLE_PER_TURN).toBe(20);
      for (let call = 0; call < 3; call++) {
        const many = Array.from({ length: 9 }, (_, i) => notice(`gemini-${call}-${i}`)).join("\n");
        turn.observeFrame({ type: "tool_use_start", sessionId, toolUseId: `many-${call}`, toolName: "Bash" });
        turn.observeFrame({ type: "tool_result", sessionId, toolUseId: `many-${call}`, output: many, isError: false });
      }
      expect(events(), "PROVIDER_UNAVAILABLE_PER_TURN_CAP").toHaveLength(20);
      turn.finish("success");
    } finally { db.close(); }
  });

  test("an MCP tool's result names the tool as its command, and plain output records nothing", () => {
    expect(providerUnavailablePayloads("mcp__brain__brain_search", { query: "Ithaca" },
      "vector search unavailable: ... [provider_unavailable provider=gemini capability=embeddings key=GEMINI_API_KEY degraded_to=none]"))
      .toEqual([{ provider: "gemini", capability: "embeddings", command: "mcp__brain__brain_search", degradedTo: null }]);
    expect(providerUnavailablePayloads("Bash", { command: "brain search Ithaca" }, "provider_unavailable provider=gemini")).toEqual([]);
  });
});
