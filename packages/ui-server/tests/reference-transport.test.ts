import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeWorkerHost } from "@schlessera/brain-ui-sdk/internal";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createReferenceGrant, referenceRepository } from "../src/db/reference-grants";
import { createReferenceSources } from "../src/brain/reference-source";
import { createReferenceTransport, REFERENCE_GIT_CONFIG } from "../src/brain/reference-transport";
import { referencePoolDouble } from "./helpers/reference-pool-double";

const ROOT = resolve(import.meta.dir, "../../..");
const TOKEN = "fixture-reference-token-never-for-source-evaluation";
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const FILES = 1_200;
let fixture: string, brain: string, server: ReturnType<typeof Bun.serve>;
const received: { path: string; authorized: boolean }[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", "-C", cwd, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args],
    { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

/** One bare Odysseus repository with more than a thousand files on `main`. */
function repository(name: string, title: string): string {
  const work = join(fixture, `${name}-work`), bare = join(fixture, "srv", `${name}.git`);
  mkdirSync(work, { recursive: true }); mkdirSync(join(fixture, "srv"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  for (let book = 0; book < 24; book++) {
    mkdirSync(join(work, "odyssey", `book-${book}`), { recursive: true });
    for (let line = 0; line < FILES / 24; line++) writeFileSync(join(work, "odyssey", `book-${book}`, `line-${line}.md`), `${title}: book ${book}, line ${line}.\n`);
  }
  // Repository-controlled attributes name a filter the fixed host configuration never defines.
  writeFileSync(join(work, ".gitattributes"), "README.md filter=sentinel\n");
  writeFileSync(join(work, "README.md"), `${title}\n`);
  git(work, "add", "."); git(work, "commit", "-q", "-m", `${title} sets sail`);
  git(fixture, "clone", "-q", "--bare", work, bare);
  git(bare, "config", "http.uploadpack", "true");
  return work;
}

beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const probe = mkdtempSync(join(ROOT, "tmp/reference-transport-probe-"));
  try { expect(probeWorkerHost(probe), "this credential-isolation proof requires the actual worker boundary").toEqual({ ok: true }); }
  finally { rmSync(probe, { recursive: true, force: true }); }
  fixture = mkdtempSync("/var/tmp/brain-reference-fixture-");
  brain = join(fixture, "brain"); mkdirSync(brain);
  repository("ithaca", "Ithaca public chart");
  repository("loom", "Penelope's private loom");
  // Loopback smart HTTP: `/public/*` is anonymous, `/private/*` needs the fixture token.
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), authorized = request.headers.get("authorization") === BASIC;
    received.push({ path: url.pathname, authorized });
    const [, scope, ...rest] = url.pathname.split("/");
    if (scope === "private" && !authorized) return new Response("credentials required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ithaca"' } });
    if (scope !== "public" && scope !== "private") return new Response("not found", { status: 404 });
    const body = new Uint8Array(await request.arrayBuffer());
    const child = Bun.spawn(["/usr/bin/git", "http-backend"], { stdin: body, stdout: "pipe", stderr: "pipe", env: {
      PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_PROJECT_ROOT: join(fixture, "srv"), GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method, PATH_INFO: `/${rest.join("/")}`, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length),
    } });
    const [output, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) return new Response(stderr, { status: 500 });
    const bytes = new Uint8Array(output), separator = Buffer.from(bytes).indexOf("\r\n\r\n");
    const headers = new Headers(); let status = 200;
    for (const line of new TextDecoder().decode(bytes.slice(0, separator)).split("\r\n")) {
      const colon = line.indexOf(":"), name = line.slice(0, colon), value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers.append(name, value);
    }
    return new Response(bytes.slice(separator + 4), { status, headers });
  } });
});
afterAll(() => { server?.stop(true); if (fixture) rmSync(fixture, { recursive: true, force: true }); });

const url = (scope: "public" | "private", name: string) => `${server.url}${scope}/${name}.git`;
const files = (directory: string): number => readdirSync(directory, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.name === ".git" ? 0 : entry.isDirectory() ? files(join(directory, entry.name)) : 1), 0);

test("the transport resolves public revisions anonymously and private ones only with the granted credential", async () => {
  const transport = createReferenceTransport({ brainPath: brain });
  const ithaca = referenceRepository(url("public", "ithaca")), loom = referenceRepository(url("private", "loom"));
  const head = git(join(fixture, "srv", "ithaca.git"), "rev-parse", "main");
  expect(await transport.resolve({ repository: ithaca, revision: "main", token: null }), "REFERENCE_TRANSPORT_PUBLIC_ANONYMOUS").toEqual({ ok: true, commit: head, ref: "refs/heads/main" });
  expect(await transport.resolve({ repository: ithaca, revision: "no-such-branch", token: null })).toMatchObject({ ok: false, reason: "missing" });
  expect(await transport.resolve({ repository: loom, revision: "main", token: null }), "REFERENCE_TRANSPORT_PRIVATE_ANONYMOUS_DENIED").toMatchObject({ ok: false, reason: "denied" });
  expect(await transport.resolve({ repository: loom, revision: "main", token: "wrong-token" })).toMatchObject({ ok: false, reason: "denied" });
  expect(await transport.resolve({ repository: loom, revision: "main", token: TOKEN }), "REFERENCE_TRANSPORT_PRIVATE_WITH_GRANT")
    .toMatchObject({ ok: true, commit: git(join(fixture, "srv", "loom.git"), "rev-parse", "main") });
}, 60_000);

