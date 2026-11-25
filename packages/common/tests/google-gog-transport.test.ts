/**
 * The transport against the fake gog (plan §8, §11; #4205): exit codes,
 * retries, timeouts with process-group kill, the output cap, stderr, the
 * environment a real process receives, stdin, per-account concurrency, and
 * the search's thread pre-reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGogTransport, GOG_CONCURRENCY, GOG_ENVIRONMENT_NAMES, GOG_PIN_REFUSALS, isTargetIndependentGogFailure, type GogLogEvent } from "@schlessera/brain-common/internal/google-gog";
import { structuredGmailSearch } from "@schlessera/brain-common/internal/google-operations";
import { watchdogMs } from "../../../scripts/test-deadlines";
import { gogInvocation, type GogInvocation } from "../src/google/gog/argv.ts";
import { GOG_EXIT_CODES, gogError, gogProcessError, type GogEffect, type GogProcessEnd } from "../src/google/gog/errors.ts";
import { createGogTransportInternals, gogConcurrencyState, type GogTransportOptions } from "../src/google/gog/transport.ts";
import { createFakeGog, type FakeGog, type FakeGogScenario } from "./support/fake-gog.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/gog", name), "utf8"));
const LABELS = fixture("labels-list.json");
const HALL = "19a0c3d2e4f50601";
const SWINE = "19a0c3d2e4f50700";
const BODY = "I am on my way home.\nKeep weaving.";

const fakes: FakeGog[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.dispose();
});

let accounts = 0;
function setup(scenario: FakeGogScenario, options: Partial<GogTransportOptions> = {}) {
  const fake = createFakeGog(scenario);
  fakes.push(fake);
  const events: GogLogEvent[] = [];
  // A fresh alias per test, so no test shares another's concurrency limits.
  const account = `ithaca-${++accounts}`;
  const transport = createGogTransportInternals({
    binary: fake.binary, account, environment: fake.environment, retryDelayMs: 0, log: event => events.push(event), ...options,
  });
  return { fake, transport, events, account };
}

const write = (): GogInvocation => gogInvocation("gmail.draft.save", { action: "create", to: ["penelope@example.com"], subject: "Home", body: BODY });
const errorOf = (result: { ok: boolean; error?: { code: string; reason: string | null } }) => result.ok ? null : [result.error!.code, result.error!.reason];

describe("exit codes", () => {
  // Every class gog's schema lists (automation.exit_codes), and one it does not.
  const TABLE: [exit: number, read: [string, string | null] | null, write: [string, string | null] | null][] = [
    [GOG_EXIT_CODES.ok, null, null],
    [GOG_EXIT_CODES.error, ["upstream_error", "error"], ["outcome_unknown", "error"]],
    [GOG_EXIT_CODES.usage, ["transport_incompatible", "usage"], ["transport_incompatible", "usage"]],
    [GOG_EXIT_CODES.empty_results, ["transport_incompatible", "empty_results"], ["transport_incompatible", "empty_results"]],
    [GOG_EXIT_CODES.auth_required, ["unavailable", "auth_required"], ["unavailable", "auth_required"]],
    [GOG_EXIT_CODES.not_found, ["not_found", null], ["not_found", null]],
    [GOG_EXIT_CODES.permission_denied, ["forbidden", null], ["forbidden", null]],
    [GOG_EXIT_CODES.rate_limited, ["rate_limited", null], ["rate_limited", null]],
    [GOG_EXIT_CODES.retryable, ["upstream_error", "retryable"], ["outcome_unknown", "retryable"]],
    [GOG_EXIT_CODES.config, ["unavailable", "config"], ["unavailable", "config"]],
    [GOG_EXIT_CODES.orphaned, ["transport_incompatible", "orphaned"], ["transport_incompatible", "orphaned"]],
    [GOG_EXIT_CODES.cancelled, ["upstream_error", "cancelled"], ["outcome_unknown", "cancelled"]],
    [42, ["transport_incompatible", "unknown_exit"], ["outcome_unknown", "unknown_exit"]],
  ];
  const coded = (end: GogProcessEnd, effect: GogEffect) => {
    const error = gogProcessError(end, effect);
    return error ? [error.code, error.reason] : null;
  };

  test("the table names every exit code gog declares", () => {
    expect(new Set(TABLE.map(([exit]) => exit))).toEqual(new Set([...Object.values(GOG_EXIT_CODES), 42]));
  });
  for (const [exit, read, written] of TABLE) {
    test(`exit ${exit}: a read answers ${JSON.stringify(read)}, a write ${JSON.stringify(written)}`, () => {
      expect(coded({ kind: "exit", exitCode: exit }, "read")).toEqual(read);
      expect(coded({ kind: "exit", exitCode: exit }, "write")).toEqual(written);
    });
  }
  test("ends that are not exits: a write that may have reached Google is outcome_unknown", () => {
    expect(coded({ kind: "timeout" }, "read")).toEqual(["upstream_error", "timeout"]);
    expect(coded({ kind: "timeout" }, "write")).toEqual(["outcome_unknown", "timeout"]);
    expect(coded({ kind: "signal", signal: "SIGKILL" }, "write")).toEqual(["outcome_unknown", "signal"]);
    expect(coded({ kind: "output_too_large" }, "read")).toEqual(["transport_incompatible", "output_too_large"]);
    expect(coded({ kind: "output_too_large" }, "write")).toEqual(["outcome_unknown", "output_too_large"]);
    expect(coded({ kind: "spawn_failed" }, "write")).toEqual(["transport_incompatible", "spawn_failed"]);
  });
  test("a real process's exit code reaches the mapping, for reads and writes", async () => {
    const { transport } = setup({ "gmail.labels.list": { exit: 5 }, "gmail.drafts.create": { exit: 6 }, "gmail.get": { exit: 4 } });
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["not_found", null]);
    expect(errorOf(await transport.execute("gmail.message.get", { message_id: HALL }))).toEqual(["unavailable", "auth_required"]);
    expect(errorOf(await transport.invoke("gmail.draft.save", write()))).toEqual(["forbidden", null]);
  });
});

describe("retries", () => {
  test("a read retries once on exit 8 and succeeds", async () => {
    const { fake, transport, events } = setup({ "gmail.labels.list": [{ exit: 8 }, { stdout: LABELS }] });
    expect((await transport.execute("gmail.labels.list", {})).ok).toBe(true);
    expect(fake.callsOf("gmail.labels.list")).toHaveLength(2);
    expect(events.map(event => [event.attempt, event.outcome])).toEqual([[1, "error"], [2, "ok"]]);
  });
  test("a read retries once only", async () => {
    const { fake, transport } = setup({ "gmail.labels.list": { exit: 8 } });
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["upstream_error", "retryable"]);
    expect(fake.callsOf("gmail.labels.list")).toHaveLength(2);
  });
  test("a read never retries another failure", async () => {
    const { fake, transport } = setup({ "gmail.labels.list": { exit: 7 } });
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["rate_limited", null]);
    expect(fake.callsOf("gmail.labels.list")).toHaveLength(1);
  });
  test("a write never retries, and exit 8 says it may have happened", async () => {
    const { fake, transport } = setup({ "gmail.drafts.create": { exit: 8 } });
    expect(errorOf(await transport.invoke("gmail.draft.save", write()))).toEqual(["outcome_unknown", "retryable"]);
    expect(fake.callsOf("gmail.drafts.create")).toHaveLength(1);
  });
});

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + watchdogMs(10_000);
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

describe("timeouts kill the process group", () => {
  // The transport's timeouts are product timings (30 s reads, 60 s writes);
  // here they are shortened to a controlled 300 ms against a fake that would
  // otherwise answer after a minute.
  test("a timed-out write reports that it may have happened, and nothing it started survives", async () => {
    const { fake, transport } = setup({ "gmail.drafts.create": { delay_ms: 60_000, grandchild: true } }, { timeouts: { writeMs: 300 } });
    const started = performance.now();
    expect(errorOf(await transport.invoke("gmail.draft.save", write()))).toEqual(["outcome_unknown", "timeout"]);
    expect(performance.now() - started).toBeLessThan(watchdogMs(20_000));
    const [call] = fake.callsOf("gmail.drafts.create");
    expect(call!.grandchild_pid).toBeGreaterThan(0);
    expect(await gone(call!.pid)).toBe(true);
    expect(await gone(call!.grandchild_pid!)).toBe(true);
  });
  test("a timed-out read is upstream_error and is not retried", async () => {
    const { fake, transport } = setup({ "gmail.labels.list": { delay_ms: 60_000 } }, { timeouts: { readMs: 300 } });
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["upstream_error", "timeout"]);
    expect(fake.callsOf("gmail.labels.list")).toHaveLength(1);
  });
  test("a process that exits normally takes its descendants with it", async () => {
    const { fake, transport } = setup({ "gmail.labels.list": { stdout: LABELS, grandchild: true } });
    expect((await transport.execute("gmail.labels.list", {})).ok).toBe(true);
    expect(await gone(fake.callsOf("gmail.labels.list")[0]!.grandchild_pid!)).toBe(true);
  });
});

describe("output", () => {
  test("stdout over 8 MiB is refused, not parsed", async () => {
    const { transport, events } = setup({ "gmail.labels.list": { stdout_bytes: 8 * 1024 * 1024 + 1 } });
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["transport_incompatible", "output_too_large"]);
    expect(events[0]!.stdout_bytes).toBeGreaterThan(8 * 1024 * 1024);
  });
  test("exactly 8 MiB is read", async () => {
    const { transport } = setup({ "gmail.labels.list": { stdout_bytes: 8 * 1024 * 1024 } });
    // Read in full, then refused as not JSON: the cap did not trip.
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["transport_incompatible", "unexpected_output"]);
  });
  test("stderr never reaches the result or the log, only its size", async () => {
    const secret = "invalid_grant for penelope@example.com: token ya29.suitor";
    const { transport, events } = setup({ "gmail.labels.list": { exit: 1, stderr: secret, stdout: { error: { code: 1, message: secret, class: "error" } } } });
    const result = await transport.execute("gmail.labels.list", {});
    expect(JSON.stringify(result)).not.toContain("penelope");
    expect(JSON.stringify(events)).not.toContain("penelope");
    expect(JSON.stringify(result)).not.toContain("ya29");
    expect(events[0]).toMatchObject({ stderr_bytes: secret.length, outcome: "error", code: "upstream_error" });
  });
  test("an answer that is not JSON, or not gog's shape, is transport_incompatible", async () => {
    const { transport } = setup({ "gmail.labels.list": [{ stdout: "Labels:\nINBOX\n" }, { stdout: { labels: LABELS.labels, extra: 1 } }] });
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["transport_incompatible", "unexpected_output"]);
    expect(errorOf(await transport.execute("gmail.labels.list", {}))).toEqual(["transport_incompatible", "unexpected_shape"]);
  });
});

describe("what a real gog process receives", () => {
  // The offline test guard adds its own Git policy and workspace lease to
  // every child it spawns, and to this one BUN_OPTIONS of exactly
  // `--no-env-file` (scripts/test-network-guard.ts); nothing else may appear
  // beside the allow-list.
  const GUARD = /^(?:GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|BRAIN_WORKSPACE_LEASE)$/;

  test("environment exactly the allow-list, with GOG_* and other host variables set", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      GOG_ACCESS_TOKEN: "ya29.suitor", GOG_ACCOUNT: "suitor", GOG_ENABLE_COMMANDS: "*", GOG_WRAP_UNTRUSTED: "1", GOG_HOME: "/elsewhere",
      XDG_CONFIG_HOME: "/elsewhere", BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "leaked",
    });
    try {
      const { fake, transport } = setup({ "gmail.labels.list": { stdout: LABELS }, "gmail.drafts.create": { stdout: {} } });
      expect((await transport.execute("gmail.labels.list", {})).ok).toBe(true);
      expect((await transport.invoke("gmail.draft.save", write())).ok).toBe(true);
      const calls = fake.calls();
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call.env_names.filter(name => !GUARD.test(name) && !(name === "BUN_OPTIONS" && call.bun_options === "--no-env-file"))).toEqual([...GOG_ENVIRONMENT_NAMES].sort());
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  test("a write's body arrives on stdin; a read's stdin is empty", async () => {
    const { fake, transport } = setup({ "gmail.labels.list": { stdout: LABELS }, "gmail.drafts.create": { stdout: {} } });
    await transport.execute("gmail.labels.list", {});
    await transport.invoke("gmail.draft.save", write());
    const stdin = (command: string) => Buffer.from(fake.callsOf(command)[0]!.stdin_base64, "base64").toString("utf8");
    expect(stdin("gmail.labels.list")).toBe("");
    expect(stdin("gmail.drafts.create")).toBe(BODY);
    expect(fake.callsOf("gmail.drafts.create")[0]!.argv).toContain("--body-file=-");
  });
});

describe("per-account concurrency", () => {
  test(`at most ${GOG_CONCURRENCY.read} reads run at once; the rest wait their turn`, async () => {
    const { fake, transport, account } = setup({});
    fake.setScenario({ "gmail.labels.list": { stdout: LABELS, wait_for: fake.path("open") } });
    const pending = Array.from({ length: 6 }, () => transport.execute("gmail.labels.list", {}));
    const deadline = Date.now() + watchdogMs(20_000);
    while (fake.callsOf("gmail.labels.list").length < 4 && Date.now() < deadline) await Bun.sleep(10);
    expect(gogConcurrencyState(account).read).toEqual({ active: 4, queued: 2 });
    // The queued two have not spawned: the limit is taken before the process starts.
    expect(fake.callsOf("gmail.labels.list")).toHaveLength(4);
    await Bun.write(fake.path("open"), "");
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    expect(fake.callsOf("gmail.labels.list")).toHaveLength(6);
    expect(gogConcurrencyState(account).read).toEqual({ active: 0, queued: 0 });
  });

  test(`at most ${GOG_CONCURRENCY.write} write runs at once, and reads do not wait for it`, async () => {
    const { fake, transport, account } = setup({});
    fake.setScenario({ "gmail.drafts.create": { stdout: {}, wait_for: fake.path("open") }, "gmail.labels.list": { stdout: LABELS } });
    const writes = [transport.invoke("gmail.draft.save", write()), transport.invoke("gmail.draft.save", write())];
    const deadline = Date.now() + watchdogMs(20_000);
    while (fake.callsOf("gmail.drafts.create").length < 1 && Date.now() < deadline) await Bun.sleep(10);
    expect(gogConcurrencyState(account).write).toEqual({ active: 1, queued: 1 });
    expect((await transport.execute("gmail.labels.list", {})).ok).toBe(true);
    expect(fake.callsOf("gmail.drafts.create")).toHaveLength(1);
    await Bun.write(fake.path("open"), "");
    expect((await Promise.all(writes)).every(result => result.ok)).toBe(true);
    expect(fake.callsOf("gmail.drafts.create")).toHaveLength(2);
  });

  test("two transports for one alias share its limits", async () => {
    const first = setup({});
    first.fake.setScenario({ "gmail.drafts.create": { stdout: {}, wait_for: first.fake.path("open") } });
    const second = createGogTransportInternals({ binary: first.fake.binary, account: first.account, environment: first.fake.environment });
    const writes = [first.transport.invoke("gmail.draft.save", write()), second.invoke("gmail.draft.save", write())];
    const deadline = Date.now() + watchdogMs(20_000);
    while (first.fake.callsOf("gmail.drafts.create").length < 1 && Date.now() < deadline) await Bun.sleep(10);
    expect(gogConcurrencyState(first.account).write).toEqual({ active: 1, queued: 1 });
    await Bun.write(first.fake.path("open"), "");
    await Promise.all(writes);
  });
});

describe("the operation boundary", () => {
  test("search reads every hit's thread and carries the union of its labels", async () => {
    const { fake, transport } = setup({
      "gmail.search": { stdout: fixture("search-ids.json") },
      [`gmail.thread.get ${HALL}`]: { stdout: fixture("thread-hall.json") },
      [`gmail.thread.get ${SWINE}`]: { stdout: fixture("thread-swine.json") },
    });
    const result = await transport.execute("gmail.search", { query: "in:inbox", limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_page_token).toBe("09876543210987654321");
    expect(result.value.hits.map(hit => [hit.thread_id, hit.label_ids])).toEqual([
      // Label_12 is on the second message only: gog's own search output would name only the first message's labels.
      [HALL, ["INBOX", "CATEGORY_PERSONAL", "UNREAD", "Label_12"]],
      [SWINE, ["INBOX", "STARRED"]],
    ]);
    expect(fake.callsOf("gmail.search")[0]!.argv).toEqual(expect.arrayContaining(["--ids-only", "--max=2"]));
    expect(fake.callsOf("gmail.thread.get").map(call => call.argv.at(-1)).sort()).toEqual([HALL, SWINE]);
    const projected = structuredGmailSearch(result.value, { cursor: null });
    expect(projected.threads.map(hit => [hit.thread_id, hit.unread, hit.starred, hit.has_attachment, hit.size_bucket])).toEqual([
      [HALL, true, false, false, "under_10kb"], [SWINE, false, true, true, "under_10kb"],
    ]);
  });

  test("a hit whose thread vanished is dropped; any other failed pre-read fails the search", async () => {
    const vanished = setup({
      "gmail.search": { stdout: fixture("search-ids.json") },
      [`gmail.thread.get ${HALL}`]: { exit: 5 }, [`gmail.thread.get ${SWINE}`]: { stdout: fixture("thread-swine.json") },
    });
    const kept = await vanished.transport.execute("gmail.search", { query: "in:inbox" });
    expect(kept.ok && kept.value.hits.map(hit => hit.thread_id)).toEqual([SWINE]);
    const denied = setup({
      "gmail.search": { stdout: fixture("search-ids.json") },
      [`gmail.thread.get ${HALL}`]: { exit: 6 }, [`gmail.thread.get ${SWINE}`]: { stdout: fixture("thread-swine.json") },
    });
    expect(errorOf(await denied.transport.execute("gmail.search", { query: "in:inbox" }))).toEqual(["forbidden", null]);
    const swapped = setup({ "gmail.search": { stdout: fixture("search-ids.json") }, "gmail.thread.get": { stdout: fixture("thread-swine.json") } });
    expect(errorOf(await swapped.transport.execute("gmail.search", { query: "in:inbox" }))).toEqual(["transport_incompatible", "unexpected_shape"]);
  });

  test("a search id that is not a thread id never reaches argv", async () => {
    const { fake, transport } = setup({ "gmail.search": { stdout: { count: 1, has_more: false, nextPageToken: "", threads: [{ id: "--readonly=false" }] } } });
    expect(errorOf(await transport.execute("gmail.search", { query: "in:inbox" }))).toEqual(["transport_incompatible", "unexpected_shape"]);
    expect(fake.callsOf("gmail.thread.get")).toEqual([]);
  });

  test("a search page with more hits than it asked for is refused before any thread read is scheduled", async () => {
    const page = (hits: number) => ({
      count: hits, has_more: false, nextPageToken: "",
      threads: Array.from({ length: hits }, (_, index) => ({ id: `19a0c3d2e4f5${String(index).padStart(4, "0")}` })),
    });
    // Three hits naming two threads still answered more than the two asked for.
    const repeated = { ...page(2), count: 3, threads: [...page(2).threads, page(2).threads[0]!] };
    for (const [input, stdout] of [[{ query: "in:inbox", limit: 2 }, page(30)], [{ query: "in:inbox" }, page(11)], [{ query: "in:inbox", limit: 25 }, page(26)],
      [{ query: "in:inbox", limit: 2 }, repeated]] as const) {
      const { fake, transport } = setup({ "gmail.search": { stdout }, "gmail.thread.get": { stdout: fixture("thread-swine.json") } });
      const result = await transport.execute("gmail.search", input);
      expect(fake.callsOf("gmail.thread.get"), `${stdout.threads.length} hits`).toEqual([]);
      expect(errorOf(result)).toEqual(["transport_incompatible", "page_too_large"]);
    }
  });

  test("an empty search answers an empty page without a pre-read", async () => {
    const { fake, transport } = setup({ "gmail.search": { stdout: fixture("search-empty.json") } });
    expect(await transport.execute("gmail.search", { query: "label:Ithaca" })).toEqual({
      ok: true, value: { hits: [], next_page_token: null, result_size_estimate: null },
    });
    expect(fake.calls().map(call => call.command)).toEqual(["gmail.search"]);
  });

  test("writes have no codec yet, invalid input never runs, and a bad option makes every call unavailable", async () => {
    const { fake, transport } = setup({ "gmail.labels.list": { stdout: LABELS } });
    expect(errorOf(await transport.execute("gmail.modify" as never, { message_ids: [HALL], add_label_ids: ["STARRED"] } as never))).toEqual(["transport_incompatible", "no_codec"]);
    expect(errorOf(await transport.execute("gmail.thread.get", { thread_id: "not-a-thread" }))).toEqual(["invalid_input", "schema"]);
    expect(errorOf(await transport.execute("gmail.search", { query: "in:inbox\nlabel:TRASH" }))).toEqual(["invalid_input", "schema"]);
    expect(errorOf(await transport.execute("gmail.labels.list", { extra: true } as never))).toEqual(["invalid_input", "schema"]);
    expect(fake.calls()).toEqual([]);
    for (const [options, reason] of [
      [{ account: "auto" }, "account"],
      [{ account: "penelope@example.com" }, "account"],
      [{ environment: { home: "relative/home", keyringPassword: "x" } }, "environment_home"],
      [{ environment: { home: "/srv/ithaca", keyringPassword: "" } }, "environment_keyring_password"],
      [{ binary: { kind: "pinned", path: undefined } }, "binary"],
      [{ binary: { kind: "pinned", path: "" } }, "binary"],
      [{ binary: { kind: "fake", path: 7 } }, "binary"],
      [{ binary: { kind: "other", path: "/usr/bin/gog" } }, "binary"],
      [{ binary: undefined }, "binary"],
    ] as const) {
      const broken = createGogTransport({ binary: fake.binary, account: "ithaca", environment: fake.environment, ...options } as never);
      expect(errorOf(await broken.execute("gmail.labels.list", {}))).toEqual(["unavailable", reason]);
      expect(await broken.availability()).toMatchObject({ ok: false, error: { code: "unavailable", reason } });
    }
    expect(fake.calls()).toEqual([]);
  });

  test("a binary that cannot be spawned is transport_incompatible", async () => {
    const { transport } = setup({});
    const missing = createGogTransport({ binary: { kind: "fake", path: join(transport.account, "no-such-binary") }, account: "ithaca", environment: { home: "/nonexistent", keyringPassword: "x" } });
    expect(errorOf(await missing.execute("gmail.labels.list", {}))).toEqual(["transport_incompatible", "spawn_failed"]);
  });
});

test("a failure says nothing about its target only when the account, the input or the binary was refused", () => {
  const independent = [
    gogError("unavailable", "auth_required"), gogError("unavailable", "config"), gogError("rate_limited", null), gogError("invalid_input", "id"),
    gogError("transport_incompatible", "spawn_failed"), gogError("transport_incompatible", "usage"),
    ...GOG_PIN_REFUSALS.map(reason => gogError("transport_incompatible", reason)),
  ];
  for (const failure of independent) {
    expect(isTargetIndependentGogFailure(failure), `GOG_TARGET_INDEPENDENT ${failure.code} ${failure.reason}`).toBe(true);
  }
  // Each of these may be the target's own: a reader that hides labels answers them as a miss.
  const dependent = [
    gogError("not_found", null), gogError("forbidden", null), gogError("upstream_error", "timeout"), gogError("upstream_error", "error"),
    gogError("upstream_error", "signal"), gogError("upstream_error", "retryable"), gogError("upstream_error", "cancelled"),
    gogError("transport_incompatible", "output_too_large"), gogError("transport_incompatible", "unexpected_shape"),
    gogError("transport_incompatible", "unexpected_output"), gogError("transport_incompatible", "page_too_large"),
    gogError("transport_incompatible", "orphaned"), gogError("transport_incompatible", "unknown_exit"),
    gogError("transport_incompatible", "empty_results"), gogError("transport_incompatible", null),
  ];
  for (const failure of dependent) {
    expect(isTargetIndependentGogFailure(failure), `GOG_TARGET_DEPENDENT ${failure.code} ${failure.reason}`).toBe(false);
  }
});
