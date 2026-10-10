import { createHash } from "crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { brainConfigSchema } from "../src/lib/config";
import type { BrainContext } from "../src/lib/context";
import { hygieneId, readHygieneLog } from "../src/lib/hygiene";
import { repairDetection, repairHandlers, resolveHygiene } from "../src/lib/hygiene-repair";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const DOC = "journeys/return-to-ithaca.md";
const LINK = hygieneId("broken-link", DOC, "Eumaios hut");
const TITLE = hygieneId("required-field", DOC, "title");
const TODO = hygieneId("todo", DOC, "");
const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));
const raw = (body = "Odysseus met [[Eumaios hut]] and [[Eumaios hut|the swineherd]].") => `---\n# The voyage\ntitle: 'Return to Ithaca' # keep quotes\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n---\n\n${body}\n`;
function write(root: string, path: string, text: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}
function brain(text = raw()) {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  write(root, "brain.config.json", JSON.stringify({ taxonomy: {} }));
  write(root, DOC, text);
  write(root, "places/eumaeus-hut.md", raw("The swineherd's hut.").replace("Return to Ithaca", "Eumaios hut"));
  return root;
}
const context = (root: string): BrainContext => ({ root, dbPath: join(root, "brain.db"), config: null, configPath: join(root, "brain.config.json"), modules: [], taxonomy: buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy: {} }) }) });
async function cli(root: string, ...args: string[]) {
  const r = await runCli(root, ["hygiene", ...args, "--json"]);
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(`CLI exit ${r.code}: ${r.stderr}\n${r.stdout}`); }
  return { ...r, out };
}
async function fingerprint(root: string, id = LINK): Promise<string> {
  const r = await cli(root, "reconcile"); expect(r.code).toBe(0);
  const f = r.out.detected.find((f: { id: string }) => f.id === id);
  expect(f).toBeDefined(); return f.fingerprint;
}
async function preview(root: string, fp: string, handler = "link-text", input: unknown = null, id = LINK) {
  const r = await cli(root, "resolve", id, "--handler", handler, "--input", JSON.stringify(input), "--expect-fingerprint", fp, "--dry-run");
  expect(r.code).toBe(0); expect(r.out.status).toBe("preview"); return r.out;
}
async function apply(root: string, fp: string, p: { previewToken: string }, handler = "link-text", input: unknown = null, id = LINK) {
  return cli(root, "resolve", id, "--handler", handler, "--input", JSON.stringify(input), "--expect-fingerprint", fp, "--expect-preview", p.previewToken);
}
const bytes = (root: string) => readFileSync(join(root, DOC), "utf8");
function snapshot(root: string, path = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const name = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, snapshot(root, name));
    else result[name] = createHash("sha256").update(readFileSync(join(root, name))).digest("hex");
  }
  return result;
}

