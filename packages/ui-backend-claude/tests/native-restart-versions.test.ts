/** Actual installed native tools through the production runner; only the worker transport is replaced. */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createWorkerFileObserver, workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../src/backend";
import * as workerSpawn from "../src/worker-spawn";
import { MEASURED_RUNTIME } from "../src/measured-runtime";
import { nativeModelReply } from "./helpers/native-model-reply";

for (const tool of ["Write", "Edit", "NotebookEdit"] as const) test(`restarted Claude runner restores native observations before actual ${tool}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-claude-restart-")), brain = join(root, "brain"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(home);
  const notebook = (source: string) => JSON.stringify({ cells: [{ cell_type: "code", id: "loom", metadata: {}, source: [source], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  const path = join(brain, tool === "NotebookEdit" ? "loom.ipynb" : "loom.md"), peer = tool === "NotebookEdit" ? notebook("Penelope sleeps.\n") : "Penelope sleeps.\n";
  writeFileSync(path, tool === "NotebookEdit" ? notebook("Penelope weaves.\n") : "Penelope weaves.\n");
  utimesSync(path, new Date("2026-07-12T00:00:00Z"), new Date("2026-07-12T00:00:00Z"));
  const stamp = statSync(path);
  let mode = "read", sent = 0, runtime: string | undefined, environmentCalls = 0, turns = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
    const body = await request.json() as { tools?: { name: string }[] };
    const name = mode === "read" || (mode === "recover" && sent === 0) ? "Read" : tool;
    if (sent >= (mode === "recover" ? 2 : 1) || !body.tools?.some(item => item.name === name)) return nativeModelReply();
    sent++;
    const input = name === "Read" ? { file_path: path } : tool === "Write" ? { file_path: path, content: "Athena charts.\n" }
      : tool === "Edit" ? { file_path: path, old_string: "Penelope", new_string: "Odysseus" }
      : { notebook_path: path, cell_id: "loom", new_source: "Athena charts.", edit_mode: "replace" };
    return nativeModelReply({ name, input, id: name === "Read" ? "toolu_ithaca_read" : "toolu_ithaca_native" });
  } });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: process.env.PATH ?? "/usr/bin:/bin",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "odysseus-offline-only-key", ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const probe = spyOn(workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const originalSpawn = workerSpawn.createWorkerSpawn;
  const transport = spyOn(workerSpawn, "createWorkerSpawn").mockImplementation((...args) => ({
    ...originalSpawn(...args), observeFile: createWorkerFileObserver({ brain, configurationRoot: brain, areas: [] }),
  }));
  const makeBackend = () => createClaudeBackend({ brainPath: brain, allowedTools: ["Read", "Write", "Edit", "NotebookEdit"],
    profiles: [{ id: "voyage", label: "Voyage", billing: "api", requiredEnvKeys: [], buildEnv: () => { environmentCalls++; return Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === "string")); } }],
    // A real CLI with loopback inference, isolated state and unchanged parent hooks.
    queryFn: ((params: { prompt: unknown; options: Options }) => (async function* () {
      for await (const message of query({ prompt: mode === "read" ? "Read the loom." : "Make the planned change.",
      options: { ...params.options, spawnClaudeCodeProcess: undefined, env, maxTurns: 3, model: "claude-sonnet-4-6" } })) {
        if (message.type === "system" && message.subtype === "init") runtime = message.claude_code_version;
        yield message;
      }
    })()) as typeof query,
  });
  let backend = makeBackend(), sessionId: string | undefined;
  async function turn(next: string) {
    mode = next; sent = 0; turns++;
    const frames: ServerMessage[] = [], controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    try {
      await backend.startTurn({ sessionId, prompt: next, signal: controller.signal,
        workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
        bridge: { emit: frame => { frames.push(frame); if (frame.type === "session_info") sessionId ??= frame.sessionId; }, requestPermission: async () => ({ behavior: "allow" }) },
      });
      expect(environmentCalls, "ONE_ENVIRONMENT_FOR_STORAGE_AND_NATIVE_RUNTIME").toBe(turns);
      expect(runtime, "ACTUAL_INSTALLED_CLAUDE_FILE_TOOL_IDENTITY").toBe(MEASURED_RUNTIME.claudeCode);
      expect(sent, "ACTUAL_NATIVE_OPERATION_REQUESTED").toBe(next === "recover" ? 2 : 1);
      expect(frames.some(frame => frame.type === "result" && frame.outcome === "success")).toBe(true);
      return frames;
    } finally { clearTimeout(timer); controller.abort(); }
  }
  try {
    await turn("read"); expect(sessionId).toBeDefined();
    backend = makeBackend();
    writeFileSync(path, peer); utimesSync(path, stamp.atime, stamp.mtime);
    const refused = await turn("write");
    expect(readFileSync(path, "utf8"), "CLAUDE_RESTART_STALE_WRITE_HAS_NO_EFFECT").toBe(peer);
    expect(refused.find(frame => frame.type === "tool_result" && frame.toolUseId === "toolu_ithaca_native")).toMatchObject({ isError: true });
    if (tool !== "NotebookEdit") expect(JSON.stringify(refused)).toContain("changed since you read it");
    utimesSync(path, stamp.atime, new Date("2026-07-12T00:00:01Z"));
    const recovered = await turn("recover");
    expect(recovered.find(frame => frame.type === "tool_result" && frame.toolUseId === "toolu_ithaca_native")).toMatchObject({ isError: false });
    expect(readFileSync(path, "utf8")).not.toBe(peer);
  } finally { transport.mockRestore(); probe.mockRestore(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 90_000);
