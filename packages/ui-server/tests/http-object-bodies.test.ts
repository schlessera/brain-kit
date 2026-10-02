import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createPrincipal } from "../src/db/principals";
import { resetLoginRateLimiter } from "../src/middleware/auth";
import { createRecordingObservability } from "../src/observability";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createTestApp, type TestApp } from "./helpers/test-app";

const PASSWORD = "odyssey-fixture-password";
const SECRET = "fixture-cookie-secret-0123456789abcdef";
const ORIGIN = "https://example.test";
const LABEL = "Odysseus's key";
let fixture: TestApp;
let ownerCookie: string;
let agentCookie: string;
let callsPath: string;
let contentPath: string;

function addCalls(): string[][] {
  return readFileSync(callsPath, "utf8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "add");
}

function label(): string | null {
  return (fixture.app.db.query("SELECT label FROM passkey_credentials WHERE id = ?")
    .get("fixture-key") as { label: string | null }).label;
}

function request(path: string, body: string, cookie = ownerCookie, method = "POST"): Promise<Response> {
  return fixture.fetch(path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body,
  });
}

beforeAll(async () => {
  resetLoginRateLimiter();
  fixture = await createTestApp({
    env: {
      AUTH_MODE: "password",
      BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(PASSWORD),
      COOKIE_SECRET: SECRET,
      ALLOWED_ORIGINS: ORIGIN,
      WEBAUTHN_ORIGINS: ORIGIN,
    },
    appOptions: {
      registry: createStaticBackendRegistry([makeFakeBackend({ id: "fixture" })]),
      observability: createRecordingObservability(),
    },
    prepare(root) {
      callsPath = join(root, "calls.jsonl");
      contentPath = join(root, "capture.txt");
      writeFileSync(callsPath, "");
      writeFileSync(contentPath, "Existing voyage note");
      mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
      const bin = join(root, "node_modules/.bin/brain");
      writeFileSync(bin, `#!${process.execPath}\nimport { appendFileSync, writeFileSync } from "node:fs";
        const args = process.argv.slice(2);
        appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
        if (args.includes("--version")) console.log("99.0.0");
        else if (args[0] === "add") {
          writeFileSync(${JSON.stringify(contentPath)}, args[args.indexOf("--") + 1]);
          console.log(JSON.stringify({ action: "created", path: "notes/voyage.md", title: "Voyage", type: "note", indexed: true }));
        } else console.log("{}");
      `);
      chmodSync(bin, 0o755);
    },
  });
  const login = await request("/api/auth/login", JSON.stringify({ password: PASSWORD }), "");
  expect(login.status).toBe(200);
  ownerCookie = login.headers.get("set-cookie")!.split(";")[0];
  expect(ownerCookie.length).toBeGreaterThan(0);
  const owner = fixture.app.db.query("SELECT id FROM principals WHERE kind = 'owner'")
    .get() as { id: string };
  expect(owner.id.length).toBeGreaterThan(0);
  const agent = createPrincipal(fixture.app.db, {
    authMethod: "delegated", label: "Fixture agent", createdBy: owner.id, ttlSeconds: 3_600,
  });
  agentCookie = await serializeSigned("brain_ui_session", agent.id, SECRET);
  fixture.app.db.prepare(`INSERT INTO passkey_credentials
    (id, public_key, counter, rp_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("fixture-key", new Uint8Array([1, 2, 3]), 0, "foreign.example", LABEL, Date.now());
  // A real dispatch/write is the positive control for every no-dispatch assertion.
  const capture = await request("/api/brain/add", JSON.stringify({ content: "Raft supplies" }));
  expect(capture.status).toBe(200);
  expect(await capture.json()).toMatchObject({ success: true, indexed: true });
  expect(addCalls()).toHaveLength(1);
  expect(addCalls()[0]).toEqual(["add", "--", "Raft supplies"]);
  expect(readFileSync(contentPath, "utf8")).toBe("Raft supplies");
});

afterAll(async () => { if (fixture) await fixture.teardown(); });

beforeEach(() => {
  resetLoginRateLimiter();
  writeFileSync(contentPath, "Raft supplies");
  fixture.app.db.prepare("UPDATE passkey_credentials SET label = ? WHERE id = ?")
    .run(LABEL, "fixture-key");
  expect(label()).toBe(LABEL);
});

const nonObjects = [
  ["null", "null"], ["array", "[]"], ["string", '"voyage"'],
  ["number", "42"], ["boolean", "true"],
] as const;

describe("mounted HTTP object-body validation", () => {
  for (const [name, body] of nonObjects) {
    test(`password login rejects ${name} with a JSON client error`, async () => {
      const res = await request("/api/auth/login", body, "");
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Invalid request body" });
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    test(`owner passkey registration rejects ${name} before storing a credential`, async () => {
      const before = fixture.app.db.query("SELECT id FROM passkey_credentials").all();
      expect(before).toHaveLength(1);
      const res = await request("/api/auth/passkey/register-verify", body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Invalid request body" });
      expect(fixture.app.db.query("SELECT id FROM passkey_credentials").all()).toEqual(before);
    });

    test(`owner passkey rename rejects ${name} without clearing its label`, async () => {
      const res = await request("/api/auth/passkey/fixture-key", body, ownerCookie, "PUT");
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Invalid request body" });
      expect(label()).toBe(LABEL);
    });

    test(`capture rejects ${name} before CLI dispatch or content writes`, async () => {
      const before = addCalls();
      expect(before.length).toBeGreaterThan(0);
      const content = readFileSync(contentPath, "utf8");
      expect(content.length).toBeGreaterThan(0);
      const res = await request("/api/brain/add", body);
      expect(addCalls()).toEqual(before);
      expect(readFileSync(contentPath, "utf8")).toBe(content);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Invalid request body" });
    });
  }

  const invalidCaptures: [string, string][] = [
    ["malformed JSON", '{"content":'],
    ["missing content", "{}"], ["empty content", '{"content":""}'],
    ...[null, 42, true, [], {}].map((content): [string, string] =>
      [`invalid content ${JSON.stringify(content)}`, JSON.stringify({ content })]),
    ...["type", "title"].flatMap((key) => [null, 42, false, [], {}].map((value): [string, string] =>
      [`invalid ${key} ${JSON.stringify(value)}`, JSON.stringify({ content: "Voyage", [key]: value })])),
    ...[null, "voyage", 42, {}, ["voyage", 1], [null], [{}]].map((tags): [string, string] =>
      [`invalid tags ${JSON.stringify(tags)}`, JSON.stringify({ content: "Voyage", tags })]),
  ];
  test.each(invalidCaptures)("capture refuses %s before CLI dispatch", async (_name, body) => {
    const before = addCalls();
    expect(before.length).toBeGreaterThan(0);
    const content = readFileSync(contentPath, "utf8");
    expect(content.length).toBeGreaterThan(0);
    const res = await request("/api/brain/add", body);
    expect(addCalls()).toEqual(before);
    expect(readFileSync(contentPath, "utf8")).toBe(content);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error).toBeString();
  });

  test("empty-object password login remains invalid credentials", async () => {
    const res = await request("/api/auth/login", "{}", "");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid credentials" });
  });

  test.each([null, 42, true, [], {}, ""])("object password %j retains invalid-credentials handling", async (password) => {
    const res = await request("/api/auth/login", JSON.stringify({ password }), "");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid credentials" });
  });

  test("valid rename objects retain normalization and omitted-label clearing", async () => {
    const rename = await request("/api/auth/passkey/fixture-key", '{"label":"  Ithaca  "}', ownerCookie, "PUT");
    expect(rename.status).toBe(200);
    expect(label()).toBe("Ithaca");
    const clear = await request("/api/auth/passkey/fixture-key", "{}", ownerCookie, "PUT");
    expect(clear.status).toBe(200);
    expect(label()).toBe("");
  });

  test("valid capture fields reach the actual CLI adapter unchanged", async () => {
    const before = addCalls().length;
    const res = await request("/api/brain/add", JSON.stringify({
      content: "Return to Ithaca", type: "note", title: "Voyage", tags: ["voyage", "ithaca"],
    }));
    expect(res.status).toBe(200);
    expect(addCalls()).toHaveLength(before + 1);
    expect(addCalls().at(-1)).toEqual(["add", "--type", "note", "--title", "Voyage", "--tags", "voyage,ithaca", "--", "Return to Ithaca"]);
    expect(readFileSync(contentPath, "utf8")).toBe("Return to Ithaca");
  });

  test("empty optional capture values retain CLI defaults", async () => {
    const before = addCalls().length;
    const res = await request("/api/brain/add", JSON.stringify({ content: "Voyage", type: "", title: "", tags: [] }));
    expect(res.status).toBe(200);
    expect(addCalls()).toHaveLength(before + 1);
    expect(addCalls().at(-1)).toEqual(["add", "--tags", "", "--", "Voyage"]);
  });

  for (const [name, cookie, status] of [
    ["unauthenticated", () => "", 401], ["delegated agent", () => agentCookie, 403],
  ] as const) {
    test(`${name} management requests are refused before body validation`, async () => {
      for (const [path, method] of [
        ["/api/auth/passkey/register-verify", "POST"], ["/api/auth/passkey/fixture-key", "PUT"],
      ]) {
        const res = await request(path!, "null", cookie(), method);
        expect(res.status).toBe(status);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect((await res.json()).error).toBeString();
        expect(label()).toBe(LABEL);
      }
    });
  }
});
