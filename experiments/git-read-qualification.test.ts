import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../packages/ui-server/src/db/client";
import { createPrincipal } from "../packages/ui-server/src/db/principals";
import { createReferenceGrant, referenceRepository, revokeReferenceGrant } from "../packages/ui-server/src/db/reference-grants";
import { createReferenceSources } from "../packages/ui-server/src/brain/reference-source";
import { createReferenceTransport, referenceRevision } from "../packages/ui-server/src/brain/reference-transport";
import { referencePoolDouble } from "../packages/ui-server/tests/helpers/reference-pool-double";
import { candidateRelay, checked, git, immutableBlob, localRunner, matches, origin, receipts, scratch } from "./git-read-qualification";
import type { MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";

const fixture = scratch(), TOKEN = "fixture-loom-acquisition-only", path = "/penelope/loom.git";
const publicWork = fixture.dir("navigation"), privateWork = fixture.dir("loom");
const publicBare = fixture.dir("navigation.git"), privateBare = fixture.dir("loom.git");
let upstream: ReturnType<typeof origin>, relay: ReturnType<typeof candidateRelay>, main: string, foreign: string;
let clone: string;
beforeAll(async () => {
  for (const [work, bare, text] of [[publicWork, publicBare, "Ithaca navigation"], [privateWork, privateBare, "Penelope loom"]]) {
    await checked(work!, "init", "-q", "-b", "main");
    writeFileSync(join(work!, "README.md"), `${text}\n`);
    writeFileSync(join(work!, ".gitattributes"), "README.md filter=sentinel\n");
    writeFileSync(join(work!, ".gitmodules"), '[submodule "foreign"]\n\tpath = foreign\n\turl = https://ithaca.invalid/foreign.git\n');
    symlinkSync("../outside", join(work!, "escape"));
    await checked(work!, "add", "."); await checked(work!, "commit", "-q", "-m", "Set sail");
    await checked(work!, "tag", "-a", "voyage", "-m", "Voyage tag");
    await checked(bare!, "init", "-q", "--bare");
    await checked(work!, "push", bare!, "main", "--tags");
    await checked(bare!, "symbolic-ref", "HEAD", "refs/heads/main");
    await checked(bare!, "config", "http.uploadpack", "true");
  }
  main = await checked(privateBare, "rev-parse", "main");
  await checked(privateWork, "checkout", "-q", "--orphan", "foreign");
  writeFileSync(join(privateWork, "foreign.md"), "Foreign proposal outside ordinary branches and tags\n");
  await checked(privateWork, "add", "."); await checked(privateWork, "commit", "-q", "-m", "Foreign proposal");
  foreign = await checked(privateWork, "rev-parse", "HEAD");
  await checked(privateWork, "push", privateBare, "HEAD:refs/pull/7/head");
  await checked(privateWork, "checkout", "-q", "main");
  // Nested repository entry is a gitlink, never a trusted regular source file.
  await checked(privateWork, "update-index", "--add", "--cacheinfo", `160000,${foreign},nested`);
  await checked(privateWork, "commit", "-q", "-m", "Record foreign gitlink");
  await checked(privateWork, "push", privateBare, "main");
  main = await checked(privateBare, "rev-parse", "main");
  upstream = origin([{ path: "/odysseus/navigation.git", directory: publicBare, token: null }, { path, directory: privateBare, token: TOKEN }]);
  relay = candidateRelay(upstream.server.url, path, TOKEN);
  clone = fixture.dir("ordinary-clone");
  console.log(`QUALIFICATION ${await checked(fixture.root, "--version")}; Bun ${Bun.version}; fixed date 2026-07-12`);
});
afterAll(() => {
  relay?.stop(true); upstream?.server.stop(true); fixture.close();
  console.log(`GIT_EXIT_RECEIPTS ${JSON.stringify(receipts)}`);
});
const rewrite = () => ["-c", "protocol.version=2", "-c", `url.${relay.url}.insteadOf=http://127.0.0.1:1/`];
const fake = () => `http://127.0.0.1:1${path}`; // Failing rewrites cannot reach an external host.

test("rewrite supports real clone/fetch/pull, but config changes bypass it and endpoint-only relay admits foreign refs", async () => {
  expect((await git(fixture.root, ...rewrite(), "clone", "--single-branch", "--branch", "main", fake(), clone)).code).toBe(0);
  expect(await checked(clone, "rev-parse", "HEAD")).toBe(main);
  expect((await git(clone, ...rewrite(), "fetch", "origin", "refs/tags/voyage")).code).toBe(0);
  await checked(clone, "config", "pull.rebase", "false");
  expect((await git(clone, ...rewrite(), "pull", "--ff-only")).code).toBe(0);
  writeFileSync(join(clone, ".git/hooks/post-merge"), "#!/bin/sh\nprintf hook > hook-fired\n");
  chmodSync(join(clone, ".git/hooks/post-merge"), 0o755);
  writeFileSync(join(privateWork, "README.md"), "Penelope loom refreshed\n");
  await checked(privateWork, "add", "README.md"); await checked(privateWork, "commit", "-q", "-m", "Refresh loom");
  await checked(privateWork, "push", privateBare, "main");
  main = await checked(privateBare, "rev-parse", "main");
  expect((await git(clone, ...rewrite(), "pull", "--ff-only")).code).toBe(0);
  expect(await checked(clone, "rev-parse", "HEAD")).toBe(main);
  expect(existsSync(join(clone, "hook-fired")), "PULL_EXECUTES_LOCAL_CONFIGURED_MUTATION").toBe(true);
  // Ref payload has no connection to a tool/window/name-based approval of `main`.
  expect((await git(clone, ...rewrite(), "fetch", "origin", "refs/pull/7/head:refs/proposal/7")).code, "CANDIDATE_FOREIGN_REF_REACHES_CREDENTIALED_UPLOAD_PACK").toBe(0);
  expect(await checked(clone, "rev-parse", "refs/proposal/7")).toBe(foreign);
  expect(await checked(clone, "cat-file", "blob", `${foreign}:foreign.md`)).toContain("Foreign proposal");
  expect(upstream.facts.some(x => x.protocol === "version=2" && x.body.includes("command=fetch"))).toBe(true);
  expect(upstream.facts.some(x => x.body.includes("ref-prefix refs/pull/7/head"))).toBe(true);
  expect((await git(clone, ...rewrite(), "push", "origin", "HEAD:refs/heads/forbidden")).code).not.toBe(0);
  expect((await git(privateBare, "show-ref", "--verify", "refs/heads/forbidden")).code).not.toBe(0);
  await checked(clone, "remote", "set-url", "origin", "http://127.0.0.1:1/odysseus/navigation.git");
  expect((await git(clone, ...rewrite(), "fetch", "origin")).code).not.toBe(0);
  // A longer insteadOf wins over the host-injected rewrite; demonstrate with an inert closed port.
  expect((await git(clone, ...rewrite(), "-c", `url.http://127.0.0.1:1/.insteadOf=${fake()}`, "ls-remote", fake())).code).not.toBe(0);
});

test("relay's path gate refuses writes, generic HTTP and other repos while unrelated traffic proceeds", async () => {
  const before = upstream.facts.length;
  const requests = ["/penelope/loom.git/HEAD", "/odysseus/navigation.git/info/refs?service=git-upload-pack", `${path}/info/refs?service=git-receive-pack`, `${path}/git-receive-pack`, `${path}/objects/${foreign}`];
  const results = await Promise.all(requests.map(p => fetch(new URL(p, relay.url))));
  expect(results.map(r => r.status)).toEqual(requests.map(() => 403));
  expect(upstream.facts.length).toBe(before);
  const [other, permitted] = await Promise.all([
    git(fixture.root, "ls-remote", `${upstream.server.url}odysseus/navigation.git`, "refs/heads/main"),
    git(fixture.root, ...rewrite(), "ls-remote", fake(), "refs/heads/main"),
  ]);
  expect(other.code).toBe(0); expect(permitted.code).toBe(0);
  expect(upstream.facts.filter(x => x.path.startsWith("/odysseus/")).every(x => x.authorized)).toBe(true);
});

test("fixed host acquisition isolates two principals, grants and credentials and evaluates content offline", async () => {
  const db = createUiDb(":memory:"), launches: MaintenanceCommand[] = [];
  const transport = createReferenceTransport({ brainPath: fixture.dir("brain"), run: localRunner(launches) });
  const sources = createReferenceSources({ db, pool: referencePoolDouble(fixture.dir("pool")), transport, brain: "ithaca",
    credentials: { GITHUB_TOKEN: TOKEN } });
  const odysseus = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const publicURL = `${upstream.server.url}odysseus/navigation.git`, privateURL = `${upstream.server.url}penelope/loom.git`;
  try {
    await expect(sources.request({ principalId: penelope.id, repository: privateURL, revision: "main" }), "AVAILABLE_CREDENTIAL_IS_NOT_AUTHORITY").rejects.toMatchObject({ code: "unauthorized" });
    const grant = createReferenceGrant(db, { brain: "ithaca", principalId: penelope.id, repositoryPrefix: privateURL, credential: "GITHUB_TOKEN", createdBy: penelope.id, now: Date.now() });
    const [navigation, loom] = await Promise.all([
      sources.request({ principalId: odysseus.id, repository: publicURL, revision: "main" }),
      sources.request({ principalId: penelope.id, repository: privateURL, revision: "main" }),
    ]);
    expect(navigation.domain).toBe("public"); expect(loom.domain).toBe("private"); expect(loom.commit).toBe(main);
    const root = join(loom.viewPath, loom.name), expected = await checked(privateBare, "show", "main:README.md");
    expect(await immutableBlob(join(root, ".git"), loom.commit, "README.md")).toBe(expected);
    await expect(immutableBlob(join(root, ".git"), loom.commit, "escape")).rejects.toThrow("not an immutable regular blob");
    await expect(immutableBlob(join(root, ".git"), loom.commit, "nested")).rejects.toThrow("not an immutable regular blob");
    await expect(immutableBlob(join(root, ".git"), loom.commit, "../outside")).rejects.toThrow("unsupported path");
    expect(existsSync(join(root, "foreign.md"))).toBe(false);
    expect((await git(root, "cat-file", "-e", `${foreign}^{commit}`)).code, "FIXED_REF_FETCH_OMITS_FOREIGN_COMMIT").not.toBe(0);
    // Worker edits and origin rewrites do not change the selected immutable Git object.
    writeFileSync(join(root, "README.md"), "Unverified worker edit\n");
    await checked(root, "config", "remote.origin.url", "https://ithaca.invalid/foreign.git");
    expect(await immutableBlob(join(root, ".git"), loom.commit, "README.md")).toBe(expected);
    await expect(sources.request({ principalId: odysseus.id, repository: privateURL, revision: "main" })).rejects.toMatchObject({ code: "unauthorized" });
    const credentialed = launches.filter(x => x.env?.BRAIN_REFERENCE_TOKEN === TOKEN);
    expect(credentialed.length).toBeGreaterThan(0);
    expect(credentialed.every(x => x.command.includes("ls-remote") || x.command.includes("fetch"))).toBe(true);
    const checkout = launches.filter(x => x.command.includes("checkout"));
    expect(checkout.length).toBeGreaterThan(0);
    expect(checkout.every(x => !x.credentials && !x.transport?.network && !x.env?.BRAIN_REFERENCE_TOKEN), "CHECKOUT_HAS_NO_CREDENTIAL_OR_NETWORK_AUTHORITY").toBe(true);
    expect(credentialed.every(x => x.command.includes(privateURL))).toBe(true);
    navigation.release(); loom.release();
    revokeReferenceGrant(db, { brain: "ithaca", principalId: penelope.id, id: grant.id, now: Date.now() });
    await sources.revoke({ grantIds: [grant.id], principalIds: [] });
    await expect(sources.request({ principalId: penelope.id, repository: privateURL, revision: "main" }), "REVOKED_GRANT_REFUSES_CACHED_SOURCE").rejects.toMatchObject({ code: "unauthorized" });
  } finally { await sources.close(); db.close(); }
});

test("production branch/tag resolver refuses direct PR and object selection; redirects remain disabled", async () => {
  const launches: MaintenanceCommand[] = [], transport = createReferenceTransport({ brainPath: fixture.root, run: localRunner(launches) });
  const repository = referenceRepository(`${upstream.server.url}odysseus/navigation.git`);
  expect(await transport.resolve({ repository, revision: referenceRevision("main"), token: null })).toMatchObject({ ok: true, ref: "refs/heads/main" });
  expect(await transport.resolve({ repository, revision: referenceRevision("voyage"), token: null })).toMatchObject({ ok: true, ref: "refs/tags/voyage" });
  expect(() => referenceRevision(foreign)).toThrow();
  expect(await transport.resolve({ repository: referenceRepository(`${upstream.server.url}penelope/loom.git`), revision: referenceRevision("refs/pull/7/head"), token: TOKEN })).toMatchObject({ ok: false, reason: "missing" });
  for (const input of ["git@ithaca.invalid:odysseus/navigation", "ssh://ithaca.invalid/odysseus/navigation", "ext::sentinel", "https://ithaca.invalid/a%2fb", "https://ithaca.invalid/a/../b"]) expect(() => referenceRepository(input)).toThrow();
  const before = upstream.facts.length;
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(`${upstream.server.url}penelope/loom.git/info/refs?service=git-upload-pack`, 302); } });
  try {
    expect(await transport.resolve({ repository: referenceRepository(`${redirect.url}odysseus/navigation.git`), revision: "main", token: TOKEN })).toMatchObject({ ok: false });
    expect(upstream.facts.length, "REDIRECT_NEVER_RECEIVES_CREDENTIAL_OR_REQUEST").toBe(before);
  } finally { redirect.stop(true); }
});

