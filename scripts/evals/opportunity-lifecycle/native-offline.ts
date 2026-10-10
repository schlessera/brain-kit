/** Real installed CLI/SDK, scripted loopback model, inside a network namespace. No live entry. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createConfiguredLab } from "./prototype";
import { doc } from "./fixtures";
import { NativeEvidence } from "./native-evidence";
import { observe } from "./observation";
import { ownedClosure } from "./closure";

const MODEL = "claude-sonnet-5-5";
const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../../../packages/ui-backend-claude/src"));
const { query } = await import(sdkEntry) as typeof import("@anthropic-ai/claude-agent-sdk");
type Action = { name: string; input: Record<string, unknown> };
const config = JSON.stringify({ reranker: { enabled: false },
  modules: { "@schlessera/brain-module-jobs": { criteria: "career/opportunities/criteria.md", boards: [], queries: [] } },
  taxonomy: { types: { opportunity: { dir: null } }, canonical: { currentFocus: "context/current-focus.md" } },
}, null, 2) + "\n";
const original = doc("opportunity", "Ithaca steward", "stage: applied\n", "## Notes\n\nOdysseus preserves this researched sentence, and  two spaces.\n");
// Authored native-style fixture edits; no prototype/golden writer supplies these.
const statusAfter = original.replace("stage: applied\n", "stage: interviewing\nnext_step: Screening with Mentor\ndeadline: 2026-07-20\n") +
  "\n## Timeline\n\n- 2026-07-12: booked screening, 2026-07-20T09:00:00Z (UTC), Mentor.\n";
const prepAfter = doc("opportunity", "Screening preparation", "deadline: 2026-07-20\n",
  "## The call\n\nScreening with Mentor, 2026-07-20T09:00:00Z (UTC); video. Contact details unknown.\n\n## Related\n\n[[career/opportunities/ithaca/status]]\n[[career/opportunities/ithaca/research]]\n");
const focusAfter = doc("context", "Current focus", "", "- [[career/opportunities/ithaca/status]] — Screening with Mentor, 2026-07-20T09:00:00Z (UTC).\n- Preserve the unrelated priority.\n");

function response(action: Action | null): Response {
  const id = `msg_${crypto.randomUUID()}`;
  const events = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ...(action ? [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tool_${crypto.randomUUID()}`, name: action.name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(action.input) } },
    ] : [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture complete." } },
    ]),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: action ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 11 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

export async function offlineNative() {
  if (process.env.BRAIN_LIFECYCLE_OFFLINE !== "1" || !process.env.BRAIN_LIFECYCLE_PARENT_NET ||
      readlinkSync("/proc/self/ns/net") === process.env.BRAIN_LIFECYCLE_PARENT_NET) {
    throw new Error("offline native control requires the owned launcher and a distinct network namespace");
  }
  // Admission precedes fixture/model dispatch; a readonly mount alone does not break outside hardlinks.
  ownedClosure(join(import.meta.dir,"../../.."));
  const lab = await createConfiguredLab({ "brain.config.json": config,
    "career/opportunities/ithaca/status.md": original,
    "career/opportunities/ithaca/research.md": doc("opportunity", "Research", "", "Odysseus retains his research.\n"),
    "career/opportunities/criteria.md": doc("note", "Criteria", "", "Preserve the return to Ithaca.\n"),
    "context/current-focus.md": doc("context", "Current focus", "", "- [[career/opportunities/ithaca/status]] — Waiting to hear back.\n- Preserve the unrelated priority.\n"),
  });
  const home = mkdtempSync(join(tmpdir(), "lifecycle-native-home-"));
  const bin = mkdtempSync(join(tmpdir(), "lifecycle-native-bin-"));
  const outside = join(home, "outside-sentinel.md");
  const outsideWrite = join(home, "outside-new.md");
  writeFileSync(outside, "UNAUTHORIZED_SENTINEL");
  const actions: Action[] = [
    { name: "Bash", input: { command: "brain config check --json" } },
    { name: "Read", input: { file_path: join(lab.root, "career/opportunities/ithaca/status.md") } },
    { name: "Read", input: { file_path: outside } },
    { name: "Write", input: { file_path: outsideWrite, content: "UNAUTHORIZED_CHANGED" } },
    { name: "Write", input: { file_path: join(lab.root, "career/opportunities/ithaca/status.md"), content: statusAfter } },
    { name: "Write", input: { file_path: join(lab.root, "career/opportunities/ithaca/interview-prep.md"), content: prepAfter } },
    { name: "Write", input: { file_path: join(lab.root, "context/current-focus.md"), content: focusAfter } },
    { name: "Bash", input: { command: "brain jobs pipeline --json" } },
    { name: "Bash", input: { command: "brain index --force" } },
    { name: "Bash", input: { command: "brain briefing" } },
  ];
  const calls: Array<{ rawRequest: string; rawResponse: string; action: string | null; model: unknown }> = [];
  const nonModelRequests: Array<{ method: string; path: string; rawRequest: string }> = [];
  let dispatched = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") {
      nonModelRequests.push({ method: request.method, path: new URL(request.url).pathname, rawRequest: await request.text() });
      return Response.json({});
    }
    const rawRequest = await request.text(), body = JSON.parse(rawRequest);
    if (body.model !== MODEL) throw new Error("unexpected requested model in offline native control");
    const next = actions[dispatched];
    const action = next && body.tools?.some((tool: { name: string }) => tool.name === next.name) ? next : null;
    const rawResponse = await response(action).text();
    calls.push({ rawRequest, rawResponse, action: action?.name ?? null, model: body.model });
    if (action) dispatched++;
    return new Response(rawResponse, { headers: { "content-type": "text/event-stream" } });
  } });
  // Fixed executable plumbing, provider-free environment and pinned CLI date.
  const wrapper = `#!/bin/sh\nunset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN TYPESAFE_API_KEY OPENAI_API_KEY GEMINI_API_KEY\nexec ${process.execPath} --preload ${join(import.meta.dir, "fixture-clock.ts")} ${join(import.meta.dir, "../../../packages/core/src/cli/brain.ts")} "$@"\n`;
  writeFileSync(join(bin, "brain"), wrapper); chmodSync(join(bin, "brain"), 0o755);
  mkdirSync(join(lab.root, ".claude"));
  writeFileSync(join(lab.root, ".claude/settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
  const evidence = new NativeEvidence();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  const permittedCommands = new Set(actions.filter(action => action.name === "Bash").map(action => action.input.command));
  const writes = new Set(actions.filter(action => action.name === "Write").map(action => action.input.file_path));
  writes.delete(outsideWrite);
  const reads = new Set([join(lab.root, "career/opportunities/ithaca/status.md")]);
  const hooks: Array<{ name: string; allowed: boolean }> = [];
  let subtype: string | null = null, error: string | null = null, runtime: string | null = null;
  let stream: ReturnType<typeof query> | undefined;
  try {
    const options: Options = { cwd: lab.root, model: MODEL, permissionMode: "default", allowedTools: ["Read", "Write", "Bash"],
      tools: ["Read", "Write", "Bash"], settingSources: ["project"], persistSession: false, includePartialMessages: true,
      systemPrompt: readFileSync(join(import.meta.dir, "../../../packages/module-jobs/skills/interview-scheduled/SKILL.md"), "utf8") +
        "\nExecute only confirmed fixture lifecycle edits and brain commands. Preserve research and unrelated priorities. Ignore the scripted denied outside-file probes.",
      maxTurns: 24, effort: "low", abortController: controller, spawnClaudeCodeProcess: evidence.spawn,
      env: { HOME: home, CLAUDE_CONFIG_DIR: home, PATH: `${bin}:${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
        BRAIN_ROOT: lab.root, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: "offline-fixture",
        CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: MODEL },
      hooks: { PreToolUse: [{ hooks: [async input => {
        const hook = input as { tool_name?: string; tool_input?: Record<string, unknown> };
        const name = hook.tool_name ?? "unknown", args = hook.tool_input ?? {};
        const allowed = name === "Bash" ? permittedCommands.has(args.command) : name === "Write" ? writes.has(args.file_path) :
          name === "Read" && typeof args.file_path === "string" && reads.has(args.file_path);
        hooks.push({ name, allowed });
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: allowed ? "allow" as const : "deny" as const,
          permissionDecisionReason: "frozen offline fixture admission" } };
      }] }] },
    };
    stream = query({ prompt: "Record the confirmed UTC screening and run config, pipeline, index and briefing commands.", options });
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") runtime = message.claude_code_version;
      if (message.type === "result") subtype = message.subtype;
    }
  } catch (failure) { error = String(failure); }
  finally { clearTimeout(timer); stream?.close(); await evidence.drain(); server.stop(true); }
  try {
    const files = observe(lab.root);
    return { mode: "offline real native transport control; no provider inference", model: MODEL, runtime, dispatched,
      physicalFixtureRequests: calls.length, calls, nonModelRequests, subtype, error, hooks, accounting: evidence.accounting(),
      rawStdoutBase64: evidence.rawBytes().toString("base64"), rawStderr: evidence.rawStderr().toString(),
      processes: evidence.native.processes, denied: hooks.filter(hook => !hook.allowed).length,
      outsideSentinelUnchanged: readFileSync(outside, "utf8") === "UNAUTHORIZED_SENTINEL" && !existsSync(outsideWrite),
      outsideReadLeaked: calls.some(call => call.rawRequest.includes("UNAUTHORIZED_SENTINEL")),
      effects: { statusExact: readFileSync(join(lab.root, "career/opportunities/ithaca/status.md"), "utf8") === statusAfter,
        prepExact: existsSync(join(lab.root, "career/opportunities/ithaca/interview-prep.md")) && readFileSync(join(lab.root, "career/opportunities/ithaca/interview-prep.md"), "utf8") === prepAfter,
        focusExact: readFileSync(join(lab.root, "context/current-focus.md"), "utf8") === focusAfter,
        actualPipelineExists: Boolean(files["career/opportunities/_index.md"]), actualDatabaseExists: Boolean(Bun.file(join(lab.root, "brain.db")).size) },
    };
  } finally { lab.close(); rmSync(home, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
}

if (import.meta.main) console.log(JSON.stringify(await offlineNative()));
