import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEgressProxy } from "../../ui-sdk/src/server/egress-proxy";
import type { MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import { createGitHubReferenceWire } from "../src/brain/github-reference-wire";
import { createReferenceTransport } from "../src/brain/reference-transport";
import { referenceRepository } from "../src/db/reference-grants";

const repository = referenceRepository("https://github.com/odysseus/ithaca"), commit = "a".repeat(40);
async function fixture() {
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], maxBytes: 1048576, outwardHosts: [], observe() {} });
  const wire = await createGitHubReferenceWire({ repository: repository.canonical, egress, maxBytes: 65536, authorize() {} });
  const calls: (MaintenanceCommand & { signal?: AbortSignal })[] = [];
  const transport = createReferenceTransport({ brainPath: "/unused", run: async input => {
    calls.push(input); return { stdout: input.command.includes("ls-remote") ? `${commit}\trefs/heads/main\n` : input.command.includes("rev-parse") ? commit : "", stderr: "", exitCode: 0, killed: false };
  } });
  return { wire, egress, calls, transport, async close() { await wire.close(); egress.stop(); } };
}

test("qualified Git discovery and fetch hold one fixed proxy budget; offline inspection receives neither proxy nor token", async () => {
  const f = await fixture(), root = mkdtempSync(join(tmpdir(), "odysseus-wire-binding-"));
  try {
    expect(await f.transport.resolve({ repository, revision: "main", token: null, wire: f.wire })).toMatchObject({ ok: true, commit });
    expect(await f.transport.fetch({ repository, ref: "refs/heads/main", token: "odysseus-fixture-token", root, wire: f.wire })).toEqual({ commit });
    expect(f.calls).toHaveLength(3);
    for (const [index, credentialed] of [[0, false], [1, true]] as const) {
      expect(f.calls[index]!.env?.HTTPS_PROXY, "REFERENCE_QUALIFIED_GIT_USES_OWNED_PROXY").toBe(f.wire.gitProxyUrl(credentialed));
      expect(f.calls[index]!.env?.NO_PROXY).toBe("");
      expect(f.calls[index]!.signal?.aborted).toBe(false);
    }
    expect(f.calls[1]!.env?.BRAIN_REFERENCE_TOKEN).toBe("odysseus-fixture-token");
    expect(f.calls[2]!.env, "REFERENCE_OFFLINE_PARSE_HAS_NO_CREDENTIAL_OR_PROXY").not.toHaveProperty("BRAIN_REFERENCE_TOKEN");
    expect(f.calls[2]!.env).not.toHaveProperty("HTTPS_PROXY");
    expect(f.calls[2]!.transport?.network).toBe(false);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("another repository and an ended wire cannot borrow the qualified channel before staging or dispatch", async () => {
  const f = await fixture(), root = mkdtempSync(join(tmpdir(), "odysseus-wire-scope-"));
  try {
    const other = referenceRepository("https://github.com/penelope/loom");
    await expect(f.transport.resolve({ repository: other, revision: "main", token: null, wire: f.wire }), "REFERENCE_WIRE_REPOSITORY_BOUND").rejects.toMatchObject({ reason: "invalid" });
    await expect(f.transport.fetch({ repository: other, ref: "refs/heads/main", token: null, root, wire: f.wire })).rejects.toMatchObject({ reason: "invalid" });
    expect(f.calls).toEqual([]); expect(readdirSync(root)).toEqual([]);
    await f.wire.close();
    await expect(f.transport.resolve({ repository, revision: "main", token: null, wire: f.wire }), "REFERENCE_ENDED_WIRE_NOT_DISPATCHED").rejects.toThrow();
    expect(f.calls).toEqual([]);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ["discovery", "fetch", "offline-inspection"] as const)
  test(`an ended managed wire during held ${phase} refuses its successful late command result`, async () => {
    const f = await fixture(), root = mkdtempSync(join(tmpdir(), "odysseus-wire-held-"));
    let ready!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const calls: (MaintenanceCommand & { signal?: AbortSignal })[] = [];
    const transport = createReferenceTransport({ brainPath: "/unused", run: async input => {
      calls.push(input);
      if ((phase === "discovery" && input.command.includes("ls-remote")) || (phase === "fetch" && input.command.includes("fetch"))
        || (phase === "offline-inspection" && input.command.includes("rev-parse"))) { ready(); await held; }
      return { stdout: phase === "discovery" ? `${commit}\trefs/heads/main\n` : commit, stderr: "", exitCode: 0, killed: false };
    } });
    const pending = phase === "discovery" ? transport.resolve({ repository, revision: "main", token: null, wire: f.wire })
      : transport.fetch({ repository, ref: "refs/heads/main", token: null, root, wire: f.wire });
    try {
      await reached; await f.wire.close(); release();
      await expect(pending, "REFERENCE_ENDED_WIRE_NEVER_PUBLISHES_LATE_COMMAND_RESULT").rejects.toThrow();
      expect(calls.at(-1)?.signal?.aborted, "REFERENCE_OFFLINE_INSPECTION_RETAINS_WIRE_CANCELLATION").toBe(true);
    } finally { release(); await pending.catch(() => {}); await f.close(); rmSync(root, { recursive: true, force: true }); }
  });
