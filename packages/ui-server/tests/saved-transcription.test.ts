import { expect, test, spyOn } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SpeechTranscriptionError, type SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { httpContractApp } from "./helpers/http-contract-app";
import { MAX_TRANSCRIPTION_BYTES } from "../src/routes/transcriptions";
import { createDeepgramSpeechProvider } from "../src/voice/speech-providers";

const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const path = (id: string) => `/api/voice/recordings/${id}/transcription`;
function put(bytes = audio, headers = {}): RequestInit {
  return { method: "PUT", headers: { "content-type": "audio/webm;codecs=opus", "content-sha256": hash(bytes), ...headers }, body: bytes };
}
function fake(call: NonNullable<SpeechProvider["transcribeRecording"]>): SpeechProvider {
  return { id: "fixture-speech", capabilities: { streaming: false, interimResults: false, endpointing: false, keyterms: false }, createSession: async () => { throw new Error("No session may be minted"); }, transcribeRecording: call };
}

test("concurrent real route requests dispatch exactly once and repeated done reuses one transcript", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async input => { calls++; expect(input.audio).toEqual(audio); await gate; return { text: "Odysseus reaches Ithaca." }; }) });
  try {
    const id = randomUUID();
    const capabilities = await t.fetch("/api/voice/capabilities");
    expect((await capabilities.json()).capabilities.savedAudio).toBe(true); expect(calls).toBe(0);
    const first = t.fetch(path(id), put());
    await Bun.sleep(20);
    const pending = Array.from({ length: 8 }, () => t.fetch(path(id), put()));
    await Bun.sleep(50);
    expect(calls, "only one provider call under concurrent PUTs").toBe(1);
    const repeats = await Promise.all(pending);
    expect(repeats.map(r => r.status)).toEqual(Array(8).fill(409));
    expect((await (await t.fetch(path(id))).json()).status).toBe("transcribing");
    release(); const done = await (await first).json();
    expect(done.status).toBe("done"); expect(done.text).toBe("Odysseus reaches Ithaca.");
    expect(await (await t.fetch(path(id), put())).json()).toEqual(done);
    expect(calls, "done receipts never redispatch").toBe(1);
    const changed = await t.fetch(path(id), put(new Uint8Array([1, 4, 5])));
    expect(changed.status).toBe(409); expect((await changed.json()).error).toBe("recording_hash_mismatch");
  } finally { release(); await t.close(); }
});

for (const status of [500, 503, 504, 429, 408, 400, 401, 403, 415, 422]) test(`definitive ${status} classification and atomic three-retry limit`, async () => {
  let calls = 0;
  // Deliberately lie about the reason: HTTP evidence must control retryability.
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; throw new SpeechTranscriptionError("provider_error", status); }) });
  try {
    const id = randomUUID();
    let receipt = await (await t.fetch(path(id), put())).json();
    const retryable = [500, 503, 504, 429, 408].includes(status);
    expect(receipt.status).toBe("failed"); expect(receipt.failure.retryable).toBe(retryable);
    expect(receipt.failure.reason).toBe(status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status === 504 || status === 408 ? "provider_timeout" : status >= 500 ? "provider_error" : "validation");
    expect((await t.fetch(path(id), put())).status).toBe(409); expect(calls).toBe(1);
    if (!retryable) {
      expect((await (await t.fetch(`${path(id)}?retry=${receipt.attemptId}`, put())).json()).error).toBe("transcription_not_retryable");
      expect(calls).toBe(1); return;
    }
    const stale = receipt.attemptId;
    for (let n = 1; n <= 3; n++) {
      const attempts = await Promise.all(Array.from({ length: 6 }, () => t.fetch(`${path(id)}?retry=${receipt.attemptId}`, put())));
      const winner = attempts.find(r => r.status === 200)!;
      expect(attempts.filter(r => r.status === 200)).toHaveLength(1);
      receipt = await winner.json();
      expect(receipt.retryCount).toBe(n); expect(calls, "concurrent retries dispatch one call").toBe(n + 1);
      expect(receipt.failures).toHaveLength(n + 1);
    }
    expect((await (await t.fetch(`${path(id)}?retry=${receipt.attemptId}`, put())).json()).error).toBe("transcription_retry_limit");
    expect((await t.fetch(`${path(id)}?retry=${stale}`, put())).status).toBe(409);
    expect(calls, "retry ceiling cannot be bypassed").toBe(4);
  } finally { await t.close(); }
});

