/**
 * `brain read-many` (#3642): the CLI front door of the bounded multi-read.
 * The same operation as `brain_read_many`, so the operation's own tests carry
 * the caps and kinds; these assert the CLI envelope, its two input forms and
 * that invalid input is a usage error that prints nothing on stdout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;
beforeAll(() => {
  root = makeTempBrain();
});
afterAll(() => cleanup(root));

describe("brain read-many --json", () => {
  test("paths as arguments: one compact envelope, items in order, the counted text exactly", async () => {
    const r = await runCli(root, ["read-many", "me/identity.md", "../escape.md", "me/identity.md", "--json"]);
    expect(r.code).toBe(0);
    const out = r.stdout.replace(/\n$/, "");
    const body = JSON.parse(out);
    expect(out).toBe(JSON.stringify(body));
    expect(Object.keys(body)).toEqual(["items", "truncated", "max_total_chars", "max_item_chars", "warnings"]);
    expect(body.items.map((i: { kind: string; code?: string }) => i.code ?? i.kind)).toEqual(["full", "refused", "duplicate"]);
    expect(body.items[0].content).toBe(readFileSync(join(root, "me/identity.md"), "utf-8"));
    expect(body.warnings).toEqual([]);
    expect(out).not.toContain(root);
  });

  test("an absolute path inside the brain is taken as brain-relative, as brain read takes it", async () => {
    const r = await runCli(root, ["read-many", join(root, "me/identity.md"), "--json"]);
    expect(JSON.parse(r.stdout).items[0]).toMatchObject({ kind: "full", path: "me/identity.md" });
  });

  test("--input takes the brain_read_many input, sections and caps included", async () => {
    const input = join(root, "read-many-input.json");
    writeFileSync(input, JSON.stringify({ requests: [{ path: "me/identity.md", section: "Reaching Odysseus" }, { path: "me/identity.md", offset: 1 }], max_total_chars: 2_000, max_item_chars: 900 }));
    const r = await runCli(root, ["read-many", "--input", input, "--json"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().length).toBeLessThanOrEqual(2_000);
    const body = JSON.parse(r.stdout);
    expect(body.items.map((i: { kind: string }) => i.kind)).toEqual(["full", "partial"]);
    expect(body.items[0].content.startsWith("## Reaching Odysseus\n")).toBe(true);
  });

  test("the cap flags apply to argument paths and are refused, not clamped, out of range", async () => {
    const ok = await runCli(root, ["read-many", "me/identity.md", "--max-total-chars", "2000", "--max-item-chars", "600", "--json"]);
    expect(JSON.parse(ok.stdout)).toMatchObject({ max_total_chars: 2_000, max_item_chars: 600 });
    for (const args of [
      ["--max-total-chars", "100"],
      ["--max-total-chars", "40001"],
      ["--max-total-chars", "2000abc"],
      ["--max-item-chars", "511"],
      ["--max-total-chars", "2000", "--max-item-chars", "2001"],
    ]) {
      const r = await runCli(root, ["read-many", "me/identity.md", ...args, "--json"]);
      expect([args.join(" "), r.code, r.stdout]).toEqual([args.join(" "), 1, ""]);
    }
  });

  test("no request, too many, or two input forms at once are usage errors", async () => {
    const twentyOne = Array.from({ length: 21 }, () => "me/identity.md");
    for (const args of [[], twentyOne, ["me/identity.md", "--input", "x.json"], ["--input"], ["--input", join(root, "missing.json")]]) {
      const r = await runCli(root, ["read-many", ...args, "--json"]);
      expect(r.code, args.join(" ").slice(0, 60)).toBe(1);
      expect(r.stdout).toBe("");
    }
  });

  test("human mode labels each item", async () => {
    const r = await runCli(root, ["read-many", "me/identity.md", "../escape.md", "--human"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("=== [0] me/identity.md (full, sha256 ");
    expect(r.stdout).toContain("=== [1] ../escape.md (refused)");
  });
});
