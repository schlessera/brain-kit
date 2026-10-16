import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
import { ClaudeHostAuthError, resolveClaudeHostOAuth } from "../src/host-oauth.js";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
const originalFetch = globalThis.fetch;
const secret = "odysseus-fictional-access";
const refresh = "odysseus-fictional-refresh";
const fresh = () => ({ accessToken: secret, refreshToken: refresh, expiresAt: Date.now() + 3_600_000,
  scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_5x", clientId: "odysseus-client" });
function fixture(auth: Record<string, unknown> = fresh()) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-host-oauth-")); roots.push(root);
  const path = join(root, ".credentials.json");
  writeFileSync(path, JSON.stringify({ unrelated: { retained: true }, claudeAiOauth: auth }), { mode: 0o600 });
  return { root, path };
}
function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler }); servers.push(server);
  // Lowest shared request method rewrites only the measured fixed authority.
  // The actual HTTP request and response stream still use the guarded loopback network.
  const replacement = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(input)).toBe("https://platform.claude.com/v1/oauth/token");
    return originalFetch(new URL("/v1/oauth/token", server.url), init);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { ...fetchDescriptor, value: replacement });
}
afterEach(async () => {
  Object.defineProperty(globalThis, "fetch", fetchDescriptor);
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a credential file growing after its actual fstat is refused within the fixed read bound", async () => {
  const { root, path } = fixture();
  const originalStat = fs.fstatSync;
  const originalRead = fs.readSync;
  let grew = false, maximumRead = 0;
  const stat = spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
    const result = Reflect.apply(originalStat, fs, [fd, ...args]);
    if (!grew && fs.readlinkSync(`/proc/self/fd/${fd}`) === path) {
      grew = true;
      fs.appendFileSync(path, Buffer.alloc(128 * 1024, " "));
    }
    return result;
  }) as typeof fs.fstatSync);
  const read = spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, ...args: unknown[]) => {
    maximumRead = Math.max(maximumRead, buffer.length);
    return Reflect.apply(originalRead, fs, [fd, buffer, ...args]);
  }) as typeof fs.readSync);
  try {
    await expect(resolveClaudeHostOAuth(root, {})).rejects.toMatchObject({ reason: "invalid" });
    expect(grew).toBe(true);
    expect(maximumRead).toBe(64 * 1024 + 1);
    expect(readdirSync(root)).toEqual([".credentials.json"]);
  } finally { read.mockRestore(); stat.mockRestore(); }
});

test("new and resumed requests reread the stored account and credentials without startup caching", async () => {
  const { root, path } = fixture();
  expect(await resolveClaudeHostOAuth(root, {})).toEqual({ authorization: `Bearer ${secret}`, source: "stored-login",
    subscriptionType: "max", rateLimitTier: "default_claude_max_5x" });
  const changed = { ...fresh(), accessToken: "odysseus-changed-login", subscriptionType: "pro" };
  writeFileSync(path, JSON.stringify({ claudeAiOauth: changed }));
  expect(await resolveClaudeHostOAuth(root, {})).toMatchObject({ authorization: "Bearer odysseus-changed-login", subscriptionType: "pro" });
  rmSync(path);
  await expect(resolveClaudeHostOAuth(root, {})).rejects.toMatchObject({ reason: "unavailable" });
});

test("explicit setup-token takes precedence without reading or writing the stored account", async () => {
  const { root, path } = fixture(); const before = readFileSync(path);
  expect(await resolveClaudeHostOAuth(root, { CLAUDE_CODE_OAUTH_TOKEN: "odysseus-explicit" })).toEqual({
    authorization: "Bearer odysseus-explicit", source: "environment" });
  expect(readFileSync(path)).toEqual(before);
  await expect(resolveClaudeHostOAuth(root, { CLAUDE_CODE_OAUTH_TOKEN: "odysseus\r\nsecret" })).rejects.toMatchObject({ reason: "invalid" });
});

test("expired login refreshes over real HTTP, preserves identity fields and atomically saves rotated credentials", async () => {
  const { root, path } = fixture({ ...fresh(), expiresAt: 1, refreshTokenExpiresAt: Date.now() + 100_000 });
  let calls = 0;
  upstream(async request => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ grant_type: "refresh_token", refresh_token: refresh, client_id: "odysseus-client",
      scope: "user:inference user:profile" });
    return Response.json({ access_token: "odysseus-rotated-access", refresh_token: "odysseus-rotated-refresh", expires_in: 3600,
      refresh_token_expires_in: 7200, scope: "user:inference user:profile" });
  });
  const result = await resolveClaudeHostOAuth(root, {});
  expect(result).toMatchObject({ authorization: "Bearer odysseus-rotated-access", source: "stored-login", subscriptionType: "max" });
  expect(JSON.stringify(result)).not.toContain(refresh);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  expect(stored.unrelated).toEqual({ retained: true });
  expect(stored.claudeAiOauth).toMatchObject({ accessToken: "odysseus-rotated-access", refreshToken: "odysseus-rotated-refresh",
    clientId: "odysseus-client", subscriptionType: "max", rateLimitTier: "default_claude_max_5x" });
  expect(stored.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  expect(stored.claudeAiOauth.refreshTokenExpiresAt).toBeGreaterThan(Date.now() + 7_100_000);
  expect(await resolveClaudeHostOAuth(root, {})).toEqual(result);
  expect(calls).toBe(1);
  expect(readdirSync(root)).toEqual([".credentials.json"]);
});