test("lost replies stay terminal and tombstones defeat delayed claims and stale completion", async () => {
  let calls = 0;
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; throw new Error("Lost response"); }) });
  try {
    const id = randomUUID(); const receipt = await (await t.fetch(path(id), put())).json();
    expect(receipt.status).toBe("outcome_unknown"); expect(receipt.failure.retryable).toBe(false);
    expect((await t.fetch(`${path(id)}?retry=${receipt.attemptId}`, put())).status).toBe(409); expect(calls).toBe(1);
    for (const target of [id, randomUUID()]) {
      const removed = await t.fetch(`${path(target)}?disposition=discarded`, { method: "DELETE" });
      expect(removed.status).toBe(200); expect((await removed.json()).status).toBe("consumed");
      expect((await t.fetch(path(target), put())).status).toBe(410);
    }
    expect(calls).toBe(1);
  } finally { await t.close(); }
});

test("proxy account B cannot read, trigger, retry or delete account A's receipt", async () => {
  let calls = 0;
  const t = await httpContractApp({ env: { AUTH_MODE: "proxy", TRUST_PROXY: "1", PROXY_AUTH_HEADER: "x-forwarded-user", VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; return { text: "Penelope's loom order." }; }) });
  try {
    const id = randomUUID();
    expect((await t.fetch(path(id), put(audio, { "x-forwarded-user": "penelope" }))).status).toBe(200);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await t.fetch(`${path(id)}?disposition=discarded&retry=fixture`, method === "PUT" ? put(audio, { "x-forwarded-user": "telemachus" }) : { method, headers: { "x-forwarded-user": "telemachus" } });
      expect(response.status, `cross-account ${method}`).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain("loom");
    }
    expect((await t.fetch(path(id))).status).toBe(401); expect(calls).toBe(1);
  } finally { await t.close(); }
});

test("hash, empty media, declared and streamed size caps refuse before provider dispatch", async () => {
  let calls = 0;
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; return { text: "Ithaca" }; }) });
  try {
    const id = randomUUID();
    expect((await t.fetch(path(id), put(audio, { "content-sha256": "0".repeat(64) }))).status).toBe(400);
    expect((await t.fetch(path(id), put(new Uint8Array()))).status).toBe(400);
    expect((await t.fetch(path(id), put(audio, { "content-type": "application/json" }))).status).toBe(415);
    expect((await t.fetch(path(id), put(audio, { "content-length": String(MAX_TRANSCRIPTION_BYTES + 1) }))).status).toBe(413);
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_TRANSCRIPTION_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } });
    expect((await t.fetch(path(id), { ...put(), body, duplex: "half" } as RequestInit)).status).toBe(413);
    expect(calls).toBe(0); expect((await t.fetch(path(id))).status).toBe(404);
  } finally { await t.close(); }
});

for (const status of [200, 400, 401, 429, 504]) test(`Deepgram saved request uses raw container without encoding and classifies ${status}`, async () => {
  const transport: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.has("encoding")).toBe(false); expect(url.searchParams.get("mip_opt_out")).toBe("true");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.getAll("keyterm")).toEqual(["Ithaca"]);
    expect(new Headers(init?.headers).get("authorization")).toBe("Token fixture-key");
    expect(new Headers(init?.headers).get("content-type")).toBe("audio/mp4"); expect(init?.body).toEqual(audio);
    return status === 200 ? Response.json({ results: { channels: [{ alternatives: [{ transcript: "Odysseus sails." }] }] } }) : new Response("definitive refusal", { status });
  }, { preconnect: fetch.preconnect });
  const mock = spyOn(globalThis, "fetch").mockImplementation(transport);
  try {
    const call = createDeepgramSpeechProvider("fixture-key").transcribeRecording!({ audio, contentType: "audio/mp4", keyterms: ["Ithaca", "x".repeat(501)], signal: new AbortController().signal });
    if (status === 200) expect(await call).toEqual({ text: "Odysseus sails." });
    else await expect(call).rejects.toMatchObject({ providerStatus: status });
  } finally { mock.mockRestore(); }
});

