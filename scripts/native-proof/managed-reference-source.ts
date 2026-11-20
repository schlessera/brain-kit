/** Actual managed Git/TLS acquisition, maintenance workers and native Btrfs publication. No read-trust exemption. */
import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { startEgressProxy } from "../../packages/ui-sdk/src/server/egress-proxy.js";
import { runMaintenanceWorker } from "../../packages/ui-sdk/src/server/maintenance-worker.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { createPrincipal } from "../../packages/ui-server/src/db/principals.js";
import { createReferenceGrant, revokeReferenceGrant } from "../../packages/ui-server/src/db/reference-grants.js";
import { createReferenceSources } from "../../packages/ui-server/src/brain/reference-source.js";
import { createReferenceTransport } from "../../packages/ui-server/src/brain/reference-transport.js";
import { createReferenceReads } from "../../packages/ui-server/src/brain/reference-read.js";
import { createReferenceTools } from "../../packages/ui-server/src/brain/reference-tools.js";
import { createGitHubReferenceAccess } from "../../packages/ui-server/src/brain/github-reference-access.js";
import { fixtureTls } from "../../packages/ui-server/tests/fixtures/fixture-tls.js";

export async function proveManagedReferenceSource(client: ReturnType<typeof createNativeBrainManagerClient>, brain: string,
  note: (kind: string, facts: Record<string, unknown>) => void): Promise<void> {
  const root = "/native-runtime/managed-source", repository = "https://github.com/odysseus/ithaca", servedBrain = "ithaca-managed-proof";
  mkdirSync(root, { recursive: true });
  const work = join(root, "work"), bare = join(root, "ithaca.git"); mkdirSync(work);
  const gitEnv = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["/usr/bin/git", ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, `MANAGED_NATIVE_FIXTURE_GIT: ${result.stderr}`).toBe(0); return result.stdout.toString().trim();
  };
  git("-C", work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "Odysseus charts Ithaca on 2026-07-12.\n");
  git("-C", work, "add", ".");
  git("-C", work, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", "commit", "-q", "-m", "Chart Ithaca");
  git("clone", "-q", "--bare", work, bare);
  const commit = git("-C", work, "rev-parse", "HEAD"), tree = git("-C", work, "rev-parse", "HEAD^{tree}");
  const tls = fixtureTls(join(root, "tls"), ["github.com", "api.github.com"]);
  // Only this disposable network-none proof container's system bundle changes.
  // Real maintenance workers use their ordinary mounted system trust store.
  const bundle = "/etc/ssl/certs/ca-certificates.crt", originalBundle = readFileSync(bundle);
  writeFileSync(bundle, Buffer.concat([originalBundle, Buffer.from("\n"), readFileSync(tls.ca)]));
  const token = "odysseus-native-fixture-token", basic = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  let privateSource = false, revokeAtSeal = false;
  const requests: { host: string; authorization: string | null }[] = [];
  const db = createUiDb(join(root, "ui.db"));
  const principal = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  let grantId: string | null = null;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, async fetch(request) {
    const url = new URL(request.url), host = request.headers.get("host") ?? "", authorization = request.headers.get("authorization");
    requests.push({ host, authorization });
    if (host === "api.github.com" && url.pathname === "/repos/odysseus/ithaca") {
      if (privateSource && authorization !== `Bearer ${token}`) return new Response(null, { status: 404 });
      return Response.json({ id: 101, owner: { id: 201, login: "Odysseus" }, name: "Ithaca", full_name: "Odysseus/Ithaca",
        clone_url: `${repository}.git`, url: "https://api.github.com/repos/odysseus/ithaca", private: privateSource });
    }
    if (host !== "github.com" || !url.pathname.startsWith("/odysseus/ithaca.git/")) return new Response(null, { status: 404 });
    if (privateSource && authorization !== basic) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ithaca"' } });
    const child = Bun.spawn(["/usr/bin/git", "http-backend"], { stdin: new Uint8Array(await request.arrayBuffer()), stdout: "pipe", stderr: "pipe",
      env: { ...gitEnv, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname.replace(/^\/odysseus/u, ""),
        REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: request.headers.get("content-length") ?? "", HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "" } });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).arrayBuffer().then(value => Buffer.from(value)), new Response(child.stderr).text(), child.exited]);
    expect(code, `MANAGED_NATIVE_HTTP_BACKEND: ${errors}`).toBe(0);
    const separator = output.indexOf("\r\n\r\n"); expect(separator).toBeGreaterThan(0);
    const headers = new Headers(); let status = 200;
    for (const line of output.subarray(0, separator).toString().split("\r\n")) {
      const colon = line.indexOf(":"); if (colon < 1) continue;
      if (line.slice(0, colon).toLowerCase() === "status") status = Number(line.slice(colon + 1).trim().split(" ")[0]);
      else headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return new Response(output.subarray(separator + 4), { status, headers });
  } });
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 8 * 1048576, observe() {} });
  const transport = createReferenceTransport({ brainPath: brain, tempDomain: { statePath: join(root, "ui.db") } });
  const github = createGitHubReferenceAccess({ db, brain: servedBrain, credentials: { GITHUB_TOKEN: token }, transport,
    wireTransport: { ca: readFileSync(tls.ca, "utf8"), lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: (() => connect({ host: "127.0.0.1", port: server.port! })) as typeof connect } });
  const created: string[] = [];
  const sources = createReferenceSources({ db, brain: servedBrain, credentials: { GITHUB_TOKEN: token }, transport, github,
    pool: { ...client,
      async poolCreate(...args) { created.push(args[0]); return client.poolCreate(...args); },
      async poolSeal(...args) {
        const record = await client.poolSeal(...args);
        if (revokeAtSeal) revokeReferenceGrant(db, { brain: servedBrain, principalId: principal.id, id: grantId!, now: Date.now() });
        return record;
      } } });
  const request = () => sources.request({ principalId: principal.id, repository, revision: "main",
    acquisition: { turnId: "odysseus-native-managed", egress, current: () => true } });
  const releaseOwned = async () => {
    await sources.close();
    const cleanup = await Promise.allSettled(created.map(id => client.poolRelease(id)));
    const failure = cleanup.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    const lease = await request();
    try {
      const record = await client.poolSeal(lease.rootId);
      expect(record.state, "MANAGED_NATIVE_SOURCE_IS_SEALED").toBe("sealed");
      let refusal = "";
      try { writeFileSync(join(record.path!, "intrusion.md"), "Circe alters the chart.\n"); } catch (error) { refusal = (error as NodeJS.ErrnoException).code ?? "unknown"; }
      expect(refusal, "MANAGED_NATIVE_KERNEL_REFUSES_MUTATION").toBe("EROFS");
      const read = await runMaintenanceWorker({ brainPath: brain, credentials: false, env: { PATH: "/usr/bin:/bin" }, tempKind: "git",
        tempDomain: { statePath: join(root, "ui.db") }, command: ["/usr/bin/cat", join(record.path!, "README.md")],
        transport: { mirror: record.path!, readPaths: [], network: false } });
      expect(read.exitCode, `MANAGED_NATIVE_OFFLINE_WORKER_READ: ${read.stderr}`).toBe(0);
      expect(read.stdout).toBe("Odysseus charts Ithaca on 2026-07-12.\n");
      const mapping = db.query("SELECT * FROM reference_acquisitions WHERE root_id = ?").get(lease.rootId);
      expect(mapping, "MANAGED_NATIVE_ACQUISITION_BINDS_KERNEL_ROOT").toMatchObject({ commit_id: commit, tree_id: tree,
        native_root_id: record.root!.rootId, native_uuid: record.root!.uuid, native_generation: record.root!.otransid });
      lease.assertAuthority();
      const blob = await transport.readBlob!({ root: record.path!, commit, tree, path: "README.md", offset: 9, maximum: 13 });
      lease.assertAuthority();
      expect(Buffer.from(blob.bytes).toString(), "MANAGED_NATIVE_IMMUTABLE_OBJECT_RANGE").toBe("charts Ithaca");
      const reads = createReferenceReads({ db, brain: servedBrain, sources, pool: client, transport });
      const tools = createReferenceTools({ sources, reads }), turnId = "odysseus-native-read";
      await tools.begin(turnId, { principalId: principal.id, posture: "interactive", generation: null });
      tools.attachEgress(turnId, principal.id, { egress, current: () => true });
      try {
        const result = await tools.call(turnId, principal.id, { tool: "reference_read", toolCallId: "native_ithaca_read",
          input: { repository, revision: "main", path: "README.md", offset: 9, maximum: 13 } });
        expect(result, "MANAGED_NATIVE_HOST_TOOL_READS_EXACT_IMMUTABLE_BYTES").toMatchObject({ ok: true, read: { content: "charts Ithaca", commit, offset: 9, length: 13 } });
        const prepared = db.query("SELECT acquisition, evidence, delivery FROM reference_reads WHERE turn_id = ?").get(turnId) as { acquisition: string; evidence: string; delivery: string };
        expect(prepared.delivery, "MANAGED_NATIVE_PREPARED_IS_NOT_BACKEND_DELIVERY").toBe("prepared");
        const evidence = JSON.parse(prepared.evidence);
        expect(evidence.identityObservation, "MANAGED_NATIVE_READ_HAS_OWN_TRANSPORT_IDENTITY").toMatchObject({
          brain: servedBrain, principalId: principal.id, turnId, rootId: lease.rootId, ref: "refs/heads/main", commit,
          identity: { repositoryId: "101", ownerId: "201" },
        });
        expect(evidence.identityObservation.operationId).not.toBe(lease.identityObservation!.operationId);
        expect(evidence).toMatchObject({ blob: blob.blob, digest: blob.digest, offset: 9, length: 13, trusted: false });
        expect(JSON.parse(prepared.acquisition)).toMatchObject({ commit_id: commit, tree_id: tree, native_generation: record.root!.otransid });
        note("managed-source-native-host-read", { commit, tree, blob: evidence.blob, digest: evidence.digest, offset: 9, length: 13,
          actualMaintenanceWorker: true, hostToolEntry: true, identityObservation: evidence.identityObservation, delivery: prepared.delivery, backendEquivalence: false, readTrustExemption: false });
      } finally { tools.end(turnId); }
      expect(blob).toMatchObject({ tree, mode: "100644", offset: 9, length: 13, totalBytes: 38 });
      note("managed-source-native-blob", { commit, tree, root: record.root, path: "README.md", blob: blob.blob, mode: blob.mode, offset: blob.offset,
        length: blob.length, totalBytes: blob.totalBytes, digest: blob.digest, actualMaintenanceWorker: true,
        backendEquivalence: false, readTrustExemption: false });
      expect(requests.every(value => value.authorization === null), "MANAGED_NATIVE_PUBLIC_ANONYMOUS").toBe(true);
      expect(egress.usedBytes(), "MANAGED_NATIVE_ACTUAL_TURN_NETWORK_CHARGED").toBeGreaterThan(0);
      note("managed-source-native", { commit, tree, root: record.root, mapping, usedBytes: egress.usedBytes(), kernelWriteRefusal: refusal,
        actualMaintenanceWorker: true, backendEquivalence: false, readTrustExemption: false });
    } finally { lease.release(); }
    privateSource = true; revokeAtSeal = true;
    grantId = createReferenceGrant(db, { brain: servedBrain, principalId: principal.id, createdBy: principal.id, repositoryPrefix: repository,
      credential: "GITHUB_TOKEN", metadataCredentialRecipient: "https://api.github.com", now: Date.now() }).id;
    await expect(request(), "MANAGED_NATIVE_GRANT_REVOKED_AFTER_SEAL").rejects.toMatchObject({ code: "unauthorized" });
    expect(db.query("SELECT * FROM reference_sources WHERE domain != 'public' AND root_id IS NOT NULL").all(), "MANAGED_NATIVE_REVOKED_SOURCE_NOT_PUBLISHED").toEqual([]);
    note("managed-source-native-revocation", { refused: true, livePublicMappingUnaffected: db.query("SELECT count(*) AS n FROM reference_acquisitions").get() });
  } finally {
    try { await releaseOwned(); }
    finally { egress.stop(); server.stop(true); db.close(); writeFileSync(bundle, originalBundle); }
  }
}