test("acquisition publishes a complete thousand-file checkout and keeps the credential out of source evaluation", async () => {
  const db = createUiDb(":memory:");
  const pool = referencePoolDouble(join(fixture, "pool"));
  const original = Bun.spawn;
  const launches: string[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const env = (args[1] as { env?: Record<string, string> } | undefined)?.env;
    if (env?.BRAIN_WORKER_LAUNCH) launches.push(JSON.stringify(args));
    return original(...args);
  }) as typeof Bun.spawn);
  try {
    const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 86_400 });
    const sources = createReferenceSources({ db, pool, transport: createReferenceTransport({ brainPath: brain }), brain: "ithaca", credentials: { BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN } });
    const shared = await sources.request({ principalId: penelope.id, repository: url("public", "ithaca"), revision: "main" });
    const tree = join(shared.viewPath, shared.name);
    expect(shared.domain).toBe("public");
    expect(files(tree), "REFERENCE_SOURCE_THOUSAND_FILE_CHECKOUT").toBe(FILES + 2);
    expect(readFileSync(join(tree, "odyssey/book-23/line-49.md"), "utf8")).toBe("Ithaca public chart: book 23, line 49.\n");
    expect(readFileSync(join(tree, ".git/config"), "utf8"), "REFERENCE_SOURCE_HOST_GIT_CONFIG").toBe(REFERENCE_GIT_CONFIG);
    expect(readFileSync(join(tree, "README.md"), "utf8"), "REFERENCE_SOURCE_UNDEFINED_FILTER_INERT").toBe("Ithaca public chart\n");
    expect(shared.commit).toBe(git(join(fixture, "srv", "ithaca.git"), "rev-parse", "main"));

    await expect(sources.request({ principalId: penelope.id, repository: url("private", "loom"), revision: "main" }), "REFERENCE_SOURCE_PRIVATE_NEEDS_GRANT")
      .rejects.toMatchObject({ code: "unauthorized" });
    createReferenceGrant(db, { brain: "ithaca", principalId: penelope.id, repositoryPrefix: `${server.url}private`.replace(/\/$/, ""), credential: "BRAIN_UI_SYNC_GITHUB_TOKEN", createdBy: penelope.id, now: Date.now() });
    launches.length = 0;
    const loom = await sources.request({ principalId: penelope.id, repository: url("private", "loom"), revision: "main" });
    expect(loom.domain).toBe("private");
    expect(files(join(loom.viewPath, loom.name))).toBe(FILES + 2);
    expect(received.some(item => item.path.startsWith("/private/") && item.authorized), "REFERENCE_SOURCE_GRANTED_CREDENTIAL_SENT").toBe(true);
    // Only the network transport (ls-remote/fetch) carries the credential; every
    // offline step that reads repository content runs without it and without network.
    const credentialed = launches.filter(launch => launch.includes(TOKEN)), offline = launches.filter(launch => !launch.includes(TOKEN));
    expect(credentialed.length).toBeGreaterThan(0);
    expect(credentialed.every(launch => /ls-remote|\bfetch\b/.test(launch)) && credentialed.every(launch => !launch.includes('\\"checkout\\"')), "REFERENCE_SOURCE_CREDENTIAL_ONLY_IN_TRANSPORT").toBe(true);
    const checkout = offline.filter(launch => launch.includes('\\"checkout\\"'));
    expect(checkout.length, "REFERENCE_SOURCE_CHECKOUT_UNCREDENTIALED").toBeGreaterThan(0);
    expect(checkout.every(launch => launch.includes("--unshare-net")), "REFERENCE_SOURCE_CHECKOUT_OFFLINE").toBe(true);
    const sources_ = launches.flatMap(launch => {
      const argv = (JSON.parse(JSON.parse(launch)[1].env.BRAIN_WORKER_LAUNCH) as { argv: string[] }).argv;
      return argv.flatMap((value, index) => value === "--bind" || value === "--ro-bind" ? [argv[index + 1]!] : []);
    });
    expect(sources_.length).toBeGreaterThan(0);
    expect(sources_.filter(path => path === brain || path.startsWith(brain + "/") || brain.startsWith(path.endsWith("/") ? path : path + "/")), "REFERENCE_SOURCE_NEVER_MOUNTS_BRAIN").toEqual([]);
    await sources.close();
  } finally { spy.mockRestore(); db.close(); }
}, 180_000);