test("installed native protocol and saved-login readback qualify the bounded resolver without any external network", async () => {
  // Match the SDK's own resolution context, not an unrelated hoisted version.
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  const native = JSON.parse(readFileSync(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(sdkRequire.resolve("./manifest.json"), "utf8"));
  expect(native.version).toBe("0.3.293");
  expect(manifest.version).toBe("2.1.293");
  const binary = sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");
  const bytes = readFileSync(binary);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.platforms["linux-x64"].checksum);
  const source = bytes.toString("utf8");
  expect(source).toContain('TOKEN_URL:"https://platform.claude.com/v1/oauth/token"');
  expect(source).toContain('CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"');
  expect(source).toContain('grant_type:"refresh_token",refresh_token:e,client_id:s??cn().CLIENT_ID,scope:C.join(" ")');
  expect(source).toContain('function VP(e,n=Date.now()){if(e===null)return!1;return n+300000>=e}');
  const { root, path } = fixture({ ...fresh(), expiresAt: 1 });
  upstream(() => Response.json({ access_token: secret, refresh_token: refresh, expires_in: 3600, scope: "user:inference user:profile" }));
  await resolveClaudeHostOAuth(root, {});
  const before = readFileSync(path);
  // The native child is not covered by fetch instrumentation. A fresh private
  // network namespace and fictional HOME/config make this explicitly offline.
  const child = Bun.spawn(["unshare", "--user", "--map-root-user", "--net", binary, "auth", "status", "--json"], {
    env: { PATH: "/usr/bin:/bin", HOME: root, CLAUDE_CONFIG_DIR: root, LANG: "C.UTF-8",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(stderr).not.toContain(secret);
  const status = JSON.parse(stdout);
  expect(status.loggedIn).toBe(true);
  expect(status.authMethod).toBe("claude.ai");
  expect(status.subscriptionType).toBe("max");
  expect(stdout).not.toContain(secret);
  expect(stdout).not.toContain(refresh);
  expect(readFileSync(path)).toEqual(before);
  // Status proves that this installed native CLI consumes the record shape;
  // it does not validate a real account, refresh or paid inference.
});

test("concurrent server refresh refuses the busy owner, then rereads its committed result", async () => {
  const { root } = fixture({ ...fresh(), expiresAt: 1 });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  upstream(async () => { calls++; entered(); await held; return Response.json({ access_token: "odysseus-after-refresh", expires_in: 3600, scope: "user:inference" }); });
  const first = resolveClaudeHostOAuth(root, {});
  await started;
  await expect(resolveClaudeHostOAuth(root, {})).rejects.toMatchObject({ reason: "busy" });
  const source = new URL("../src/host-oauth.ts", import.meta.url).href;
  const script = `const {resolveClaudeHostOAuth}=await import(${JSON.stringify(source)});
    try { await resolveClaudeHostOAuth(${JSON.stringify(root)}, {}); process.exit(2); }
    catch(error) { console.log(JSON.stringify({reason:error.reason})); }`;
  const other = Bun.spawn(["unshare", "--user", "--map-root-user", "--net", process.execPath, "-e", script], {
    env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(other.stdout).text(), new Response(other.stderr).text(), other.exited]);
  expect(code).toBe(0);
  expect(errors).toBe("");
  expect(JSON.parse(output)).toEqual({ reason: "busy" });
  release();
  expect((await first).authorization).toBe("Bearer odysseus-after-refresh");
  expect((await resolveClaudeHostOAuth(root, {})).authorization).toBe("Bearer odysseus-after-refresh");
  expect(calls).toBe(1);
});

test("near-expiry refresh uses the native five-minute margin and per-request client override, never an alternate authority", async () => {
  const { clientId: _clientId, ...auth } = fresh();
  const { root, path } = fixture({ ...auth, expiresAt: Date.now() + 299_000 });
  let calls = 0;
  upstream(async request => {
    calls++;
    expect((await request.json()).client_id).toBe("odysseus-request-client");
    return Response.json({ access_token: secret, expires_in: 3600, scope: "user:inference" });
  });
  await resolveClaudeHostOAuth(root, { CLAUDE_CODE_OAUTH_CLIENT_ID: "odysseus-request-client" });
  expect(calls).toBe(1);
  expect(JSON.parse(readFileSync(path, "utf8")).claudeAiOauth.refreshToken).toBe(refresh);
  await expect(resolveClaudeHostOAuth(root, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://example.com" })).rejects.toMatchObject({ reason: "unavailable" });
  expect(calls).toBe(1);
});

test("native login changed during refresh is retained and never replaced with a stale account", async () => {
  const { root, path } = fixture({ ...fresh(), expiresAt: 1 });
  let replacement = "";
  upstream(() => {
    replacement = JSON.stringify({ claudeAiOauth: { ...fresh(), accessToken: "odysseus-other-account" } });
    writeFileSync(path, replacement);
    return Response.json({ access_token: "odysseus-stale-result", expires_in: 3600, scope: "user:inference" });
  });
  await expect(resolveClaudeHostOAuth(root, {})).rejects.toMatchObject({ reason: "changed" });
  expect(readFileSync(path, "utf8")).toBe(replacement);
  expect(readdirSync(root)).toEqual([".credentials.json"]);
});

test("exclusive staging collision never deletes another owner's file or changes the saved credential", async () => {
  const { root, path } = fixture({ ...fresh(), expiresAt: 1 }); const before = readFileSync(path);
  const id = "20260712-0000-4000-8000-000000000000";
  const collision = join(root, `.brain-oauth-${id}.tmp`);
  writeFileSync(collision, "Odysseus retained staging", { mode: 0o600 });
  upstream(() => Response.json({ access_token: secret, expires_in: 3600, scope: "user:inference" }));
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue(id);
  try {
    await expect(resolveClaudeHostOAuth(root, {})).rejects.toMatchObject({ reason: "refresh" });
    expect(existsSync(collision)).toBe(true);
    expect(readFileSync(collision, "utf8")).toBe("Odysseus retained staging");
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(join(root, ".brain-oauth-refresh.lock"))).toBe(false);
  } finally { uuid.mockRestore(); }
});

test("cancellation closes the in-flight refresh, leaves exact prior bytes and releases owned staging and lock", async () => {
  const { root, path } = fixture({ ...fresh(), expiresAt: 1 }); const before = readFileSync(path);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  upstream(async request => {
    entered();
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    return new Response();
  });
  const control = new AbortController();
  const pending = resolveClaudeHostOAuth(root, {}, control.signal);
  await started; control.abort(new Error(secret));
  await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(root)).toEqual([".credentials.json"]);
  await expect(resolveClaudeHostOAuth(root, {}, control.signal)).rejects.toMatchObject({ reason: "cancelled" });
});

for (const response of ["redirect", "denied", "oversized", "invalid", "missing-inference"] as const) {
  test(`refresh ${response} refuses safely without publishing credentials or leaking upstream secrets`, async () => {
    const { root, path } = fixture({ ...fresh(), expiresAt: 1 }); const before = readFileSync(path);
    upstream(() => response === "redirect" ? new Response(null, { status: 302, headers: { location: `https://example.com/${secret}` } })
      : response === "denied" ? new Response(secret, { status: 401 })
      : response === "oversized" ? new Response(secret.repeat(5000))
      : Response.json({ access_token: secret, expires_in: response === "invalid" ? -1 : 3600, scope: "user:profile" }));
    let failure: unknown;
    try { await resolveClaudeHostOAuth(root, {}); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ClaudeHostAuthError);
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(root);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(root)).toEqual([".credentials.json"]);
  });
}

for (const unsafe of ["symlink", "hardlink", "permissions", "invalid-scope", "expired-refresh"] as const) {
  test(`stored ${unsafe} never reaches the token authority`, async () => {
    const { root, path } = fixture({ ...fresh(), expiresAt: 1,
      ...(unsafe === "invalid-scope" ? { scopes: ["user:profile"] } : {}),
      ...(unsafe === "expired-refresh" ? { refreshTokenExpiresAt: 1 } : {}) });
    if (unsafe === "symlink") { const target = join(root, "odysseus-original"); writeFileSync(target, readFileSync(path), { mode: 0o600 }); rmSync(path); symlinkSync(target, path); }
    if (unsafe === "hardlink") linkSync(path, join(root, "odysseus-alias"));
    if (unsafe === "permissions") chmodSync(path, 0o644);
    let calls = 0; upstream(() => { calls++; return new Response(); });
    await expect(resolveClaudeHostOAuth(root, {})).rejects.toBeInstanceOf(ClaudeHostAuthError);
    expect(calls).toBe(0);
    expect(existsSync(join(root, ".brain-oauth-refresh.lock"))).toBe(false);
  });
}
