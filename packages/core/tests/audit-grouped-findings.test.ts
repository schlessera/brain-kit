/**
 * #394: `brain audit` groups TODO and VERIFY markers into one finding per
 * document and category, both `info`; reads the `verification: unverified`
 * declaration; reports unresolved wiki-links as `broken-link` warnings through
 * the indexer's own resolution; and `brain maintain` reports must-fix
 * (errors + warnings) and informational (infos) totals beside the severity
 * counts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { audit, auditTotals, isoDay } from "../src/lib/auditor";
import { openDatabase, SCHEMA_VERSION } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { brainConfigSchema } from "../src/lib/config";
import type { AuditIssue } from "../src/lib/types";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-01T00:00:00Z");
const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({}) });

/** A markdown row, inserted the way the auditor tests do: no verification column named. */
function insertDoc(db: Database, path: string, content: string): void {
  db.run(
    `INSERT INTO documents (path, title, type, status, relevance, created, updated, content, content_hash, asset_type, indexed_at)
     VALUES (?, ?, 'note', 'active', 'primary', '2026-06-01', '2026-06-20', ?, ?, 'markdown', '2026-06-20')`,
    [path, path, content, `hash-${path}`]
  );
}

const of = (issues: AuditIssue[], category: string, path?: string) =>
  issues.filter((i) => i.category === category && (path === undefined || i.path === path));

