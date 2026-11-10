/**
 * The host web broker and its child executor (#3685), against a real fixture
 * executor process: identity binding, handle ownership across two concurrent
 * sessions, provider admission, unsupported features, bounds, cancellation,
 * deadline and executor death with child-exit and cleanup receipts. Keyless
 * and offline: the fixture fabricates Odysseus results and reaches nothing.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebToolCall, WebToolEnvelope } from "@schlessera/brain-ui-sdk/tool-contracts";
import { WEB_SEARCH_PROVIDERS } from "@schlessera/brain-ui-sdk/internal";
import { WEB_TOOL_PROVIDERS } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createWebBroker, type WebBroker, type WebBrokerLimits, type WebCallScope, type WebReceipt } from "../src/web-tools/broker.js";
import { createChildWebExecutor } from "../src/web-tools/child-executor.js";

let dir: string, broker: WebBroker, receipts: WebReceipt[];
const FIXTURE = join(import.meta.dir, "fixtures/web-executor.ts");

function start(limits: Partial<WebBrokerLimits> = {}, admitted: readonly string[] = ["exa", "duckduckgo"], graceMs = 300) {
  receipts = [];
  broker = createWebBroker({
    executor: createChildWebExecutor({ command: [process.execPath, FIXTURE], env: { PATH: process.env.PATH!, WEB_FIXTURE_DIR: dir }, graceMs }),
    admittedProviders: () => admitted, limits, onReceipt: receipt => receipts.push(receipt),
  });
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "odysseus-web-broker-")); start(); });
afterEach(async () => { await broker.close(); rmSync(dir, { recursive: true, force: true }); });

let callIds = 0;
const scope = (sessionId = "s-ithaca", principalId = "p-penelope", turnId = "t-voyage"): WebCallScope =>
  ({ principalId, sessionId, turnId, toolCallId: `call-${++callIds}`, profile: "governed", policyRevision: "rev-7" });
function call(at: WebCallScope, tool: WebToolCall["tool"], input: Record<string, unknown>, options: { signal?: AbortSignal; current?: () => boolean } = {}): Promise<WebToolEnvelope> {
  return broker.call(at, { tool, input, toolCallId: at.toolCallId }, options.signal ?? new AbortController().signal, options.current ?? (() => true));
}
const calls = () => existsSync(join(dir, "calls.jsonl"))
  ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
const executorReceipts = () => receipts.filter((receipt): receipt is Extract<WebReceipt, { kind: "executor" }> => receipt.kind === "executor");
const groupGone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
async function until(condition: () => boolean, label = "condition not met", ms = 3_000) {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) throw new Error(label); await Bun.sleep(20); }
}

test("the provider list a call may name is the curated catalog", () => {
  expect([...WEB_TOOL_PROVIDERS] as string[], "WEB_PROVIDERS_MATCH_CATALOG").toEqual(WEB_SEARCH_PROVIDERS.map(provider => provider.id));
});

test("a result handle is the host's, bound to its session, and the executor sees the host scope", async () => {
  const at = scope();
  const found = await call(at, "web_search", { query: "Odysseus mast" });
  expect(found.ok).toBe(true);
  if (!found.ok) return;
  expect(found.responseId, "WEB_HANDLE_IS_OPAQUE_HOST_HANDLE").toMatch(/^wr_[A-Za-z0-9_-]{24}$/);
  expect(found.text, "WEB_UPSTREAM_ID_NEVER_REACHES_MODEL").not.toContain("upstream-");
  expect(found.text).toContain(found.responseId!);
  const page = await call(scope(), "get_search_content", { responseId: found.responseId });
  expect(page, "WEB_OWN_HANDLE_READS_STORED_CONTENT").toMatchObject({ ok: true, responseId: found.responseId });
  if (page.ok) {
    expect(page.text).toContain("the raft reaches Ithaca at dawn");
    expect(page.text, "WEB_ECHOED_UPSTREAM_ID_REWRITTEN").not.toContain("upstream-");
  }
  const seen = calls();
  expect(seen[0].scope, "WEB_EXECUTOR_RECEIVES_BOUND_SCOPE").toEqual(at);
  expect(seen[1].input.responseId, "WEB_EXECUTOR_RECEIVES_UPSTREAM_ID").toMatch(/^upstream-/);
});

test("forged identities, unknown fields and guessed or replayed handles never reach another session", async () => {
  const ithaca = scope("s-ithaca"), troy = scope("s-troy");
  // Two concurrent sessions, one executor session each.
  const [mine, theirs] = await Promise.all([call(ithaca, "web_search", { query: "Ithaca harbour" }), call(troy, "web_search", { query: "Troy walls" })]);
  expect(mine.ok && theirs.ok).toBe(true);
  if (!mine.ok || !theirs.ok) return;
  expect(broker.stats().sessions).toBe(2);
  const before = calls().length;
  // Session Troy replays Ithaca's handle; another principal in the same session id tries too.
  expect(await call(scope("s-troy"), "get_search_content", { responseId: mine.responseId }), "WEB_FOREIGN_SESSION_HANDLE_REFUSED")
    .toMatchObject({ ok: false, error: { code: "unknown_handle" } });
  expect(await call(scope("s-ithaca", "p-antinous"), "get_search_content", { responseId: mine.responseId }), "WEB_FOREIGN_PRINCIPAL_HANDLE_REFUSED")
    .toMatchObject({ ok: false, error: { code: "unknown_handle" } });
  // A guessed handle and the executor's own upstream id are refused the same way.
  for (const responseId of ["wr_AAAAAAAAAAAAAAAAAAAAAAAA", "upstream-1-1"]) {
    expect(await call(scope(), "get_search_content", { responseId }), "WEB_GUESSED_HANDLE_REFUSED").toMatchObject({ ok: false, error: { code: "unknown_handle" } });
  }
  // Identity fields in the input are unknown fields, not overrides.
  for (const forged of [{ principalId: "p-antinous" }, { sessionId: "s-troy" }, { turnId: "t-other" }, { proxy: "socks5h://127.0.0.1:9" }, { forceClone: true }]) {
    expect(await call(scope(), "web_search", { query: "Odysseus", ...forged }), "WEB_FORGED_OR_UNKNOWN_FIELD_REFUSED")
      .toMatchObject({ ok: false, error: { code: "invalid_input" } });
  }
  expect(await call(scope(), "fetch_content", { url: "file:///etc/passwd" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  // A tool call id runs once per turn.
  const once = scope();
  expect((await call(once, "web_search", { query: "Odysseus" })).ok).toBe(true);
  expect(await call(once, "web_search", { query: "Odysseus" }), "WEB_REPLAYED_CALL_REFUSED").toMatchObject({ ok: false, error: { code: "replayed_call" } });
  expect(calls().length - before, "WEB_REFUSALS_NEVER_REACH_EXECUTOR").toBe(1);
});

test("providers outside the admitted subset and unsupported features are refused before the executor", async () => {
  for (const provider of ["brave", ["exa", "tavily"], "all", "searxng"]) {
    expect(await call(scope(), "web_search", { query: "Odysseus", provider }), "WEB_PROVIDER_OUTSIDE_SUBSET_REFUSED")
      .toMatchObject({ ok: false, error: { code: "provider_not_admitted" } });
  }
  expect(await call(scope(), "source_check", { claim: "The raft reached Ithaca", provider: ["exa", "brave"] })).toMatchObject({ ok: false, error: { code: "provider_not_admitted" } });
  expect((await call(scope(), "web_search", { query: "Odysseus", provider: ["exa", "duckduckgo"] })).ok, "WEB_ADMITTED_PROVIDERS_RUN").toBe(true);
  const deferred: Array<[WebToolCall["tool"], Record<string, unknown>]> = [
    ["web_search", { query: "Odysseus", workflow: "summary-review" }], ["web_search", { query: "Odysseus", workflow: "auto-summary" }],
    ["fetch_content", { url: "https://ithaca.example/log", mode: "answer", prompt: "When?" }],
    ["fetch_content", { url: "https://ithaca.example/voyage.mp4", timestamp: "1:23", frames: 4 }],
    ["fetch_content", { url: "https://ithaca.example/log", auth: true }],
  ];
  for (const [tool, input] of deferred) {
    const result = await call(scope(), tool, input);
    expect(result, `WEB_DEFERRED_UNSUPPORTED ${JSON.stringify(input)}`).toMatchObject({ ok: false, error: { code: "unsupported" } });
    if (!result.ok) expect(result.error.feature).toBeString();
  }
  expect(calls().map(seen => seen.tool), "WEB_UNSUPPORTED_NEVER_REACHES_EXECUTOR").toEqual(["web_search"]);
});

test("a cancelled call settles at once, the executor confirms, and the session keeps its results", async () => {
  const kept = await call(scope(), "web_search", { query: "Odysseus" });
  const controller = new AbortController();
  const pending = call(scope(), "web_search", { query: "slow Sirens" }, { signal: controller.signal });
  await until(() => calls().length === 2);
  const at = Date.now();
  controller.abort();
  expect(await pending, "WEB_CANCEL_SETTLES").toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(Date.now() - at, "WEB_CANCEL_IS_PROMPT").toBeLessThan(250);
  await Bun.sleep(400);
  expect(executorReceipts(), "WEB_COOPERATIVE_CANCEL_KEEPS_EXECUTOR").toEqual([]);
  if (kept.ok) expect((await call(scope(), "get_search_content", { responseId: kept.responseId })).ok).toBe(true);
  expect(receipts.find(receipt => receipt.kind === "call" && receipt.outcome === "cancelled"), "WEB_CANCEL_RECEIPT").toBeDefined();
});

test("an executor that ignores cancel and its grandchild are killed, with exit and cleanup receipts", async () => {
  const kept = await call(scope(), "web_search", { query: "Odysseus" });
  const controller = new AbortController();
  const pending = call(scope(), "web_search", { query: "hang at Scylla" }, { signal: controller.signal });
  await until(() => existsSync(join(dir, "grandchild.pid")));
  const grandchild = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
  controller.abort();
  expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
  await until(() => executorReceipts().length === 1, "WEB_CANCEL_TIMEOUT_ENDS_EXECUTOR");
  const [ended] = executorReceipts();
  expect(ended!.exit, "WEB_CANCEL_TIMEOUT_KILLS_GROUP").toMatchObject({ reason: "cancel_timeout", signal: "SIGKILL", exited: true });
  expect(groupGone(ended!.exit.pid!), "WEB_EXECUTOR_EXITED").toBe(true);
  expect(groupGone(grandchild), "WEB_GRANDCHILD_KILLED").toBe(true);
  // Its stored results died with it.
  if (kept.ok) expect(await call(scope(), "get_search_content", { responseId: kept.responseId }), "WEB_HANDLES_END_WITH_EXECUTOR")
    .toMatchObject({ ok: false, error: { code: "unknown_handle" } });
});

test("a call past its deadline is stopped and the hung executor is killed", async () => {
  await broker.close();
  start({ callDeadlineMs: 200 });
  const result = await call(scope(), "web_search", { query: "hang in the doldrums" });
  expect(result, "WEB_DEADLINE_SETTLES").toMatchObject({ ok: false, error: { code: "deadline" } });
  await until(() => executorReceipts().length === 1, "WEB_DEADLINE_ENDS_HUNG_EXECUTOR");
  expect(executorReceipts()[0]!.exit, "WEB_DEADLINE_KILLS_HUNG_EXECUTOR").toMatchObject({ reason: "cancel_timeout", exited: true });
  expect(broker.stats(), "WEB_DEADLINE_DRAINS").toEqual({ active: 0, queued: 0, sessions: 0, handles: 0 });
});

test("executor death settles its calls, keeps no result, and the next call starts a new executor", async () => {
  const kept = await call(scope(), "web_search", { query: "Odysseus" });
  const died = await call(scope(), "web_search", { query: "die at Charybdis" });
  expect(died, "WEB_EXECUTOR_DEATH_SETTLES").toMatchObject({ ok: false, error: { code: "executor_died" } });
  await until(() => executorReceipts().length === 1);
  const [ended] = executorReceipts();
  expect(ended, "WEB_DEATH_RECEIPT").toMatchObject({ owner: { principalId: "p-penelope", sessionId: "s-ithaca" }, generation: 1, calls: 2,
    exit: { reason: "died", code: 3, exited: true } });
  if (kept.ok) expect(await call(scope(), "get_search_content", { responseId: kept.responseId })).toMatchObject({ ok: false, error: { code: "unknown_handle" } });
  expect((await call(scope(), "web_search", { query: "Odysseus again" })).ok, "WEB_NEW_EXECUTOR_AFTER_DEATH").toBe(true);
  expect(new Set(calls().map(seen => seen.scope.sessionId))).toEqual(new Set(["s-ithaca"]));
});

test("no result returns after the turn stops being current, and a late answer to cancel is discarded", async () => {
  let current = true;
  const pending = call(scope(), "web_search", { query: "slow Calypso" }, { current: () => current });
  await until(() => calls().length === 1);
  current = false;
  expect(await pending, "WEB_NO_RESULT_AFTER_TURN_ENDS").toMatchObject({ ok: false, error: { code: "cancelled" } });
  const controller = new AbortController();
  const late = call(scope(), "web_search", { query: "late Circe" }, { signal: controller.signal });
  await until(() => calls().length === 2);
  controller.abort();
  expect(await late, "WEB_LATE_ANSWER_DISCARDED").toMatchObject({ ok: false, error: { code: "cancelled" } });
  await Bun.sleep(100);
  expect(broker.stats().handles, "WEB_DISCARDED_RESULT_ISSUES_NO_HANDLE").toBe(0);
});

test("concurrency, queue and response bounds refuse instead of growing", async () => {
  await broker.close();
  start({ globalConcurrency: 1, queue: 1, responseBytes: 4_096 });
  const first = call(scope(), "web_search", { query: "slow one" });
  const second = call(scope(), "web_search", { query: "slow two" });
  const third = await call(scope(), "web_search", { query: "slow three" });
  expect(third, "WEB_QUEUE_BOUND").toMatchObject({ ok: false, error: { code: "busy" } });
  expect((await first).ok && (await second).ok, "WEB_QUEUED_CALL_RUNS_AFTER_SLOT").toBe(true);
  expect(await call(scope(), "web_search", { query: "huge Polyphemus" }), "WEB_RESPONSE_BOUND").toMatchObject({ ok: false, error: { code: "response_too_large" } });
  expect(await call(scope(), "web_search", { queries: ["Odysseus", "Ithaca", "Troy", "Sirens", "Scylla"] }), "WEB_FAN_OUT_BOUND")
    .toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(await call(scope(), "web_search", { query: "Odysseus", note: "x".repeat(20_000) }), "WEB_REQUEST_BOUND")
    .toMatchObject({ ok: false, error: { code: "request_too_large" } });
});

test("closing the broker ends every executor session and refuses further calls", async () => {
  await Promise.all([call(scope("s-ithaca"), "web_search", { query: "Odysseus" }), call(scope("s-troy"), "web_search", { query: "Troy" })]);
  await broker.close();
  expect(executorReceipts().map(receipt => receipt.exit.reason).sort(), "WEB_CLOSE_RECEIPTS").toEqual(["closed", "closed"]);
  expect(executorReceipts().every(receipt => receipt.exit.exited && groupGone(receipt.exit.pid!)), "WEB_CLOSE_EXITS").toBe(true);
  expect(await call(scope(), "web_search", { query: "Odysseus" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
});
