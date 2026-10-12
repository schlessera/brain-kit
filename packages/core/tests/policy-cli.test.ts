import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

test("policy check validates actual frontmatter without evaluating brain configuration", async () => {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, "context/policies/governance.md"), "---\nschema_version: 1\nprofiles:\n  interactive: strict\n---\nOdysseus keeps this policy read-only.\n");
  writeFileSync(join(root, "brain.config.ts"), 'throw new Error("POLICY_CHECK_MUST_NOT_EVALUATE_CONFIG");\n');
  const result = await runCli(root, ["policy", "check", "--json"]);
  expect(result.code, "POLICY_CHECK_READ_ONLY_VALID_ENVELOPE").toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({ schema_version: 1, ok: true, status: "valid", errors: [], effective: { profiles: { interactive: "strict", voice: "governed" } } });
  expect(output.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.stderr).not.toContain("POLICY_CHECK_MUST_NOT_EVALUATE_CONFIG");
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("policy check has explicit invalid and missing envelopes and never writes files", async () => {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  const missing = await runCli(root, ["policy", "check", "--json"]);
  expect(missing.code).toBe(0);
  expect(JSON.parse(missing.stdout)).toMatchObject({ schema_version: 1, ok: true, status: "missing", content_hash: null, errors: [], effective: { profiles: { interactive: "governed" } } });
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, "context/policies/governance.md"), "---\nschema_version: 1\nrelease: [.git/config]\n---\n");
  const invalid = await runCli(root, ["policy", "check", "--json"]);
  expect(invalid.code).toBe(1);
  const envelope = JSON.parse(invalid.stdout);
  expect(envelope).toMatchObject({ schema_version: 1, ok: false, status: "invalid", effective: { profiles: { interactive: "governed" } } });
  expect(envelope.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(envelope.errors.join(" ")).toContain("tier B");
  expect(readFileSync(join(root, "context/policies/governance.md"), "utf8")).toContain("release: [.git/config]");
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("actual brain index excludes governance policy while retaining the fixture corpus", async () => {
  const root = makeTempBrain(); roots.push(root);
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, "context/policies/governance.md"), "---\ntitle: Athena policy\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\nschema_version: 1\n---\nA policy is host input, not searchable knowledge.\n");
  const indexed = await runCli(root, ["index", "--json"]);
  expect(indexed.code, indexed.stderr).toBe(0);
  const db = new Database(join(root, "brain.db"), { readonly: true });
  try {
    expect(db.query("SELECT path FROM documents WHERE path = ?").get("context/policies/governance.md"), "POLICY_INPUT_NOT_INDEXED").toBeNull();
    expect(db.query("SELECT count(*) AS n FROM documents").get()).not.toEqual({ n: 0 });
  } finally { db.close(); }
});