describe("TODO and VERIFY markers, grouped per document", () => {
  test("three VERIFY markers are one info finding with count 3", () => {
    const db = openDatabase(":memory:");
    try {
      insertDoc(db, "notes/eagles.md", "Barred [VERIFY: call] or spotted [VERIFY: plumage], seen [VERIFY: 2019].");
      const verify = of(audit(db, taxonomy, { now: NOW }), "verify");
      expect(verify).toEqual([
        expect.objectContaining({
          path: "notes/eagles.md",
          severity: "info",
          count: 3,
          examples: ["[VERIFY: call]", "[VERIFY: plumage]", "[VERIFY: 2019]"],
        }),
      ]);
    } finally {
      db.close();
    }
  });

  test("five TODO markers are one info finding with count 5 and the first three, in source order", () => {
    const db = openDatabase(":memory:");
    try {
      insertDoc(db, "notes/gate.md", "[TODO: e] then [TODO: d]\n\n[TODO: c]\n[TODO: b] and [TODO: a]");
      const todo = of(audit(db, taxonomy, { now: NOW }), "todo");
      expect(todo).toEqual([
        expect.objectContaining({ path: "notes/gate.md", severity: "info", count: 5, examples: ["[TODO: e]", "[TODO: d]", "[TODO: c]"] }),
      ]);
      expect(todo[0].message).toBe("5 TODO markers, the first 3: [TODO: e], [TODO: d], [TODO: c]");
    } finally {
      db.close();
    }
  });

  test("a file with both kinds has one finding per category, and the output is deterministic", () => {
    const db = openDatabase(":memory:");
    try {
      insertDoc(
        db,
        "notes/mixed.md",
        "[VERIFY: v1] [TODO: t1] [VERIFY: v2] [TODO: t2] [VERIFY: v3] [VERIFY: v4] [TODO: t3] [TODO: t4]"
      );
      insertDoc(db, "notes/clean.md", "Nothing to mark here.");
      const issues = audit(db, taxonomy, { now: NOW });
      const markers = issues.filter((i) => i.category === "todo" || i.category === "verify");
      expect(markers.map((i) => [i.category, i.path, i.severity, i.count, i.examples])).toEqual([
        ["todo", "notes/mixed.md", "info", 4, ["[TODO: t1]", "[TODO: t2]", "[TODO: t3]"]],
        ["verify", "notes/mixed.md", "info", 4, ["[VERIFY: v1]", "[VERIFY: v2]", "[VERIFY: v3]"]],
      ]);
      // Not only equal in shape: the same run twice gives the same findings.
      expect(audit(db, taxonomy, { now: NOW })).toEqual(issues);
    } finally {
      db.close();
    }
  });

  test("a document with one marker still carries count and examples", () => {
    const db = openDatabase(":memory:");
    try {
      insertDoc(db, "notes/one.md", "Check [TODO: one].");
      expect(of(audit(db, taxonomy, { now: NOW }), "todo")).toEqual([
        { path: "notes/one.md", severity: "info", category: "todo", message: "1 TODO marker: [TODO: one]", count: 1, examples: ["[TODO: one]"] },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("the verification declaration, over the index", () => {
  test("verification: unverified is one info finding, markers or not; the absence of it says nothing", () => {
    const db = openDatabase(":memory:");
    try {
      const insert = (path: string, verification: string | null, content: string) =>
        db.run(
          `INSERT INTO documents (path, title, type, status, relevance, created, updated, content, content_hash, asset_type, indexed_at, verification)
           VALUES (?, ?, 'note', 'active', 'primary', '2026-06-01', '2026-06-20', ?, ?, 'markdown', '2026-06-20', ?)`,
          [path, path, content, `hash-${path}`, verification]
        );
      insert("notes/declared.md", "unverified", "No inline markers.");
      insert("notes/declared-marked.md", "unverified", "[VERIFY: a] and [VERIFY: b].");
      insert("notes/undeclared.md", null, "No markers, no declaration.");
      const verify = of(audit(db, taxonomy, { now: NOW }), "verify");
      expect(verify.map((i) => [i.path, i.severity, i.count, i.examples])).toEqual([
        ["notes/declared-marked.md", "info", 2, ["[VERIFY: a]", "[VERIFY: b]"]],
        ["notes/declared.md", "info", 0, []],
      ]);
      expect(verify.find((i) => i.path === "notes/declared.md")?.message).toBe("Declared verification: unverified");
      expect(verify.find((i) => i.path === "notes/declared-marked.md")?.message).toBe(
        "Declared verification: unverified; 2 VERIFY markers: [VERIFY: a], [VERIFY: b]"
      );
    } finally {
      db.close();
    }
  });
});

test("auditTotals: must-fix is errors plus warnings, informational is infos", () => {
  const issue = (severity: AuditIssue["severity"]): AuditIssue => ({ path: "p.md", severity, category: "c", message: "m" });
  const issues = [issue("error"), issue("warning"), issue("warning"), issue("info"), issue("info"), issue("info")];
  expect(auditTotals(issues)).toEqual({ errors: 1, warnings: 2, infos: 3, mustFix: 3, informational: 3 });
  expect(auditTotals([])).toEqual({ errors: 0, warnings: 0, infos: 0, mustFix: 0, informational: 0 });
});

describe("over a real indexed brain", () => {
  let root: string;
  const today = isoDay(Date.now());
  const doc = (title: string, body: string, extra = "") =>
    `---\ntype: note\ntitle: ${title}\ncreated: 2026-01-01\nupdated: ${today}\ntags: [t]\nstatus: active\nrelevance: secondary\n${extra}---\n\n${body}\n`;

  interface AuditOut extends ReturnType<typeof auditTotals> {
    issues: AuditIssue[];
  }
  let audited: AuditOut;

  beforeAll(async () => {
    root = makeTempBrain({ empty: true });
    writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
    mkdirSync(join(root, "notes/deep"), { recursive: true });
    mkdirSync(join(root, "projects/kiln"), { recursive: true });
    writeFileSync(join(root, "notes/target.md"), doc("Target", "## Heading\n\nText.", "aliases: [Kiln Log]\n"));
    writeFileSync(join(root, "projects/kiln/_index.md"), doc("Kiln", "The kiln project. [[notes/target]]"));
    writeFileSync(
      join(root, "notes/links.md"),
      doc("Links", "[[target]] [[notes/target]] [[target#Heading]] [[Kiln Log]] [[kiln/]] [[target|shown]]")
    );
    writeFileSync(join(root, "notes/broken.md"), doc("Broken", "[[target]] then [[no-such-page]] and [[gone/away#part]]"));
    writeFileSync(join(root, "notes/claims.md"), doc("Claims", "See [[target]]. [VERIFY: one] [VERIFY: two]", "verification: unverified\n"));
    writeFileSync(join(root, "notes/declared.md"), doc("Declared", "See [[target]].", "verification: unverified\n"));
    writeFileSync(join(root, "notes/plain.md"), doc("Plain", "See [[target]]. [TODO: one] [TODO: two] [TODO: three]"));
    // Overdue reviews, as before this change: past is due, today is not, archived never.
    writeFileSync(join(root, "notes/review-past.md"), doc("Review past", "See [[target]].", "next_review: 2026-01-02\n"));
    writeFileSync(join(root, "notes/review-today.md"), doc("Review today", "See [[target]].", `next_review: ${today}\n`));
    writeFileSync(
      join(root, "notes/review-archived.md"),
      doc("Review archived", "See [[target]].", "next_review: 2026-01-02\n").replace("status: active", "status: archived")
    );
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const { stdout, code } = await runCli(root, ["audit", "--json"]);
    expect(code).toBe(0);
    audited = JSON.parse(stdout);
  });

  afterAll(() => cleanup(root));

  test("the index stores the declaration, and only where it is set", () => {
    const db = openDatabase(join(root, "brain.db"), { readonly: true });
    try {
      const rows = db.prepare("SELECT path, verification FROM documents WHERE verification IS NOT NULL ORDER BY path").all();
      expect(rows).toEqual([
        { path: "notes/claims.md", verification: "unverified" },
        { path: "notes/declared.md", verification: "unverified" },
      ]);
    } finally {
      db.close();
    }
  });

  test("verify: one info finding per declaring document; none for a document that declares nothing", () => {
    const verify = of(audited.issues, "verify");
    expect(verify.map((i) => [i.path, i.severity, i.count])).toEqual([
      ["notes/claims.md", "info", 2],
      ["notes/declared.md", "info", 0],
    ]);
    const todo = of(audited.issues, "todo");
    expect(todo.map((i) => [i.path, i.severity, i.count])).toEqual([["notes/plain.md", "info", 3]]);
  });

  test("broken-link: a warning per unresolved link, tied to its source and target", () => {
    const broken = of(audited.issues, "broken-link");
    expect(broken.length).toBeGreaterThan(0);
    expect(broken).toEqual([
      {
        path: "notes/broken.md",
        severity: "warning",
        category: "broken-link",
        message: "Unresolved wiki-link: [[gone/away#part]]",
        suggestion: "Point it at an existing document, add the target as an alias, or remove the link",
        target: "gone/away#part",
      },
      {
        path: "notes/broken.md",
        severity: "warning",
        category: "broken-link",
        message: "Unresolved wiki-link: [[no-such-page]]",
        suggestion: "Point it at an existing document, add the target as an alias, or remove the link",
        target: "no-such-page",
      },
    ]);
  });

  test("broken-link: paths, aliases, anchors, pipes and directory anchors resolve, so they raise none", () => {
    // The control: the audit did report broken links, so an empty list below is not a silent check.
    expect(of(audited.issues, "broken-link").length).toBeGreaterThan(0);
    expect(of(audited.issues, "broken-link", "notes/links.md")).toEqual([]);
  });

  test("broken-link agrees with brain validate and brain stats", async () => {
    const validated = JSON.parse((await runCli(root, ["validate", "--json"])).stdout) as {
      issues: { file: string; level: string; message: string }[];
    };
    const unresolved = validated.issues
      .filter((i) => /wiki-link: \[\[/.test(i.message))
      .map((i) => [i.file, i.level, i.message])
      .sort();
    expect(unresolved.length).toBeGreaterThan(0);
    expect(of(audited.issues, "broken-link").map((i) => [i.path, i.severity, i.message]).sort()).toEqual(unresolved);
    const stats = JSON.parse((await runCli(root, ["stats", "--json"])).stdout) as { brokenLinks: number };
    expect(stats.brokenLinks).toBe(of(audited.issues, "broken-link").length);
  });

  test("validate accepts verification: unverified and warns on any other value", async () => {
    writeFileSync(join(root, "notes/verified.md"), doc("Verified", "See [[target]].", "verification: verified\n"));
    try {
      const { stdout } = await runCli(root, ["validate", "--json"]);
      const issues = (JSON.parse(stdout).issues as { file: string; level: string; message: string }[]).filter((i) =>
        i.message.includes("verification")
      );
      expect(issues).toEqual([
        {
          file: "notes/verified.md",
          level: "warning",
          message: 'Unrecognised verification: "verified". The only value brain reads is "unverified"; otherwise leave the field out',
        },
      ]);
    } finally {
      rmSync(join(root, "notes/verified.md"));
    }
  });

  test("overdue reviews are unchanged: past is due, today is not, archived never, no second category", () => {
    const reviews = audited.issues.filter((i) => /review/.test(i.category));
    expect(reviews.map((i) => [i.category, i.path, i.severity])).toEqual([["review-overdue", "notes/review-past.md", "warning"]]);
  });

  test("the audit envelope's must-fix and informational totals follow the grouped findings", () => {
    const count = (s: string) => audited.issues.filter((i) => i.severity === s).length;
    expect(audited.infos).toBeGreaterThan(0);
    expect(audited.warnings).toBeGreaterThan(0);
    expect(audited.errors).toBe(count("error"));
    expect(audited.warnings).toBe(count("warning"));
    expect(audited.infos).toBe(count("info"));
    expect(audited.mustFix).toBe(audited.errors + audited.warnings);
    expect(audited.informational).toBe(audited.infos);
  });

  test("maintain reports the same counts with must-fix and informational totals", async () => {
    const { stdout } = await runCli(root, ["maintain", "--json", "--no-git"]);
    const step = (JSON.parse(stdout) as { step: string; result: string }[]).find((s) => s.step === "audit");
    // maintain reindexes first; nothing changed, so the audit is the same one.
    const again = JSON.parse((await runCli(root, ["audit", "--json"])).stdout) as AuditOut;
    expect(step?.result).toBe(
      `${again.errors} error(s), ${again.warnings} warning(s), ${again.infos} info(s); ` +
        `${again.errors + again.warnings} must-fix, ${again.infos} informational`
    );
    expect(again.warnings).toBeGreaterThan(0);
    expect(again.infos).toBeGreaterThan(0);
  });
});

test("opening a schema 14 database adds the verification column and makes the next index re-read its files", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-verification-"));
  try {
    const path = join(dir, "brain.db");
    const db = openDatabase(path);
    db.run("ALTER TABLE documents DROP COLUMN verification");
    db.run(
      "INSERT INTO documents(path,title,type,status,created,updated,content,content_hash,asset_type,indexed_at) VALUES ('notes/a.md','A','note','active','2026-01-01','2026-01-01','x','hash-a','markdown','2026-01-01')"
    );
    db.run("INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('schema_version', '14')");
    db.close();

    const reopened = openDatabase(path);
    try {
      const columns = (reopened.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toContain("verification");
      expect(reopened.prepare("SELECT content_hash FROM documents WHERE path = 'notes/a.md'").get()).toEqual({ content_hash: null });
      expect(SCHEMA_VERSION).toBe(15);
      expect(reopened.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get()).toEqual({ value: "15" });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a schema 14 index is audited read-only before anything migrates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-verification-ro-"));
  try {
    const path = join(dir, "brain.db");
    const db = openDatabase(path);
    db.run("ALTER TABLE documents DROP COLUMN verification");
    insertDoc(db, "notes/a.md", "[VERIFY: x]");
    db.run("INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('schema_version', '14')");
    db.close();
    const ro = openDatabase(path, { readonly: true });
    try {
      expect(of(audit(ro, taxonomy, { now: NOW }), "verify").map((i) => [i.path, i.count])).toEqual([["notes/a.md", 1]]);
    } finally {
      ro.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
