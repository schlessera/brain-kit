/** Real Git/TLS wire composition. The runner below deliberately does not claim native isolation. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { invocationChild } from "../../../scripts/test-invocation-child";
import { startEgressProxy } from "../../ui-sdk/src/server/egress-proxy";
import { reserveMaintenanceTemp } from "@schlessera/brain-ui-sdk/internal";
import { createGitHubReferenceAccess } from "../src/brain/github-reference-access";
import { createReferenceSources } from "../src/brain/reference-source";
import { referencePoolDouble } from "./helpers/reference-pool-double";
import { createReferenceTransport } from "../src/brain/reference-transport";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants";
import { fixtureTls } from "./fixtures/fixture-tls";

const ROOT = resolve(import.meta.dir, "../../.."), OFFLINE = "BRAIN_TEST_REFERENCE_GIT_PARENT_NET";
const NAME = "actual Git uses the fixed bounded HTTPS wire for public and private source without external routes";

/** Git HTTPS is outside the fetch preload. The whole command, including mutations, gets a fresh offline namespace. */
async function offlineChild(): Promise<boolean> {
  const parentNetwork = process.env[OFFLINE];
  if (parentNetwork) {
    const namespace = readlinkSync("/proc/self/ns/net");
    expect(namespace, "REFERENCE_GIT_HAS_FRESH_OFFLINE_NETWORK").not.toBe(parentNetwork);
    // An inherited sysfs mount can still describe the parent's interfaces.
    // Netlink queries describe this process's actual network namespace.
    const query = (...args: string[]): unknown => {
      const result = Bun.spawnSync(["ip", "-j", ...args], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, `REFERENCE_GIT_KERNEL_NETWORK_QUERY_COMPLETES: ${result.stderr.toString()}`).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    const links = query("link", "show") as { ifname: string }[];
    expect(links.map(link => link.ifname), "REFERENCE_GIT_HAS_ONLY_LOOPBACK").toEqual(["lo"]);
    const routes = ["-4", "-6"].map(family => query(family, "route", "show", "table", "main"));
    for (const route of routes) expect(route, "REFERENCE_GIT_HAS_NO_EXTERNAL_ROUTES").toEqual([]);
    const capabilities = readFileSync("/proc/self/status", "utf8").split("\n").filter(line => /^Cap(?:Inh|Prm|Eff|Bnd|Amb):/u.test(line));
    expect(capabilities, "REFERENCE_GIT_CHECKS_ALL_CAPABILITY_SETS").toHaveLength(5);
    expect(capabilities.every(line => /^Cap\w+:\s+0+$/u.test(line)), "REFERENCE_GIT_DROPS_ALL_SETUP_CAPABILITIES").toBe(true);
    console.log("REFERENCE_GIT_OFFLINE_NAMESPACE", JSON.stringify({ namespace, interfaces: links.map(link => link.ifname), routes,
      capabilities: capabilities.map(line => line.trim()) }));
    return false;
  }
  // Git needs loopback only. Unlike browser proof, this needs no dummy device
  // for navigator.onLine and never loads a kernel module. Empty IPv4/IPv6
  // routing and the child's capability/interface assertions remain mandatory.
  const setup = `test "$(readlink /proc/self/ns/net)" != "$${OFFLINE}"
ip link set dev lo up
test -z "$(ip -4 route show table main)"
test -z "$(ip -6 route show table main)"
exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"`;
  const child = invocationChild(["unshare", "--user", "--map-current-user", "--keep-caps", "--net", "sh", "-eu", "-c", setup,
    "reference-git-offline", process.execPath, join(ROOT, "scripts/test.ts"),
    "--timeout", "90000", import.meta.path, "-t", NAME], { cwd: ROOT, env: { ...process.env, [OFFLINE]: readlinkSync("/proc/self/ns/net") } });
  const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
  const deadline = setTimeout(() => { void child.stop("SIGTERM"); }, 85000);
  try {
    await child.ready;
    const [code, stdout, stderr] = await Promise.all([child.exited, out, err]);
    expect(code, `REFERENCE_GIT_OFFLINE_CHILD_COMPLETES\n${stdout}\n${stderr}`).toBe(0);
    expect(stderr, "REFERENCE_GIT_REAL_CHILD_EXECUTED").toMatch(/\b1 pass\b/u);
    const receipt = stdout.split("\n").find(line => line.startsWith("REFERENCE_GIT_OFFLINE_NAMESPACE "));
    expect(receipt, "REFERENCE_GIT_OFFLINE_NAMESPACE_RECORDED").toBeDefined(); console.log(receipt);
    return true;
  } finally { clearTimeout(deadline); await child.stop("SIGTERM"); await child.finish(); await Promise.allSettled([out, err]); }
}

test(NAME, async () => {
  if (await offlineChild()) return;
  const root = mkdtempSync(join(tmpdir(), "odysseus-github-git-")), work = join(root, "work"), bare = join(root, "ithaca.git");
  const gitEnv = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0); return result.stdout.toString().trim();
  };
  let server: ReturnType<typeof Bun.serve> | undefined;
  const db = createUiDb(":memory:");
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 8 * 1048576, observe() {} });
  try {
    mkdirSync(work); git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "README.md"), "Odysseus charts Ithaca on 2026-07-12.\n");
    writeFileSync(join(work, "chart.bin"), randomBytes(1048576));
    git(work, "add", "."); git(work, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", "commit", "-q", "-m", "Chart Ithaca");
    git(root, "clone", "-q", "--bare", work, bare); git(bare, "config", "http.uploadpack", "true");
    const commit = git(work, "rev-parse", "HEAD"), tls = fixtureTls(join(root, "tls"), ["github.com", "api.github.com"]);
    const token = "odysseus-fixture-token", basic = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    let privateSource = false;
    const requests: { host: string; path: string; authorization: string | null }[] = [];
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, async fetch(request) {
      const url = new URL(request.url), host = request.headers.get("host") ?? "", authorization = request.headers.get("authorization");
      requests.push({ host, path: url.pathname, authorization });
      if (host === "api.github.com" && url.pathname === "/repos/odysseus/ithaca") {
        if (privateSource && authorization !== `Bearer ${token}`) return new Response(null, { status: 404 });
        return Response.json({ id: 101, owner: { id: 201, login: "Odysseus" }, name: "Ithaca", full_name: "Odysseus/Ithaca",
          clone_url: "https://github.com/Odysseus/Ithaca.git", url: "https://api.github.com/repos/Odysseus/Ithaca", private: privateSource });
      }
      if (host !== "github.com" || !url.pathname.startsWith("/odysseus/ithaca.git/")) return new Response(null, { status: 404 });
      if (privateSource && authorization !== basic) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ithaca"' } });
      const body = new Uint8Array(await request.arrayBuffer());
      const child = Bun.spawn(["/usr/bin/git", "http-backend"], { stdin: body, stdout: "pipe", stderr: "pipe", env: { ...gitEnv,
        GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname.slice("/odysseus".length),
        QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length),
      } });
      const [bytes, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) return new Response(stderr, { status: 500 });
      const output = Buffer.from(bytes), separator = output.indexOf("\r\n\r\n"), headers = new Headers(); let status = 200;
      for (const line of output.subarray(0, separator).toString().split("\r\n")) {
        const colon = line.indexOf(":"), name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers.append(name, value);
      }
      return new Response(output.subarray(separator + 4), { status, headers });
    } });
    const launched: { network: boolean; proxy: boolean; credential: boolean }[] = [];
    // Execute exactly the transport's fixed argv/environment. This proves real
    // Git and TLS composition, separately from production maintenance/native isolation.
    const tempLimits = { allowanceBytes: 268435456, budgetBytes: 268435456 };
    mkdirSync(join(root, "maintenance"));
    const tempDomain = { statePath: join(root, "maintenance", "ui.db") };
    let onAdmissionRefused: (() => void) | undefined;
    const transport = createReferenceTransport({ brainPath: root, tempLimits, tempDomain, admissionWaitMs: 300, run: async input => {
      let reservation: ReturnType<typeof reserveMaintenanceTemp>;
      try { reservation = reserveMaintenanceTemp(input.tempLimits!, input.tempDomain, input.tempKind); }
      catch (error) { onAdmissionRefused?.(); throw error; }
      try {
        launched.push({ network: input.transport?.network !== false, proxy: !!input.env.HTTPS_PROXY, credential: !!input.env.BRAIN_REFERENCE_TOKEN });
        const child = Bun.spawn([...input.command], { cwd: root, env: { ...input.env, GIT_SSL_CAINFO: tls.ca },
          stdout: "pipe", stderr: "pipe", signal: input.signal });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { stdout, stderr, exitCode, killed: child.signalCode !== null };
      } finally { reservation.release(); }
    } });
    const principal = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
    const wireTransport = {
      ca: readFileSync(tls.ca, "utf8"), lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: (() => connect({ host: "127.0.0.1", port: server!.port! })) as typeof connect,
    };
    const access = createGitHubReferenceAccess({ db, brain: "ithaca", credentials: { GITHUB_TOKEN: token }, transport, wireTransport });
    for (const mode of ["public", "private", "capacity", "movement"] as const) {
      privateSource = mode === "private"; requests.length = 0; launched.length = 0;
      if (privateSource) createReferenceGrant(db, { brain: "ithaca", principalId: principal.id, createdBy: principal.id,
        repositoryPrefix: "https://github.com/odysseus/ithaca", credential: "GITHUB_TOKEN", metadataCredentialRecipient: "https://api.github.com", now: Date.now() });
      const acquisition = await access.open({ principalId: principal.id, repository: "odysseus/ithaca", revision: "main", egress, maxBytes: mode === "capacity" ? 131072 : 2 * 1048576 });
      try {
        expect(await acquisition.resolve(), "REFERENCE_ACTUAL_GIT_FIXED_DISCOVERY").toEqual({ ok: true, commit, ref: "refs/heads/main" });
        const checkout = join(root, mode); mkdirSync(checkout);
        if (mode === "movement") {
          writeFileSync(join(work, "README.md"), "Odysseus revises the Ithaca chart on 2026-07-12.\n");
          git(work, "add", "."); git(work, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", "commit", "-q", "-m", "Revise the chart");
          git(bare, "fetch", "--no-tags", work, "+refs/heads/main:refs/heads/main");
          await expect(acquisition.fetch(checkout), "REFERENCE_ACTUAL_GIT_MOVED_COMMIT_REFUSED").rejects.toMatchObject({ reason: "invalid" });
          expect(() => acquisition.assertCurrent()).toThrow();
          expect(launched.filter(value => !value.network)).toHaveLength(1); // rev-parse only; no checkout.
          continue;
        }
        if (mode === "capacity") {
          await expect(acquisition.fetch(checkout), "REFERENCE_ACTUAL_GIT_FETCH_WIRE_CAP").rejects.toMatchObject({ reason: "capacity" });
          expect(acquisition.bytes().chargedBytes).toBeLessThanOrEqual(131072);
          expect(launched.every(value => value.network), "REFERENCE_FAILED_FETCH_NEVER_INSPECTED_OFFLINE").toBe(true);
          continue;
        }
        expect(await acquisition.fetch(checkout), "REFERENCE_ACTUAL_GIT_FIXED_FETCH").toEqual({ commit });
        await transport.checkout({ root: checkout, commit }); await acquisition.revalidate();
        expect(readFileSync(join(checkout, "README.md"), "utf8"), "REFERENCE_ACTUAL_GIT_RETURNED_CHART").toBe("Odysseus charts Ithaca on 2026-07-12.\n");
        expect(acquisition.bytes().chargedBytes, "REFERENCE_ACTUAL_GIT_TLS_BYTES_ACCOUNTED").toBeGreaterThan(1048576);
        expect(launched.filter(value => value.network).every(value => value.proxy && value.credential === privateSource)).toBe(true);
        expect(launched.filter(value => !value.network).every(value => !value.proxy && !value.credential)).toBe(true);
        if (!privateSource) expect(requests.every(value => value.authorization === null), "REFERENCE_ACTUAL_GIT_PUBLIC_ALWAYS_ANONYMOUS").toBe(true);
        else {
          expect(requests.some(value => value.host === "github.com" && value.authorization === basic), "REFERENCE_ACTUAL_GIT_PRIVATE_CREDENTIAL").toBe(true);
          expect(requests.some(value => value.host === "api.github.com" && value.authorization === `Bearer ${token}`)).toBe(true);
        }
        const observed = requests.length;
        await expect(access.open({ principalId: principal.id, repository: "odysseus/ithaca", revision: "refs/pull/1/head", egress, maxBytes: 1048576 }),
          "REFERENCE_ACTUAL_GIT_REFUSES_PR_REF").rejects.toMatchObject({ reason: "invalid" });
        expect(requests).toHaveLength(observed);
      } finally { await acquisition.close(); }
    }
    // Exercise production source orchestration and offline tree inspection
    // with real Git. The directory pool still does not prove native sealing.
    privateSource = false; requests.length = 0; launched.length = 0;
    const sources = createReferenceSources({ db, brain: "ithaca", pool: referencePoolDouble(join(root, "source-pool")), transport,
      credentials: { GITHUB_TOKEN: token }, github: access });
    try {
      const lease = await sources.request({ principalId: principal.id, repository: "https://github.com/odysseus/ithaca", revision: "main",
        acquisition: { turnId: "odysseus-source-turn", egress, current: () => true } });
      try {
        expect(readFileSync(join(lease.viewPath, lease.name, "README.md"), "utf8"), "REFERENCE_ACTUAL_GIT_SOURCE_PUBLICATION")
          .toBe("Odysseus revises the Ithaca chart on 2026-07-12.\n");
        expect(db.query("SELECT commit_id, tree_id, turn_id FROM reference_acquisitions WHERE root_id = ?").get(lease.rootId),
          "REFERENCE_ACTUAL_GIT_SOURCE_TREE_BOUND").toEqual({ commit_id: git(work, "rev-parse", "HEAD"),
          tree_id: git(work, "rev-parse", "HEAD^{tree}"), turn_id: "odysseus-source-turn" });
        expect(launched.filter(value => !value.network)).toHaveLength(3); // fetched commit, checkout, tree.
        expect(launched.filter(value => !value.network).every(value => !value.proxy && !value.credential)).toBe(true);
        expect(requests.every(value => value.authorization === null)).toBe(true);
      } finally { lease.release(); }
    } finally { await sources.close(); }
    // Compose the real private Git/TLS path with an actual shared maintenance
    // ledger. Metadata may precede admission; no Git request or publication may
    // cross a lost turn, cancelled request or revoked grant during the wait.
    for (const mode of ["release", "busy", "cancel", "turn-ended", "grant-revoked"] as const) {
      privateSource = true; requests.length = 0; launched.length = 0;
      const waitingDb = createUiDb(":memory:");
      const reader = createPrincipal(waitingDb, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
      const grant = createReferenceGrant(waitingDb, { brain: "ithaca", principalId: reader.id, createdBy: reader.id,
        repositoryPrefix: "https://github.com/odysseus/ithaca", credential: "GITHUB_TOKEN", metadataCredentialRecipient: "https://api.github.com", now: Date.now() });
      const waitingSources = createReferenceSources({ db: waitingDb, brain: "ithaca", pool: referencePoolDouble(join(root, `waiting-${mode}`)), transport,
        credentials: { GITHUB_TOKEN: token }, github: createGitHubReferenceAccess({ db: waitingDb, brain: "ithaca", credentials: { GITHUB_TOKEN: token }, transport, wireTransport }) });
      const controller = new AbortController(); let current = true;
      const held = reserveMaintenanceTemp(tempLimits, tempDomain, "scratch_query");
      const refused = Promise.withResolvers<void>(); onAdmissionRefused = refused.resolve;
      const pending = waitingSources.request({ principalId: reader.id, repository: "https://github.com/odysseus/ithaca", revision: "main", signal: controller.signal,
        acquisition: { turnId: `odysseus-wait-${mode}`, egress, current: () => current } })
        .then(lease => ({ lease, error: undefined }), error => ({ lease: undefined, error }));
      try {
        await Promise.race([refused.promise, pending.then(() => { throw new Error("REFERENCE_MANAGED_REQUEST_MUST_REACH_MAINTENANCE_WAIT"); })]);
        expect(launched, "REFERENCE_MANAGED_WAIT_HAS_NOT_LAUNCHED_GIT").toEqual([]);
        expect(requests.some(request => request.host === "api.github.com" && request.authorization === `Bearer ${token}`),
          "REFERENCE_MANAGED_WAIT_HAS_VALIDATED_PRIVATE_METADATA").toBe(true);
        if (mode === "cancel") controller.abort();
        if (mode === "turn-ended") current = false;
        if (mode === "grant-revoked") expect(revokeReferenceGrant(waitingDb, { brain: "ithaca", principalId: reader.id, id: grant.id, now: Date.now() })).not.toBeNull();
        if (mode !== "busy" && mode !== "cancel") held.release();
        const result = await pending;
        if (mode === "release") {
          expect(result.error, "REFERENCE_MANAGED_WAIT_RELEASE_SUCCEEDS").toBeUndefined();
          expect(result.lease, "REFERENCE_MANAGED_WAIT_RELEASE_PUBLISHES").toBeDefined();
          try {
            expect(readFileSync(join(result.lease!.viewPath, result.lease!.name, "README.md"), "utf8"))
              .toBe("Odysseus revises the Ithaca chart on 2026-07-12.\n");
          } finally { result.lease?.release(); }
        } else {
          expect(result.lease, "REFERENCE_MANAGED_WAIT_REFUSAL_RETURNS_NO_SOURCE").toBeUndefined();
          expect(result.error, "REFERENCE_MANAGED_WAIT_REFUSAL_IS_EXPLICIT").toBeDefined();
          if (mode === "busy") expect(result.error, "REFERENCE_MANAGED_WAIT_PRESERVES_BUSY").toMatchObject({ code: "busy" });
          expect(requests.filter(request => request.host === "github.com"), "REFERENCE_MANAGED_WAIT_LOST_AUTHORITY_SENDS_NO_GIT").toEqual([]);
          expect(waitingDb.query("SELECT COUNT(*) AS count FROM reference_acquisitions").get(), "REFERENCE_MANAGED_WAIT_REFUSAL_NEVER_PUBLISHES").toEqual({ count: 0 });
          if (mode === "cancel") expect(launched, "REFERENCE_MANAGED_CANCELLED_WAIT_NEVER_LAUNCHES").toEqual([]);
        }
      } finally {
        onAdmissionRefused = undefined; held.release(); controller.abort();
        const result = await pending; result.lease?.release(); await waitingSources.close(); waitingDb.close();
      }
    }
  } finally { egress.stop(); server?.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); }
}, 90000);