test("agent principals cannot read or trigger transcription; revocation during upload commits nothing", async () => {
  const { generateSignedCookie } = await import("hono/cookie");
  const { createPrincipal, revokePrincipal } = await import("../src/db/principals");
  const secret = "odysseus-transcription-cookie-secret";
  let calls = 0;
  const t = await httpContractApp({ env: { AUTH_MODE: "password", COOKIE_SECRET: secret, BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; return { text: "Ithaca" }; }) });
  try {
    const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 3600 });
    const agent = createPrincipal(t.app.db, { authMethod: "delegated", label: "Eurylochus delegate", createdBy: owner.id, ttlSeconds: 3600 });
    const cookie = async (id: string) => (await generateSignedCookie("brain_ui_session", id, secret)).split(";")[0]!;
    const agentCookie = await cookie(agent.id); const ownerCookie = await cookie(owner.id); const id = randomUUID();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await t.fetch(`${path(id)}?disposition=discarded`, method === "PUT" ? put(audio, { cookie: agentCookie }) : { method, headers: { cookie: agentCookie } });
      expect(response.status, `agent ${method} refused`).toBe(403);
    }
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(audio); close = () => c.close(); } });
    const pending = t.fetch(path(id), { ...put(audio, { cookie: ownerCookie }), body, duplex: "half" } as RequestInit);
    await Bun.sleep(20); revokePrincipal(t.app.db, owner.id, Date.now()); close();
    expect((await pending).status, "recheck after reading body").toBe(401);
    expect(calls).toBe(0); expect(t.app.db.query("SELECT * FROM recording_transcriptions").all()).toHaveLength(0);
  } finally { await t.close(); }
});

test("deletion during dispatch leaves a tombstone that stale completion cannot replace", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; await gate; return { text: "Penelope's private loom order." }; }) });
  try {
    const id = randomUUID(); const pending = t.fetch(path(id), put()); await Bun.sleep(20);
    expect(calls).toBe(1);
    expect((await (await t.fetch(`${path(id)}?disposition=accepted`, { method: "DELETE" })).json()).status).toBe("consumed");
    release(); const result = await (await pending).json();
    expect(result.status, "stale provider result cannot undo tombstone").toBe("consumed"); expect(result.text).toBeUndefined();
    expect((await t.fetch(path(id), put())).status).toBe(410); expect(calls).toBe(1);
  } finally { release(); await t.close(); }
});

test("startup recovery makes outstanding attempts terminal and retains done receipts after principal pruning", async () => {
  const { createTranscriptionStore } = await import("../src/voice/transcription-store");
  const { createAccountPartitionKeys } = await import("../src/middleware/account-partition");
  let calls = 0;
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; return { text: "Odysseus reaches Ithaca." }; }) });
  try {
    const id = randomUUID(); const done = await (await t.fetch(path(id), put())).json();
    const row = t.app.db.query("SELECT account_key, principal_id FROM recording_transcriptions WHERE recording_id = ?").get(id) as { account_key: string; principal_id: string };
    const interrupted = randomUUID();
    t.app.db.query("INSERT INTO recording_transcriptions (recording_id, account_key, principal_id, sha256, status, attempt_id) VALUES (?, ?, ?, ?, 'transcribing', 'crashed-attempt')").run(interrupted, row.account_key, row.principal_id, hash(audio));
    createTranscriptionStore(t.app.db, createAccountPartitionKeys(t.app.db, t.brainPath, "none"));
    const unknown = await (await t.fetch(path(interrupted))).json();
    expect(unknown.status, "restart never redispatches possibly processed audio").toBe("outcome_unknown");
    expect(unknown.failures).toEqual([{ reason: "outcome_unknown", retryable: false, attemptId: "crashed-attempt" }]);
    expect((await t.fetch(`${path(interrupted)}?retry=crashed-attempt`, put())).status).toBe(409);
    t.app.db.query("DELETE FROM principals WHERE id = ?").run(row.principal_id);
    expect(await (await t.fetch(path(id), put())).json(), "new login principal reuses durable same-account result").toEqual(done);
    expect(calls).toBe(1);
  } finally { await t.close(); }
});

