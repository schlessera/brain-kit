/** Governed pi workers with host-held credentials (#1665); offline, fictional credentials only. */
import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalOrigin, literalValue, piCredentialOrigins, sanitized } from "../src/host-inference.js";

type Result = { hostFetches: string[]; outcomes: Array<string | null>; origins: Array<string | null>; thrown: string | null; refreshes: number; toolFetches: number; toolOutputSeen: boolean; requests: Array<Record<string, string | null>>;
  inference: Array<{ inference: boolean; host: string; path: string | null; outcome: string }>; workerObserved: boolean;
  secretInWorker: boolean; withheldKeys: string | null; hostCredentialFilesVisible: number; workerViewObserved: boolean; placeholderInWorker: boolean; commandRan: boolean; hostRefreshed: boolean; relayLinkRemoved: boolean };
let results: Record<string, Result>;
beforeAll(async () => {
  const root = resolve(import.meta.dir, "../../..");
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-pi-host-relay-"));
  try {
    // The whole probe has no external route; workers nest their own namespaces.
    // Scratch over /opt: a credential store outside every host mask.
    mkdirSync(join(scratch, "opt"));
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--bind", join(scratch, "opt"), "/opt", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/host-relay-probe.ts"), scratch],
    { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir(), HOME: join(scratch, "home") }, stdout: "pipe", stderr: "pipe", timeout: 240_000 });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const parsed = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(parsed.namespace, "PI_RELAY_PROBE_PRIVATE_NETWORK").not.toBe(readlinkSync("/proc/self/ns/net"));
    results = parsed.results;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 250_000);

const relayed = (name: string, request: Record<string, string | null>, host: string) => {
  const result = results[name]!;
  expect(result.thrown, `${name} ran`).toBeNull();
  expect(result.outcomes.every(outcome => outcome === "success"), `${name} succeeded`).toBe(true);
  expect(result.requests, "PI_RELAY_HOST_CREDENTIAL_REACHES_UPSTREAM").toEqual(result.outcomes.map(() => expect.objectContaining(request)));
  expect(result.workerObserved, "PI_RELAY_WORKER_OBSERVED").toBe(true);
  expect(result.secretInWorker, "PI_RELAY_WORKER_HOLDS_NO_CREDENTIAL").toBe(false);
  expect(result.placeholderInWorker).toBe(true);
  expect(result.inference, "PI_RELAY_INFERENCE_RECORDED").toEqual(result.outcomes.map(() => expect.objectContaining({ inference: true, host, outcome: "completed" })));
  expect(result.relayLinkRemoved).toBe(true);
};

