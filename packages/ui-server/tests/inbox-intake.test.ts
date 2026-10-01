import { generateSignedCookie } from "hono/cookie";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { pruneShareStaging } from "../src/share/staging.js";
import { writeFile, chmod, mkdir, utimes, readFile } from "node:fs/promises";
import { createRecordingObservability } from "../src/observability/index.js";
import { createApp } from "../src/app.js";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInboxStore } from "../src/inbox/store.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createTestApp, type TestApp } from "./helpers/test-app.js";

const SECRET = "intake-fixture-cookie-secret-0123456789";
let fixture: TestApp;
let cookie: string;
let principalId: string;
let startedTurns = 0;
beforeAll(async () => {
  const backend = makeFakeBackend({ id: "fixture", startTurn: async () => { startedTurns++; } });
  fixture = await createTestApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: Bun.password.hashSync("odysseus-fixture"), COOKIE_SECRET: SECRET }, appOptions: {
    observability: createRecordingObservability(),
    registry: createStaticBackendRegistry([backend], backend.id),
  } });
  const principal = createPrincipal(fixture.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  principalId = principal.id;
  cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
});
afterAll(async () => { await fixture?.teardown(); });

function share(url: string, extras: Record<string, string> = {}) {
  const body = new FormData();
  body.set("url", url);
  for (const [key, value] of Object.entries(extras)) body.set(key, value);
  return fixture.fetch("/api/share", { method: "POST", body, headers: { cookie } });
}

test("mounted share replay creates one untrusted thread, triage item and staging area", async () => {
  const first = await share("https://example.org/odysseus-route");
  expect(first.status).toBe(201);
  const firstBody = await first.json();
  const firstSnapshot = createInboxStore(fixture.app.db).snapshot();
  expect(firstSnapshot.threads).toHaveLength(1);
  expect(firstSnapshot.items).toHaveLength(1);
  expect(firstSnapshot.threads[0]!.trustClass).toBe("untrusted");
  expect(firstSnapshot.threads[0]!.source).toBe("share");
  expect(firstSnapshot.items[0]!.type).toBe("triage");
  const repeated = await share("https://example.org/odysseus-route");
  expect(repeated.status).toBe(201);
  expect(await repeated.json()).toEqual(firstBody);
  const snapshot = createInboxStore(fixture.app.db).snapshot();
  expect(snapshot.threads).toHaveLength(1);
  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.threads[0]!.lastSeenAt).toBeGreaterThanOrEqual(firstSnapshot.threads[0]!.lastSeenAt);
  expect((await readdir(join(fixture.brainPath, ".brain-ui/inbox"))).filter(name => !name.startsWith("."))).toEqual([firstBody.id]);
  expect(fixture.app.db.query("SELECT COUNT(*) AS n FROM activity_run_rollups").get()).toEqual({ n: 0 });
  expect(startedTurns).toBe(0);
});