test("a real stalled Git request is cancelled and does not produce a source", async () => {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { started(); return new Promise<Response>(() => {}); } });
  const launches: MaintenanceCommand[] = [], controller = new AbortController();
  const transport = createReferenceTransport({ brainPath: fixture.root, run: localRunner(launches), timeoutMs: 2000 });
  try {
    const pending = transport.resolve({ repository: referenceRepository(`${stalled.url}penelope/loom.git`), revision: "main", token: TOKEN, signal: controller.signal });
    await entered; const abortedAt = performance.now(); controller.abort();
    expect(await pending, "CANCELLED_GIT_NEVER_REPORTS_A_COMMIT").toMatchObject({ ok: false, reason: "unavailable" });
    expect(performance.now() - abortedAt, "CANCELLATION_STOPS_GIT_HELPER_TREE_PROMPTLY").toBeLessThan(1500);
    expect(launches.length).toBe(1);
  } finally { stalled.stop(true); }
});

test("exact identity follows rename within approved owner, never transfer/name reuse; owner scope includes future repos", () => {
  const repo = { kind: "repo", id: "repository-ithaca-1", owner: "odysseus" } as const;
  expect(matches(repo, { id: repo.id, owner: "ODYSSEUS", name: "renamed" })).toBe(true);
  expect(matches(repo, { id: repo.id, owner: "penelope", name: "navigation" })).toBe(false);
  expect(matches(repo, { id: "replacement", owner: "odysseus", name: "navigation" })).toBe(false);
  expect(matches(repo, null)).toBe(false);
  expect(matches({ kind: "owner", owner: "odysseus" }, { id: "future", owner: "odysseus", name: "new-voyage" })).toBe(true);
  expect(matches({ kind: "owner", owner: "odysseus" }, { id: "future", owner: "odysseus-crew", name: "new-voyage" })).toBe(false);
});