test("an API key from the server environment stays on the host, also on a resumed turn", () => {
  relayed("openai-env-key", { path: "/v1/responses", authorization: "openai", apiKey: null }, "api.openai.com");
});
test("keys only the brain CLI reads, and another runtime's login, never reach a relayed worker (#1666)", () => {
  relayed("cli-keys-withheld", { path: "/v1/responses", authorization: "openai", apiKey: null }, "api.openai.com");
  expect(results["cli-keys-withheld"]!.withheldKeys, "PI_RELAY_WORKER_NAMES_WITHHELD_KEYS")
    .toBe("CLAUDE_CODE_OAUTH_TOKEN,GEMINI_API_KEY,OPENAI_API_KEY,TYPESAFE_API_KEY");
});
test("a bash tool keeps its network through the turn proxy, recorded apart from inference", () => {
  const result = results["tool-network"]!;
  expect(result.outcomes).toEqual(["success"]);
  expect(result.toolFetches, "PI_RELAY_TOOL_REACHES_THROUGH_PROXY").toBe(1);
  expect(result.toolOutputSeen, "PI_RELAY_TOOL_OUTPUT_RETURNED").toBe(true);
  expect(result.inference, "PI_RELAY_TOOL_CONNECTION_RECORDED").toEqual([
    expect.objectContaining({ inference: true, host: "api.openai.com", path: "/v1/responses", outcome: "completed" }),
    expect.objectContaining({ inference: false, host: "localhost", path: "/voyage", outcome: "completed" }),
    expect.objectContaining({ inference: true, host: "api.openai.com", path: "/v1/responses", outcome: "completed" }),
  ]);
  expect(result.secretInWorker).toBe(false);
});
test("request data that starts with ! is not a credential command", () => {
  relayed("bang-in-sampling-data", { path: "/v1/responses", authorization: "openai" }, "api.openai.com");
});
test("only pi's environment references count as non-literal, as pi resolves them", () => {
  for (const value of ["$ODYSSEUS_KEY", "${ODYSSEUS_KEY}", "Bearer $ODYSSEUS_KEY", " "]) expect(literalValue(value), value).toBe(false);
  for (const value of ["odysseus-key", "odysseus$$literal", "odysseus$!literal", "odysseus${NOT-A-VARIABLE}", "Bearer odysseus-key"]) {
    expect(literalValue(value), `PI_RELAY_LITERAL_${value}`).toBe(true);
  }
});
test("the worker copy drops only credential and routing fields, never nested model data", () => {
  expect(sanitized({ apiKey: "$K", headers: { a: "b" }, baseUrl: "https://x.invalid", authHeader: true, oauth: "radius",
    compat: { chatTemplateKwargs: { headers: "kept", oauth: "kept" } },
    models: [{ id: "m", baseUrl: "https://x.invalid", headers: { a: "b" }, samplingParams: { stop: ["!END"] } }],
    modelOverrides: { m: { headers: { a: "b" }, name: "Ithaca" } } }), "PI_RELAY_SANITIZE_SCOPE").toEqual({
    compat: { chatTemplateKwargs: { headers: "kept", oauth: "kept" } },
    models: [{ id: "m", samplingParams: { stop: ["!END"] } }], modelOverrides: { m: { name: "Ithaca" } } });
});
test("a configured authorization header wins over the key's own, as in native pi", () => {
  relayed("configured-header-wins", { path: "/v1/responses", authorization: "gateway" }, "api.openai.com");
});
test("inference keys only agent runtimes read stay out of a relayed worker", () => {
  relayed("agent-only-keys", { path: "/v1/responses", authorization: "openai" }, "api.openai.com");
});
test("an unlisted origin is refused before the stored login is read or refreshed", () => {
  const result = results["codex-custom-unlisted-expired"]!;
  expect(result.refreshes, "PI_RELAY_UNLISTED_ORIGIN_NO_CREDENTIAL_USE").toBe(0);
  expect(result.thrown ?? "", "PI_RELAY_REFUSED_BEFORE_LAUNCH").toContain("may not receive openai-codex's credential");
  expect(result.requests).toEqual([]);
});
test("pi's credential files outside every host mask are masked in the worker", () => {
  relayed("stored-key-outside-masks", { path: "/v1/responses", authorization: "openai" }, "api.openai.com");
  expect(results["stored-key-outside-masks"]!.workerViewObserved, "PI_RELAY_WORKER_VIEW_OBSERVED").toBe(true);
  expect(results["stored-key-outside-masks"]!.hostCredentialFilesVisible, "PI_RELAY_HOST_CREDENTIAL_FILES_MASKED").toBe(0);
});
test("a Codex login keeps its native request: account header, zstd body, host bearer", () => {
  relayed("codex-oauth", { path: "/backend-api/codex/responses", authorization: "codex", account: "odysseus-account", encoding: "zstd" }, "chatgpt.com");
});
test("an expired Codex login refreshes on the host and the rotation is written back there", () => {
  relayed("codex-oauth-expired", { authorization: "codexRefreshed", account: "odysseus-account-refreshed" }, "chatgpt.com");
  expect(results["codex-oauth-expired"]!.refreshes).toBe(1);
  expect(results["codex-oauth-expired"]!.hostRefreshed, "PI_RELAY_HOST_REFRESH_WRITEBACK").toBe(true);
});
test("an Anthropic login keeps its OAuth request shape", () => {
  relayed("anthropic-oauth", { path: "/v1/messages", authorization: "anthropicOAuth", apiKey: null, beta: "claude-code-20250219,oauth-2025-04-20" }, "api.anthropic.com");
});
test("a custom origin listed for the provider receives its key, read from a template variable the worker never sees", () => {
  relayed("anthropic-custom-listed", { path: "/v1/messages", apiKey: "anthropic", authorization: null }, "127.0.0.1");
});
for (const [name, reason] of [
  ["anthropic-custom-unlisted", "may not receive anthropic's credential; list it as anthropic="],
  ["anthropic-custom-other-provider", "may not receive anthropic's credential; list it as anthropic="],
  ["command-key-models", "models.json runs a command"],
  ["command-key-stored", "stored key for openai runs a command"],
  ["command-header", "models.json runs a command"],
  ["command-model-override-header", "models.json runs a command"],
  ["radius-overlay", "its own login implementation"],
  ["brain-models-literal-key", "linked into the brain and holds a credential"],
  ["brain-models-other-provider", "linked into the brain and holds a credential"],
  ["brain-models-escaped-literal", "linked into the brain and holds a credential"],
  ["copilot-oauth", "uses an OAuth login on the anthropic-messages API, which the relay does not carry"],
  ["auth-in-brain", "auth.json is linked into the brain"],
] as const) test(`${name} is refused before launch, with nothing sent and no command run`, () => {
  const result = results[name]!;
  expect(result.commandRan, "PI_RELAY_HOST_NEVER_RUNS_A_CREDENTIAL_COMMAND").toBe(false);
  expect(result.hostFetches, "PI_RELAY_REFUSAL_NO_HOST_CREDENTIAL_TRAFFIC").toEqual([]);
  expect(result.requests, "PI_RELAY_REFUSAL_SENDS_NOTHING").toEqual([]);
  expect(result.thrown ?? "", "PI_RELAY_REFUSED_BEFORE_LAUNCH").toContain(reason);
  expect(result.workerObserved).toBe(false);
});