test("mounted share rejects an attempted trust override before staging", async () => {
  const response = await share("https://example.org/forged", { trustClass: "trusted" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_form" });
});

test("legacy share application metadata stays ignored while authority aliases are refused", async () => {
  expect((await share("https://example.org/odysseus-metadata", { campaign: "homecoming" })).status).toBe(201);
  for (const key of ["trust_class", "Profile-ID", "principal", "principal_id", "capabilities"]) {
    expect((await share("https://example.org/forged", { [key]: "forged" })).status).toBe(400);
  }
});

test("racing mounted shares retain one staging area and immutable principal provenance", async () => {
  const before = createInboxStore(fixture.app.db).snapshot();
  const responses = await Promise.all(Array.from({ length: 3 }, () => share("https://example.org/odysseus-race")));
  expect(responses.map(response => response.status)).toEqual([201, 201, 201]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2]).toEqual(bodies[0]);
  const snapshot = createInboxStore(fixture.app.db).snapshot();
  expect(snapshot.items.length - before.items.length).toBe(1);
  expect(snapshot.threads.length - before.threads.length).toBe(1);
  const receipt = fixture.app.db.query("SELECT source, principal_id, state FROM inbox_intake_receipts WHERE staging_id = ?").get(bodies[0].id);
  expect(receipt).toEqual({ source: "share", principal_id: principalId, state: "committed" });
  expect(() => fixture.app.db.query("UPDATE inbox_intake_receipts SET principal_id = 'forged' WHERE staging_id = ?").run(bodies[0].id)).toThrow("immutable");
  const dirs = await readdir(join(fixture.brainPath, ".brain-ui/inbox"));
  expect(dirs.filter(id => bodies.some(body => body.id === id))).toEqual([bodies[0].id]);
  expect(dirs).toHaveLength(snapshot.items.length);
});

test("separate real apps sharing the operational database deduplicate racing multipart bytes", async () => {
  const backend = makeFakeBackend({ id: "fixture" });
  const second = await createApp({ config: fixture.app.config, observability: createRecordingObservability(),
    registry: createStaticBackendRegistry([backend], backend.id) });
  const before = createInboxStore(fixture.app.db).snapshot();
  const upload = (fetcher: typeof fixture.app.fetch, bytes: string) => {
    const body = new FormData();
    body.set("title", "Odysseus map");
    body.set("files", new File([bytes], "map.txt", { type: "text/plain" }));
    return fetcher(new Request("http://localhost/api/share", { method: "POST", body, headers: { cookie } }));
  };
  try {
    const responses = await Promise.all([upload(fixture.app.fetch, "route one"), upload(second.fetch, "route one")]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await Bun.file(join(fixture.brainPath, bodies[0].files[0].path)).text()).toBe("route one");
    const changed = await upload(second.fetch, "route two");
    expect(changed.status).toBe(201);
    expect((await changed.json()).id).not.toBe(bodies[0].id);
    const after = createInboxStore(fixture.app.db).snapshot();
    expect(after.items.length - before.items.length).toBe(2);
    expect(after.threads.length - before.threads.length).toBe(2);
    expect(await readdir(join(fixture.brainPath, ".brain-ui/inbox"))).toHaveLength(after.items.length);
  } finally { await second.close(); }
});

test("staging followed by a database failure rolls back work and compensates files before retry", async () => {
  const db = fixture.app.db;
  expect((await share("https://example.org/odysseus-compensation-baseline")).status).toBe(201);
  const before = createInboxStore(db).snapshot();
  const dirs = await readdir(join(fixture.brainPath, ".brain-ui/inbox"));
  db.exec("CREATE TEMP TRIGGER intake_fail BEFORE INSERT ON inbox_threads BEGIN SELECT RAISE(ABORT, 'fixture DB failure'); END");
  try {
    const failed = await share("https://example.org/odysseus-retry");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "share_failed" });
    expect(createInboxStore(db).snapshot()).toEqual(before);
    expect((await readdir(join(fixture.brainPath, ".brain-ui/inbox"))).sort()).toEqual(dirs.sort());
    expect(db.query("SELECT COUNT(*) AS n FROM inbox_intake_receipts WHERE state != 'committed'").get()).toEqual({ n: 0 });
  } finally { db.exec("DROP TRIGGER intake_fail"); }
  expect((await share("https://example.org/odysseus-retry")).status).toBe(201);
  expect(createInboxStore(db).snapshot().items.length - before.items.length).toBe(1);
});

test("recovery compensates an abandoned preparation and preserves committed bytes past the legacy TTL", async () => {
  const id = crypto.randomUUID();
  const dir = join(fixture.brainPath, ".brain-ui/inbox", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), "abandoned bytes");
  fixture.app.db.query("INSERT INTO inbox_intake_receipts (staging_id, source, principal_id, dedup_key, content_hash, created_at, reconcile_after, state) VALUES (?, 'share', ?, 'share:abandoned', 'hash', 0, 0, 'preparing')").run(id, principalId);
  const intake = createInboxIntake(fixture.app.db, fixture.brainPath);
  await intake.reconcile();
  expect(await Bun.file(join(dir, "meta.json")).exists()).toBe(false);
  expect(fixture.app.db.query("SELECT 1 FROM inbox_intake_receipts WHERE staging_id = ?").get(id)).toBeNull();
  const response = await share("https://example.org/odysseus-retained");
  const body = await response.json();
  const committedDir = join(fixture.brainPath, body.dir);
  await utimes(committedDir, new Date(0), new Date(0));
  await pruneShareStaging(fixture.brainPath, Date.now(), undefined, intake.protectedIds());
  expect(await Bun.file(join(committedDir, "meta.json")).exists()).toBe(true);
  await intake.close();
});