test("optional capability declarations must match the method and Web Speech refuses saved audio", async () => {
  for (const withMethod of [true, false]) {
    const provider = fake(async () => ({ text: "Ithaca" }));
    provider.capabilities.savedAudio = !withMethod;
    if (!withMethod) delete provider.transcribeRecording;
    const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: provider });
    try { expect((await t.fetch("/api/voice/capabilities")).status).toBe(500); expect((await t.fetch(path(randomUUID()), put())).status).toBe(500); }
    finally { await t.close(); }
  }
  const webspeech = await httpContractApp();
  try {
    expect((await (await webspeech.fetch("/api/voice/capabilities")).json()).capabilities.savedAudio).toBe(false);
    expect((await webspeech.fetch(path(randomUUID()), put())).status).toBe(501);
  } finally { await webspeech.close(); }
});

for (const reason of ["outcome_unknown", "authentication", "media", "parameters", "validation"] as const) test(`explicit terminal ${reason} cannot gain a retry from a conflicting transient status`, async () => {
  let calls = 0;
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; throw new SpeechTranscriptionError(reason, 503); }) });
  try {
    const id = randomUUID(), receipt = await (await t.fetch(path(id), put())).json();
    expect(receipt.failure.retryable, "terminal classification cannot be upgraded by HTTP evidence").toBe(false);
    expect(receipt.failure.reason).toBe(reason);
    expect(receipt.status).toBe(reason === "outcome_unknown" ? "outcome_unknown" : "failed");
    expect((await t.fetch(`${path(id)}?retry=${receipt.attemptId}`, put())).status).toBe(409);
    expect(calls).toBe(1);
  } finally { await t.close(); }
});

test("UUID case aliases share one receipt, account boundary and permanent tombstone", async () => {
  let calls = 0;
  const t = await httpContractApp({ env: { AUTH_MODE: "proxy", TRUST_PROXY: "1", PROXY_AUTH_HEADER: "x-forwarded-user", VOICE_PROVIDER: "fixture-speech" }, speechProvider: fake(async () => { calls++; return { text: "Penelope's loom order." }; }) });
  try {
    const id = `aaaaaaaa-${randomUUID().slice(9)}`, alias = id.toUpperCase();
    const owner = { "x-forwarded-user": "penelope" }, other = { "x-forwarded-user": "telemachus" };
    const done = await (await t.fetch(path(id), put(audio, owner))).json();
    const replay = await t.fetch(path(alias), put(audio, owner));
    expect(calls, "UUID spelling cannot cause a second provider dispatch").toBe(1);
    expect(await replay.json()).toEqual(done);
    expect(await (await t.fetch(path(alias), { headers: owner })).json()).toEqual(done);
    expect((await t.fetch(path(alias), put(new Uint8Array([4, 5]), owner))).status).toBe(409);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await t.fetch(`${path(alias)}?disposition=discarded`, method === "PUT" ? put(audio, other) : { method, headers: other });
      expect(response.status, `UUID alias cannot bypass cross-account ${method}`).toBe(404);
    }
    await t.fetch(`${path(alias)}?disposition=discarded`, { method: "DELETE", headers: owner });
    expect((await t.fetch(path(id), put(audio, owner))).status).toBe(410);
    const fresh = `aaaaaaaa-${randomUUID().slice(9)}`;
    await t.fetch(`${path(fresh.toUpperCase())}?disposition=discarded`, { method: "DELETE", headers: owner });
    expect((await t.fetch(path(fresh), put(audio, owner))).status).toBe(410);
    expect(calls).toBe(1);
  } finally { await t.close(); }
});