describe("bounded hygiene repair CLI", () => {
  for (const handler of ["link-text", "link-note", "link-suggested"]) test(`${handler} changes only broken tokens and records its handler`, async () => {
    const original = raw("Odysseus met [[Eumaios hut]] and [[Eumaios hut|the swineherd]].\n`[[Eumaios hut]]`\n```md\n[[Eumaios hut]]\n```\n[[places/eumaeus-hut]]");
    const root = brain(original), fp = await fingerprint(root);
    const input = handler === "link-note" ? "places/eumaeus-hut.md" : null;
    const before = snapshot(root), p = await preview(root, fp, handler, input);
    expect(snapshot(root)).toEqual(before);
    expect(p.diff.before).toBe(original); expect(p.diff.changes).toHaveLength(2);
    const expected = handler === "link-text" ? original.replace("[[Eumaios hut]] and [[Eumaios hut|the swineherd]]", "Eumaios hut and the swineherd") : original.replace("[[Eumaios hut]] and [[Eumaios hut|the swineherd]]", "[[places/eumaeus-hut|Eumaios hut]] and [[places/eumaeus-hut|the swineherd]]");
    expect(p.diff.after).toBe(expected);
    const fixed = await apply(root, fp, p, handler, input);
    expect(fixed.code).toBe(0); expect(fixed.out.status).toBe("fixed"); expect(bytes(root)).toBe(expected);
    expect(readHygieneLog(root).find(e => e.id === LINK)).toMatchObject({ state: "resolved", resolvedBy: `handler:${handler}` });
    expect((await cli(root, "list")).code).toBe(0);
  });

  test("unique slug, alias and exact title suggestions; absent for zero or multiple matches", async () => {
    for (const kind of ["slug", "alias", "title", "none", "multiple"]) {
      const target = kind === "slug" ? "lost/Eumaios hut" : kind === "alias" ? "Eumaios hut#door" : "Eumaios hut";
      const root = brain(raw().replaceAll("Eumaios hut", target));
      write(root, "places/eumaeus-hut.md", raw("The hut.").replace("Return to Ithaca", kind === "title" ? "Eumaios hut" : "The hut"));
      if (kind === "alias" || kind === "multiple") write(root, "places/eumaeus-hut.md", raw("The hut.").replace("type: note", "type: note\naliases: [Eumaios hut]"));
      if (kind === "slug") write(root, "places/Eumaios hut.md", raw("The hut."));
      if (kind === "multiple") write(root, "places/another-hut.md", raw("The hut.").replace("type: note", "type: note\naliases: [Eumaios hut]"));
      const d = await repairDetection(context(root), new Date());
      const finding = d.findings.get(hygieneId("broken-link", DOC, target));
      expect(finding, kind).toBeDefined();
      const handlers = repairHandlers(context(root), finding!);
      expect(handlers.some(h => h.name === "link-suggested")).toBe(!["none", "multiple"].includes(kind));
    }
  });

  test("required title sets exactly one key and retains all other bytes", async () => {
    const original = raw().replace("title: 'Return to Ithaca' # keep quotes\n", "");
    const root = brain(original), fp = await fingerprint(root, TITLE);
    const p = await preview(root, fp, "required-field", "Return to Ithaca", TITLE);
    const fixed = await apply(root, fp, p, "required-field", "Return to Ithaca", TITLE);
    // The link still fails validation: writing one field alone must never report fixed.
    expect(fixed.code).toBe(1); expect(fixed.out.status).toBe("check_failed");
    expect(bytes(root).replace('title: "Return to Ithaca"\n', "")).toBe(original);
    expect(readHygieneLog(root).find(e => e.id === TITLE)?.state).toBe("open");
  });

  test("valid enum/date/tags fields are typed and byte-bounded", async () => {
    for (const [field, value] of [["type", "note"], ["created", "2026-07-12"], ["updated", "2026-07-12"], ["tags", ["voyage"]]] as const) {
      const original = raw("Odysseus sails.").replace(new RegExp(`^${field}:.*\\n`, "m"), "");
      const root = brain(original), id = hygieneId("required-field", DOC, field), fp = await fingerprint(root, id);
      const p = await preview(root, fp, "required-field", value, id);
      const r = await apply(root, fp, p, "required-field", value, id);
      expect(r.code).toBe(0); expect(r.out.status).toBe("fixed");
      expect(bytes(root).replace(new RegExp(`^${field}:.*\\n`, "m"), "")).toBe(original);
    }
  });

  test("invalid date and enum input return field errors without writing", async () => {
    for (const [field, value] of [["created", "2026-02-30"], ["created", "tomorrow"], ["type", "unknown"]]) {
      const root = brain(raw("Odysseus sails.").replace(new RegExp(`^${field}:.*\\n`, "m"), "")), id = hygieneId("required-field", DOC, field), fp = await fingerprint(root, id);
      const before = snapshot(root);
      const r = await cli(root, "resolve", id, "--handler", "required-field", "--input", JSON.stringify(value), "--expect-fingerprint", fp, "--dry-run");
      expect(r.code).toBe(1); expect(r.out).toMatchObject({ status: "refused", reason: "invalid-input", fieldError: { field } });
      expect(snapshot(root)).toEqual(before);
    }
  });

  test("frontmatter refusal never falls back to a serializer or rewrites other keys", async () => {
    const original = raw("Odysseus sails.").replace("type: note", "type: {wrong: value}");
    const root = brain(original), id = hygieneId("required-field", DOC, "type"), fp = await fingerprint(root, id), before = snapshot(root);
    const r = await cli(root, "resolve", id, "--handler", "required-field", "--input", '"note"', "--expect-fingerprint", fp, "--dry-run");
    expect(r.out.diff?.after ?? bytes(root)).toBe(original);
    expect(r.code).toBe(1); expect(r.out.reason).toBe("frontmatter-edit-refused");
    expect(snapshot(root)).toEqual(before); expect(bytes(root)).toBe(original);
  });

  test("stale fingerprint writes nothing", async () => {
    const root = brain(), fp = await fingerprint(root), p = await preview(root, fp), before = snapshot(root);
    const r = await apply(root, "000000000000", p);
    expect(snapshot(root)).toEqual(before); expect(r.code).toBe(1); expect(r.out.status).toBe("stale");
  });

  test("preview counts every replaced token; changed premise writes nothing", async () => {
    const root = brain(), fp = await fingerprint(root), p = await preview(root, fp);
    // Fingerprinting deduplicates identical tokens; the preview must still bind their multiplicity.
    write(root, DOC, bytes(root) + "Another [[Eumaios hut]].\n");
    const before = snapshot(root), r = await apply(root, fp, p);
    expect(snapshot(root)).toEqual(before); expect(r.code).toBe(1); expect(r.out.status).toBe("stale");
  });

  test("unrelated edit after preview still permits the bounded fix", async () => {
    const root = brain(), fp = await fingerprint(root), p = await preview(root, fp);
    write(root, DOC, bytes(root) + "\n# Homecoming\n");
    const r = await apply(root, fp, p);
    expect(r.code).toBe(0); expect(r.out.status).toBe("fixed"); expect(bytes(root)).toEndWith("\n# Homecoming\n");
  });

  test("outside, symlink escape and non-document paths are refused without writing", async () => {
    const root = brain(), outside = brain(raw("A different voyage.")), fp = await fingerprint(root);
    symlinkSync(join(outside, DOC), join(root, "places/escape.md"));
    for (const path of [join(outside, DOC), "../outside.md", "brain.config.json", "places/escape.md", "places/missing.md"]) {
      const before = snapshot(root), outsideBefore = snapshot(outside);
      const r = await cli(root, "resolve", LINK, "--handler", "link-note", "--input", JSON.stringify(path), "--expect-fingerprint", fp, "--dry-run");
      expect(r.code).toBe(1); expect(r.out.status).toBe("refused"); expect(snapshot(root)).toEqual(before); expect(snapshot(outside)).toEqual(outsideBefore);
    }
  });

  test("post-check failure after a real write leaves open, never rolls back; confirmed Undo restores exact bytes", async () => {
    const original = raw().replace("title: 'Return to Ithaca' # keep quotes\n", "");
    const root = brain(original), fp = await fingerprint(root), p = await preview(root, fp), r = await apply(root, fp, p);
    expect(r.code).toBe(1); expect(r.out.status).toBe("check_failed"); expect(r.out.code).toBe("required-missing");
    expect(bytes(root)).toBe(p.diff.after); expect(bytes(root)).not.toBe(original);
    expect(readHygieneLog(root).find(e => e.id === LINK)?.state).toBe("open");
    const before = snapshot(root), inv = await cli(root, "undo", r.out.undoToken, "--dry-run");
    expect(inv.code).toBe(0); expect(inv.out.diff).toMatchObject({ before: p.diff.after, after: original }); expect(snapshot(root)).toEqual(before);
    const undone = await cli(root, "undo", r.out.undoToken);
    expect(undone.code).toBe(0); expect(undone.out.status).toBe("undone"); expect(bytes(root)).toBe(original);
    const replay = await cli(root, "undo", r.out.undoToken); expect(replay.code).toBe(1); expect(replay.out.status).toBe("stale");
  });

  test("forced post-check failure runs after real write and never reports fixed", async () => {
    const root = brain(), fp = await fingerprint(root), p = await preview(root, fp); let called = false;
    const r = await resolveHygiene(context(root), { id: LINK, handler: "link-text", input: null, expectFingerprint: fp, expectPreview: p.previewToken }, { postCheck: () => { called = true; expect(bytes(root)).toBe(p.diff.after); return "forced-failure"; } });
    expect(called).toBe(true); expect(r.status).toBe("check_failed"); expect(r.code).toBe("forced-failure"); expect(r.undoToken).toBeDefined();
    expect(readHygieneLog(root).find(e => e.id === LINK)?.state).toBe("open");
  });

  test("Undo refuses all edits after the fix, without writing", async () => {
    const root = brain(raw().replace("title: 'Return to Ithaca' # keep quotes\n", "")), fp = await fingerprint(root), p = await preview(root, fp), r = await apply(root, fp, p);
    expect(r.out.status).toBe("check_failed");
    write(root, DOC, bytes(root) + "# Ithaca\n");
    const before = snapshot(root), u = await cli(root, "undo", r.out.undoToken);
    expect(snapshot(root)).toEqual(before); expect(u.code).toBe(1); expect(u.out.status).toBe("stale");
  });

  test("manual check while still detected writes no content, index or log; disappearance resolves only itself", async () => {
    const root = brain(raw("[TODO: ask Eumaeus.]\n[VERIFY: the route.]\n[[Eumaios hut]]")); await fingerprint(root);
    const before = snapshot(root), r = await cli(root, "check", TODO);
    expect(snapshot(root)).toEqual(before); expect(r.code).toBe(0); expect(r.out.status).toBe("still_detected"); expect(r.out.handler).toMatchObject({ name: "manual", kind: "manual", path: DOC }); expect(snapshot(root)).toEqual(before);
    write(root, DOC, bytes(root).replace("[TODO: ask Eumaeus.]", "Ask Eumaeus."));
    const c = await cli(root, "check", TODO);
    expect(c.code).toBe(0); expect(c.out.status).toBe("not_detected");
    expect(readHygieneLog(root).find(e => e.id === TODO)).toMatchObject({ state: "resolved", resolvedBy: "check" });
    expect(readHygieneLog(root).find(e => e.id === LINK)?.state).toBe("open");
  });

  test("manual handlers have no write path", async () => {
    const root = brain(raw("[TODO: ask Eumaeus.]")), fp = await fingerprint(root, TODO), before = snapshot(root);
    const r = await cli(root, "resolve", TODO, "--handler", "manual", "--input", "null", "--expect-fingerprint", fp, "--dry-run");
    expect(r.code).toBe(1); expect(r.out.reason).toBe("manual-only"); expect(snapshot(root)).toEqual(before);
  });

  for (const operation of ["resolve", "undo", "check"]) test(`uninitialized brain refuses ${operation} writes with parsed positionals`, async () => {
    const root = brain(operation === "undo"
      ? raw().replace("title: 'Return to Ithaca' # keep quotes\n", "")
      : operation === "check" ? raw("[TODO: ask Eumaeus.]") : raw());
    const fp = await fingerprint(root, operation === "check" ? TODO : LINK);
    let pos: string[], flags: string[] = [];
    if (operation === "check") {
      write(root, DOC, bytes(root).replace("[TODO: ask Eumaeus.]", "Ask Eumaeus."));
      pos = ["check", TODO];
    } else {
      const p = await preview(root, fp);
      if (operation === "undo") {
        const written = await apply(root, fp, p);
        expect(written.out.status).toBe("check_failed");
        pos = ["undo", written.out.undoToken];
      } else {
        pos = ["resolve", LINK];
        flags = ["--handler", "link-text", "--input", "null", "--expect-fingerprint", fp, "--expect-preview", p.previewToken];
      }
    }
    rmSync(join(root, "brain.config.json"));
    const before = snapshot(root);
    for (const args of [
      ["hygiene", "--json", ...flags, "--", ...pos],
      ["hygiene", "--json", ...flags, ...pos],
      ["hygiene", ...pos, ...flags, "--json"],
    ]) {
      const result = await runCli(root, args);
      expect(snapshot(root)).toEqual(before);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("refusing to modify an uninitialized directory");
    }
    if (operation === "resolve") {
      const readOnly = await runCli(root, ["hygiene", "--json", ...flags, "--dry-run", "--", ...pos]);
      expect(readOnly.code).toBe(0);
      expect(JSON.parse(readOnly.stdout).status).toBe("preview");
      expect(snapshot(root)).toEqual(before);
    }
  });

  test("configuration blocker is read-only and other hygiene operations still refuse invalid config", async () => {
    const root = brain(); write(root, "brain.config.json", "{ invalid"); const before = snapshot(root);
    for (const args of [
      ["hygiene", "--json", "check", "configuration-blocker"],
      ["hygiene", "--json", "--", "check", "configuration-blocker"],
    ]) {
      const positional = await runCli(root, args);
      expect(positional.code).toBe(1);
      expect(positional.stdout).toMatch(/"status":\s*"blocked"/);
      expect(snapshot(root)).toEqual(before);
    }
    const r = await runCli(root, ["hygiene", "check", "configuration-blocker", "--json"]);
    expect(r.stdout).toMatch(/"status":\s*"blocked"/);
    const out = JSON.parse(r.stdout);
    expect(r.code).toBe(1); expect(out.status).toBe("blocked"); expect(out.handler.kind).toBe("blocker"); expect(snapshot(root)).toEqual(before);
    const refused = await runCli(root, ["hygiene", "reconcile", "--json"]); expect(refused.code).toBe(1); expect(refused.stderr).toContain("Invalid brain.config"); expect(snapshot(root)).toEqual(before);
    write(root, "brain.config.json", '{"taxonomy":{}}');
    const fixedBefore = snapshot(root), c = await cli(root, "check", "configuration-blocker");
    expect(c.code).toBe(0); expect(c.out.status).toBe("ready"); expect(snapshot(root)).toEqual(fixedBefore); expect(existsSync(join(root, "brain.db"))).toBe(false);
  });
});


test("invalid UTF-8 source is refused without normalizing unrelated bytes", async () => {
  const root = brain(), fp = await fingerprint(root);
  writeFileSync(join(root, DOC), Buffer.concat([Buffer.from(bytes(root)), Buffer.from([0xff])]));
  const before = snapshot(root);
  const r = await cli(root, "resolve", LINK, "--handler", "link-text", "--input", "null", "--expect-fingerprint", fp, "--dry-run");
  expect(snapshot(root)).toEqual(before);
  expect(r.code).toBe(1); expect(r.out).toMatchObject({ status: "refused", reason: "not-utf8" });
});

test("repair receipts do not introduce validation defects", async () => {
  const root = brain(), fp = await fingerprint(root), p = await preview(root, fp);
  const r = await apply(root, fp, p);
  expect(r.code).toBe(0); expect(r.out.status).toBe("fixed");
  const indexed = await runCli(root, ["index", "--json"]);
  expect(indexed.code).toBe(0);
  const checked = await runCli(root, ["validate", "--json"]);
  const out = JSON.parse(checked.stdout);
  expect(out.issues.filter((i: { file: string }) => i.file.startsWith("context/hygiene/repairs/"))).toEqual([]);
  expect(checked.code).toBe(0);
});