test("BRAIN_UI_PI_CREDENTIAL_ORIGINS keys exact origins by provider and refuses anything else", () => {
  expect([...piCredentialOrigins(" openai-codex = https://gateway.ithaca.invalid ; anthropic=https://a.ithaca.invalid,http://127.0.0.1:8443;").entries()])
    .toEqual([["openai-codex", ["https://gateway.ithaca.invalid"]], ["anthropic", ["https://a.ithaca.invalid", "http://127.0.0.1:8443"]]]);
  expect(piCredentialOrigins(undefined).size).toBe(0);
  for (const value of ["https://gateway.ithaca.invalid", "=https://a.invalid", "anthropic=", "anthropic=https://a.invalid/v1",
    "anthropic=https://user@a.invalid", "anthropic=https://*.ithaca.invalid", "anthropic=ftp://a.invalid"]) {
    expect(() => piCredentialOrigins(value), value).toThrow("BRAIN_UI_PI_CREDENTIAL_ORIGINS");
  }
  expect(canonicalOrigin("https://GATEWAY.ithaca.invalid:443")).toBe("https://gateway.ithaca.invalid");
});

test("the backend names the origin a relayed turn reaches, for a new and a resumed conversation (#2695)", () => {
  expect(results["openai-env-key"]!.origins, "PI_ORIGIN_FROM_PROFILE_AND_SAVED_MODEL").toEqual(["https://api.openai.com", "https://api.openai.com"]);
  expect(results["anthropic-custom-listed"]!.origins, "PI_ORIGIN_FOLLOWS_MODELS_JSON").toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);
  expect(results["codex-custom-unlisted-expired"]!.origins, "PI_ORIGIN_IS_NOT_AUTHORIZATION").toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);
});
test("a turn admitted for one recipient's origin reaches only that origin (#2695)", () => {
  relayed("recipient-admitted", { path: "/v1/responses", authorization: "openai", apiKey: null }, "api.openai.com");
  const other = results["recipient-other"]!;
  expect(other.thrown, "PI_OTHER_RECIPIENT_REFUSED").toContain("the recipient this turn's provider folders were admitted for");
  expect(other.hostFetches, "PI_OTHER_RECIPIENT_NO_HOST_CREDENTIAL_TRAFFIC").toEqual([]);
  expect(other.requests, "PI_OTHER_RECIPIENT_SENDS_NOTHING").toEqual([]);
});
