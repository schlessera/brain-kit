import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReferenceTransport } from "../src/brain/reference-transport";
import { referenceRepository } from "../src/db/reference-grants";

const repository = referenceRepository("https://github.com/odysseus/ithaca");
const commit = "a".repeat(40), tag = "b".repeat(40);
function transport(stdout: string) {
  const calls: string[][] = [];
  return { calls, service: createReferenceTransport({ brainPath: "/unused", run: async input => {
    calls.push([...input.command]); return { stdout, stderr: "", exitCode: 0, killed: false };
  } }) };
}

test("resolution refuses branch/tag ambiguity even when they currently name identical commits", async () => {
  for (const target of [commit, tag]) {
    const { service } = transport(`${commit}\trefs/heads/main\n${target}\trefs/tags/main\n`);
    await expect(service.resolve({ repository, revision: "main", token: null }), "REFERENCE_AMBIGUOUS_REF_NEVER_SELECTED").rejects.toMatchObject({ reason: "invalid" });
  }
});

test("resolution binds exactly one requested full ref and peels only its own annotated tag", async () => {
  const cases = [{ stdout: `${commit}\trefs/heads/main\n`, commit, ref: "refs/heads/main" },
    { stdout: `${tag}\trefs/tags/main\n${commit}\trefs/tags/main^{}\n`, commit, ref: "refs/tags/main" }];
  for (const { stdout, ...expected } of cases) {
    expect(await transport(stdout).service.resolve({ repository, revision: "main", token: null })).toEqual({ ok: true, ...expected });
  }
});

test("malformed, duplicate, foreign and unbounded advertised identities never become a source", async () => {
  for (const output of [`${commit}\trefs/heads/main\n${tag}\trefs/heads/main\n`, `${commit}\trefs/pull/7/head\n`,
    `${commit}\trefs/heads/main\n${tag}\trefs/tags/loom\n`, `${"a".repeat(41)}\trefs/heads/main\n`,
    `${commit}\trefs/tags/main^{}\n`, `${commit}\trefs/heads/main\nmalformed\n`, `${commit}\trefs/heads/main\n`.repeat(500),
    ` ${commit}\trefs/heads/main\n`, `${commit}\trefs/heads/main \n`, `${commit}\trefs/heads/main\n\n`]) {
    await expect(transport(output).service.resolve({ repository, revision: "main", token: null }), "REFERENCE_ADVERTISED_REF_EXACT").rejects.toMatchObject({ reason: "invalid" });
  }
});

test("raw refs and object IDs are refused before any network command or staging write", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-reference-ref-"));
  try {
    for (const revision of ["refs/pull/7/head", "refs/heads/main", "refs/tags/main", "a".repeat(40), "A".repeat(40), "a".repeat(64)]) {
      const { calls, service } = transport(`${commit}\trefs/heads/${revision}\n`);
      await expect(service.resolve({ repository, revision, token: null }), "REFERENCE_RAW_REF_NOT_DISPATCHED").rejects.toMatchObject({ reason: "invalid" });
      expect(calls).toEqual([]);
    }
    for (const ref of ["refs/pull/7/head", commit, "refs/heads/main:refs/heads/loom", "refs/tags/../main", "refs/heads/refs/pull/7/head"]) {
      const { calls, service } = transport("");
      await expect(service.fetch({ repository, ref, token: null, root }), "REFERENCE_FOREIGN_FETCH_NOT_DISPATCHED").rejects.toMatchObject({ reason: "invalid" });
      expect(calls).toEqual([]); expect(readdirSync(root)).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