test("authority overrides are rejected by both mounted endpoints", async () => {
  for (const key of ["trustClass", "source", "profile", "principalId", "allowedTools", "targetPath"]) {
    expect((await share("https://example.org/forged", { [key]: "forged" })).status).toBe(400);
    const response = await fixture.fetch("/api/queue", { method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "forged", text: "Odysseus", [key]: "forged" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
});

test("the operational database independently refuses a duplicate intake key", async () => {
  expect((await share("https://example.org/odysseus-unique-baseline")).status).toBe(201);
  const db = fixture.app.db;
  const row = db.query("SELECT * FROM inbox_items LIMIT 1").get() as Record<string, string | number | null>;
  expect(row).not.toBeNull();
  const copy = { ...row, id: crypto.randomUUID(), data_json: JSON.stringify({ ...JSON.parse(row.data_json as string), id: crypto.randomUUID() }) };
  const columns = Object.keys(copy);
  expect(() => db.query(`INSERT INTO inbox_items (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(copy))).toThrow("UNIQUE constraint failed: inbox_items.dedup_key");
});

test("revocation while the mounted route awaits its body prevents intake", async () => {
  const principal = createPrincipal(fixture.app.db, { authMethod: "delegated", createdBy: principalId, label: "Odysseus pending upload", ttlSeconds: 3600 });
  const pendingCookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
  let pulled!: () => void;
  const reading = new Promise<void>(resolve => { pulled = resolve; });
  let release!: () => void;
  const content = new TextEncoder().encode(JSON.stringify({ key: "odysseus-revoked-in-flight", text: "Odysseus" }));
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    pulled();
    return new Promise<void>(resolve => { release = () => { controller.enqueue(content); controller.close(); resolve(); }; });
  } }, { highWaterMark: 0 });
  const before = createInboxStore(fixture.app.db).snapshot();
  const response = fixture.fetch("/api/queue", { method: "POST", headers: { cookie: pendingCookie, "content-type": "application/json" }, body });
  await reading;
  revokePrincipal(fixture.app.db, principal.id, Date.now());
  release();
  expect((await response).status).toBe(401);
  expect(createInboxStore(fixture.app.db).snapshot()).toEqual(before);
});

async function runCli(server: string, credentialFile?: string, key = "odysseus-cli", text = "Plan a route for Odysseus") {
  const process = Bun.spawn([Bun.which("bun")!, join(import.meta.dir, "../../core/src/cli/brain.ts"), "queue", "add",
    "--server", server, "--key", key, "--text", text, "--json", ...(credentialFile ? ["--credential-file", credentialFile] : [])], {
    cwd: fixture.brainPath, env: { PATH: globalThis.process.env.PATH, BRAIN_ROOT: fixture.brainPath }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { exit, stderr, body: stdout ? JSON.parse(stdout) : null };
}

test("real CLI queues trusted work, survives a lost response and rejects wrong, revoked or mismatched credentials", async () => {
  let discardNextResponse = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const response = await fixture.app.fetch(request);
    if (discardNextResponse && response.status === 201) {
      discardNextResponse = false;
      return new Response("Committed response lost", { status: 503 });
    }
    return response;
  } });
  const origin = server.url.origin;
  const credentialFile = join(fixture.brainPath, "queue-credential.json");
  const principal = createPrincipal(fixture.app.db, { authMethod: "delegated", createdBy: principalId, label: "Odysseus CLI", ttlSeconds: 3600 });
  const rawCookie = decodeURIComponent((await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!.split("=").slice(1).join("="));
  await writeFile(credentialFile, JSON.stringify({ server: origin, cookie: rawCookie }), { mode: 0o600 });
  try {
    const first = await runCli(origin, credentialFile);
    expect(first.stderr).toBe("");
    expect(first.exit).toBe(0);
    expect(first.body.queued).toBe(true);
    expect(first.body.created).toBe(true);
    const store = createInboxStore(fixture.app.db);
    const thread = store.getThread(first.body.threadId)!;
    expect(thread.trustClass).toBe("trusted");
    expect(thread.source).toBe("cli");
    const manifest = JSON.parse(await readFile(join(fixture.brainPath, ".brain-ui/inbox", first.body.stagingId, "meta.json"), "utf8"));
    expect(manifest.source).toBe("cli");
    const receipt = fixture.app.db.query("SELECT principal_id FROM inbox_intake_receipts WHERE staging_id = ?").get(first.body.stagingId);
    expect(receipt).toEqual({ principal_id: principal.id });
    discardNextResponse = true;
    const lost = await runCli(origin, credentialFile, "odysseus-lost-response");
    expect(lost.exit).toBe(2);
    expect(lost.body.error?.code).toBe("queue_failed");
    const recovered = await runCli(origin, credentialFile, "odysseus-lost-response");
    expect(recovered.exit).toBe(0);
    expect(recovered.body.created).toBe(false);
    expect(fixture.app.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE dedup_key = 'cli:odysseus-lost-response'").get()).toEqual({ n: 1 });
    // A successful response replay also cannot mint a second item.
    const replay = await runCli(origin, credentialFile);
    expect(replay.exit).toBe(0);
    expect(replay.body).toEqual({ ...first.body, created: false });
    expect(store.getThread(first.body.threadId)!.lastSeenAt).toBeGreaterThan(thread.lastSeenAt);
    expect((await runCli(origin, credentialFile, "odysseus-cli", "Different bytes")).body.error?.code).toBe("key_conflict");
    expect((await runCli(origin)).body.error?.code).toBe("unauthorized");
    await writeFile(credentialFile, JSON.stringify({ server: origin, cookie: rawCookie.replace(/^./, rawCookie[0] === "a" ? "b" : "a") }));
    expect((await runCli(origin, credentialFile)).body.error?.code).toBe("unauthorized");
    await writeFile(credentialFile, JSON.stringify({ server: "https://example.org", cookie: rawCookie }));
    expect((await runCli(origin, credentialFile)).body.error?.code).toBe("credential_file_invalid");
    await writeFile(credentialFile, JSON.stringify({ server: origin, cookie: rawCookie }));
    await chmod(credentialFile, 0o644);
    expect((await runCli(origin, credentialFile)).body.error?.code).toBe("credential_file_invalid");
    await chmod(credentialFile, 0o600);
    revokePrincipal(fixture.app.db, principal.id, Date.now());
    expect((await runCli(origin, credentialFile)).body.error?.code).toBe("unauthorized");
    expect(startedTurns).toBe(0);
    expect(await Bun.file(join(fixture.brainPath, "brain.db")).exists()).toBe(false);
    expect((await readdir(fixture.brainPath)).filter(name => ![".brain-ui", "queue-credential.json"].includes(name))).toEqual([]);
  } finally { server.stop(true); }
  const unavailable = await runCli(origin);
  expect(unavailable.exit).toBe(2);
  expect(unavailable.body).toEqual({ queued: false, error: { code: "server_unavailable", message: "Queue server unavailable; retry with the same --key." } });
});

test("the real CLI refuses to follow a redirect carrying its principal cookie", async () => {
  let forwardedRequests = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    forwardedRequests++;
    return Response.json({ queued: true, created: true, threadId: "forged", itemId: "forged", stagingId: "forged" });
  } });
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, {
    status: 307, headers: { location: new URL("/api/queue", target.url).href },
  }) });
  const credentialFile = join(fixture.brainPath, "redirect-credential.json");
  const value = decodeURIComponent(cookie.split("=").slice(1).join("="));
  await writeFile(credentialFile, JSON.stringify({ server: redirect.url.origin, cookie: value }), { mode: 0o600 });
  try {
    const result = await runCli(redirect.url.origin, credentialFile, "odysseus-redirect");
    expect(result.exit).toBe(1);
    expect(result.body.error?.code).toBe("queue_failed");
    expect(forwardedRequests).toBe(0);
  } finally { redirect.stop(true); target.stop(true); }
});
