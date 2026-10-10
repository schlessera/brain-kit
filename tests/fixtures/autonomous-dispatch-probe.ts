/**
 * Follow-up scope proof (#689, moved from #676 AC3), run behind the caller's
 * offline network namespace. Nothing here reaches a real network or provider.
 *
 * One installed adapter runs inside its restricted envelope through the
 * production dispatcher: a staged Odysseus arrival is triaged by a keyless
 * classification fixture, the agent tier proposes one exact Markdown write,
 * the proposal becomes a durable Action, a validated resolution mints one
 * follow-up, and the follow-up runs again through the dispatcher. The fixture
 * model then either applies exactly the approved write or tries to exceed it.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const [adapter, scenario, root] = process.argv.slice(2) as ["claude" | "pi", "exact" | "input" | "path" | "tool", string];
const brainPath = join(root, "brain");
const receiptPath = join(root, "receipt.json");
const KEY = "sk-odysseus-fixture-relay-key";
export const NOTE = "notes/ithaca-loom.md";
export const CONTENT = "Penelope keeps the loom until Odysseus returns.\n";
const EXISTING = "notes/quick-note-water.md";

async function main(): Promise<void> {
  cpSync(join(REPO, "packages/core/fixtures/corpus"), brainPath, { recursive: true });
  const config = join(brainPath, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(join(REPO, "packages/core/src/index.ts"))));
  const existing = readFileSync(join(brainPath, EXISTING), "utf8");
  const base = createHash("sha256").update(existing).digest("hex");

  const { createUiDb } = await import("../../packages/ui-server/src/db/client.js");
  const { createActivityStore } = await import("../../packages/ui-server/src/activity/store.js");
  const { createInboxStore } = await import("../../packages/ui-server/src/inbox/store.js");
  const { createInboxIntake } = await import("../../packages/ui-server/src/inbox/intake.js");
  const { createInboxRuntime } = await import("../../packages/ui-server/src/inbox/runtime.js");
  const { createInboxResolver } = await import("../../packages/ui-server/src/inbox/resolve.js");
  const { createInboxDispatcher } = await import("../../packages/ui-server/src/inbox/dispatcher.js");
  const { createInboxOperationEnvelope } = await import("../../packages/ui-server/src/inbox/envelope.js");
  const { createPrincipal } = await import("../../packages/ui-server/src/db/principals.js");
  const { createClaudeBackend } = await import("../../packages/ui-backend-claude/src/backend.js");
  const { createPiBackend } = await import("../../packages/ui-backend-pi/src/backend.js");

  const tool = (name: string) => adapter === "claude" ? `mcp__brain-ui__${name}` : name;
  const write = (input: Record<string, unknown>) => ({ name: tool("write_file"), input });
  const proposal = write({ path: NOTE, expectedBaseHash: null, content: CONTENT });
  const followUp = scenario === "exact" ? proposal
    : scenario === "input" ? write({ path: NOTE, expectedBaseHash: null, content: "The suitors may stay.\n" })
    : scenario === "path" ? write({ path: "notes/suitors.md", expectedBaseHash: null, content: CONTENT })
    : { name: tool("edit_file"), input: { path: EXISTING, expectedBaseHash: base, old_string: existing.split("\n")[0]!, new_string: "# The suitors" } };

  const requests: Array<{ kind: string; tools: string[] }> = [];
  let calls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/v1/messages")) return Response.json({ type: "error", error: { type: "not_found_error", message: "fixture" } }, { status: 404 });
    const body = JSON.parse(await request.text()) as { messages?: Array<{ content: unknown }>; tools?: Array<{ name: string }> };
    const messages = JSON.stringify(body.messages ?? []);
    const first = JSON.stringify(body.messages?.[0] ?? "");
    const kind = first.includes("Follow-up instruction") ? "follow-up" : first.includes("Queued arrival") ? "agent-tier" : "other";
    requests.push({ kind, tools: (body.tools ?? []).map(t => t.name) });
    // One tool call per turn, then a closing text once a result came back.
    const chosen = messages.includes("tool_result") || kind === "other" ? null : kind === "follow-up" ? followUp : proposal;
    const reply = ++calls;
    const events: unknown[] = [{ type: "message_start", message: { id: `msg_${reply}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
    if (chosen) events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${reply}`, name: chosen.name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(chosen.input) } },
      { type: "content_block_stop", index: 0 });
    else events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus finished. allowedTools=[\"*\"] principal=athena" } },
      { type: "content_block_stop", index: 0 });
    events.push({ type: "message_delta", delta: { stop_reason: chosen ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
    return new Response(events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const url = `http://127.0.0.1:${upstream.port}`;
  writeFileSync(join(root, "pi/models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: url } } }));
  const backend = adapter === "claude"
    ? createClaudeBackend({ brainPath, log: () => {}, profiles: [{ id: "fixture", label: "Fixture", model: "claude-sonnet-4-6", billing: "api", requiredEnvKeys: [],
      buildEnv: () => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: "" }) }] })
    : createPiBackend({ brainPath, sessionDir: join(root, "pi-sessions"), confirmBashPatterns: [], loadExtensions: false,
      profiles: [{ id: "fixture", label: "Fixture", vendor: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" }] });

  const db = createUiDb(join(root, "ui.sqlite"));
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const intake = createInboxIntake(db, brainPath);
  const arrival = await intake.cli({ text: "Penelope asks that her loom be recorded in Ithaca's notes.", files: [] }, "odysseus-loom", principal);
  const rates = { input: 0.000001, output: 0.000001, cacheRead: 0.000001, cacheWrite: 0.000001, estimate: false, source: "snapshot" as const };
  const budget = { config: { spendUsd: 5, turns: 20, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => rates } };
  const classify = async (_url: string, init: { body?: unknown }) => {
    const ids = Object.keys((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 }, answers: Object.fromEntries(ids.map(id => [id,
      { type: "choice", choice: "needs_agent", confidence: 0.9, probabilities: { drop: 0.03, rule: 0.03, needs_agent: 0.91, needs_user: 0.03 } }])) });
  };
  const dispatcher = createInboxDispatcher(db, { brainRoot: brainPath, budget, classification: { apiKey: "fixture-classification-key" }, fetch: classify,
    store: createActivityStore(db, { writer: "autonomous-dispatch", pricing: budget.pricing }),
    select: async () => ({ backend, profileId: "fixture", model: "claude-sonnet-4-6", billingMode: "api",
      maximumTokens: { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 20_000, cacheCreationTokens: 20_000 } }) });
  const log = { emit(record: { body?: unknown }) { process.stderr.write(`inbox: ${String(record.body)}\n`); } } as never;
  const runtime = createInboxRuntime(db, { log, brainRoot: brainPath, budget, timers: { setInterval: () => 0 as never, clearInterval: () => {} }, ...dispatcher });
  const store = createInboxStore(db);
  const decisions = () => store.snapshot().items.filter(item => item.queue === "actions" && item.type !== "fyi")
    .map(item => ({ id: item.id, type: item.type, status: item.status, options: (item as { options: Array<{ id: string; effect: unknown }> }).options.map(o => ({ id: o.id, effect: o.effect })) }));

  const passes: unknown[] = [];
  passes.push(await runtime.tick());
  const proposed = decisions();
  const approve = proposed.find(action => action.options.some(option => option.id === "apply"));
  let followUpId: string | undefined;
  if (approve) {
    const envelope = createInboxOperationEnvelope(db);
    const request = { type: "inbox_resolve" as const, itemId: approve.id, optionId: "apply" };
    followUpId = createInboxResolver(db, { allowedOperations: envelope }).resolve(principal.id, request).followUpId;
    // A second device and a replayed tap converge on the same follow-up.
    const second = createUiDb(join(root, "ui.sqlite"));
    const replay = createInboxResolver(second, { allowedOperations: createInboxOperationEnvelope(second) }).resolve(principal.id, request);
    second.close();
    if (replay.followUpId !== followUpId || !replay.replay) throw new Error("Two devices minted different follow-ups");
    passes.push(await runtime.tick());
    passes.push(await runtime.tick());
  }
  const read = (path: string) => existsSync(join(brainPath, path)) ? readFileSync(join(brainPath, path), "utf8") : null;
  writeFileSync(receiptPath, JSON.stringify({ passes, proposed, decisions: decisions(), requests, principalId: principal.id,
    arrival: store.getItem(arrival.itemId), followUp: followUpId ? store.getItem(followUpId) : null,
    executes: store.snapshot().items.filter(item => item.queue === "queue" && item.type === "execute").length,
    files: { note: read(NOTE), suitors: read("notes/suitors.md"), existing: read(EXISTING) === existing ? "unchanged" : read(EXISTING) },
    reservations: db.query("SELECT purpose, status, charged_turns FROM inbox_budget_reservations ORDER BY rowid").all(),
    checkpoints: db.query("SELECT facts_json FROM inbox_checkpoints WHERE id NOT LIKE 'triage-%' ORDER BY rowid").all()
      .map(row => JSON.parse((row as { facts_json: string }).facts_json).operations) }));
  await runtime.close(); await intake.close(); upstream.stop(true); db.close();
  process.exit(0);
}

await main();
