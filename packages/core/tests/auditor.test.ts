import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { audit } from "../src/lib/auditor";
import { openDatabase } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { brainConfigSchema } from "../src/lib/config";

// Injected wall clock — every age in these tests is measured against it.
const NOW = new Date("2026-07-01T00:00:00Z");

// Neutral taxonomy for the persona "Alex Example": health notes go stale fast,
// studies live under studies/, journal entries are orphan-exempt, and a
// propagation rule keeps me/basics bios in step with FACTS.md.
const taxonomy = buildTaxonomy({
  user: brainConfigSchema.parse({
    taxonomy: {
      types: {
        health: { dir: "health", staleDays: 60, staleSeverity: "warning" },
        study: { dir: "studies" },
        journal: { dir: "journal", orphanExempt: true },
      },
      propagation: [{ source: "me/basics/FACTS.md", derivatives: "me/basics/*.md" }],
    },
  }),
});

interface DocRow {
  path: string;
  type: string;
  updated: string;
  status?: string;
  content?: string;
  title?: string;
  created?: string;
}

function freshDb(): Database {
  return openDatabase(":memory:");
}

function insertDoc(db: Database, d: DocRow): number {
  db.run(
    `INSERT INTO documents
       (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.path,
      d.title ?? d.path,
      d.type,
      d.status ?? "active",
      "primary",
      null,
      d.created ?? "2026-01-01",
      d.updated,
      d.content ?? "",
      "hash-" + d.path,
      "markdown",
      "2026-01-01",
    ]
  );
  return (db.prepare("SELECT id FROM documents WHERE path = ?").get(d.path) as { id: number }).id;
}

function categories(issues: ReturnType<typeof audit>, category: string) {
  return issues.filter((i) => i.category === category);
}

describe("audit staleness", () => {
  test("flags a document past its type's staleness threshold with that severity", () => {
    const db = freshDb();
    insertDoc(db, { path: "health/knee-injury.md", type: "health", updated: "2026-01-01" });
    // Fresh health note — under the 60-day threshold, no finding.
    insertDoc(db, { path: "health/checkup-log.md", type: "health", updated: "2026-06-20" });

    const stale = categories(audit(db, taxonomy, { now: NOW }), "staleness");
    expect(stale.length).toBe(1);
    expect(stale[0]).toMatchObject({
      path: "health/knee-injury.md",
      severity: "warning",
    });
    expect(stale[0].message).toContain("threshold: 60 days");
    db.close();
  });
});

describe("audit propagation", () => {
  test("flags a derivative older than its source, not one that is newer", () => {
    const db = freshDb();
    insertDoc(db, { path: "me/basics/FACTS.md", type: "identity", updated: "2026-06-01" });
    insertDoc(db, { path: "me/basics/short-bio.md", type: "identity", updated: "2026-05-01" });
    insertDoc(db, { path: "me/basics/long-bio.md", type: "identity", updated: "2026-06-15" });

    const prop = categories(audit(db, taxonomy, { now: NOW }), "propagation");
    expect(prop.length).toBe(1);
    expect(prop[0]).toMatchObject({
      path: "me/basics/short-bio.md",
      severity: "warning",
    });
    expect(prop[0].suggestion).toContain("me/basics/FACTS.md");
    db.close();
  });
});

describe("audit index-lag", () => {
  test("flags an _index.md that lags more than a week behind its detail files", () => {
    const db = freshDb();
    insertDoc(db, { path: "studies/_index.md", type: "index", updated: "2026-01-01" });
    insertDoc(db, { path: "studies/telescope-setup.md", type: "study", updated: "2026-06-01" });

    const lag = categories(audit(db, taxonomy, { now: NOW }), "index-lag");
    expect(lag.length).toBe(1);
    expect(lag[0]).toMatchObject({ path: "studies/_index.md", severity: "warning" });
    db.close();
  });
});

describe("audit stale-draft", () => {
  test("flags a draft older than 90 days", () => {
    const db = freshDb();
    insertDoc(db, {
      path: "notes/old-draft.md",
      type: "note",
      status: "draft",
      updated: "2026-03-01",
    });

    const drafts = categories(audit(db, taxonomy, { now: NOW }), "stale-draft");
    expect(drafts.length).toBe(1);
    expect(drafts[0]).toMatchObject({ path: "notes/old-draft.md", severity: "info" });
    db.close();
  });
});

describe("audit tag-noise", () => {
  test("emits one aggregate finding when singleton tags exceed 40%", () => {
    const db = freshDb();
    const id = insertDoc(db, { path: "notes/tagged.md", type: "note", updated: "2026-06-20" });
    for (const name of ["owls", "trailhead", "lichen"]) {
      db.run("INSERT INTO tags (name) VALUES (?)", [name]);
      const tagId = (db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number }).id;
      db.run("INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)", [id, tagId]);
    }

    const noise = categories(audit(db, taxonomy, { now: NOW }), "tag-noise");
    expect(noise.length).toBe(1);
    expect(noise[0]).toMatchObject({ path: "(corpus)", severity: "info" });
    db.close();
  });
});

describe("audit todo/verify markers", () => {
  test("reports [TODO:] as info and [VERIFY:] as warning", () => {
    const db = freshDb();
    insertDoc(db, {
      path: "notes/markers.md",
      type: "note",
      updated: "2026-06-20",
      content: "Fix the gate [TODO: repair hinge]. Date is [VERIFY: confirm 2019].",
    });

    const issues = audit(db, taxonomy, { now: NOW });
    const todo = categories(issues, "todo");
    const verify = categories(issues, "verify");
    expect(todo.length).toBe(1);
    expect(todo[0].severity).toBe("info");
    expect(verify.length).toBe(1);
    expect(verify[0].severity).toBe("warning");
    db.close();
  });
});

describe("audit type-mismatch", () => {
  test("flags a document whose path is outside its type's expected prefixes", () => {
    const db = freshDb();
    insertDoc(db, { path: "notes/misfiled.md", type: "study", updated: "2026-06-20" });
    // A correctly-placed study produces no finding.
    insertDoc(db, { path: "studies/astronomy.md", type: "study", updated: "2026-06-20" });

    const mismatch = categories(audit(db, taxonomy, { now: NOW }), "type-mismatch");
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]).toMatchObject({ path: "notes/misfiled.md", severity: "warning" });
    db.close();
  });
});

describe("audit orphan", () => {
  test("flags link-less documents but exempts orphan-exempt types", () => {
    const db = freshDb();
    const lonely = insertDoc(db, { path: "notes/lonely.md", type: "note", updated: "2026-06-20" });
    const hub = insertDoc(db, { path: "notes/hub.md", type: "note", updated: "2026-06-20" });
    insertDoc(db, { path: "journal/2026-06-15.md", type: "journal", updated: "2026-06-20" });

    // hub has an outgoing link (target need not resolve); lonely has none.
    db.run("INSERT INTO links (source_id, target, target_id) VALUES (?, ?, ?)", [hub, "somewhere", null]);
    void lonely;

    const orphans = categories(audit(db, taxonomy, { now: NOW }), "orphan");
    expect(orphans.map((o) => o.path)).toEqual(["notes/lonely.md"]);
    db.close();
  });

  test("an incoming link rescues a document, and a broken one rescues nobody", () => {
    const db = freshDb();
    const source = insertDoc(db, { path: "notes/source.md", type: "note", updated: "2026-06-20" });
    const target = insertDoc(db, { path: "notes/target.md", type: "note", updated: "2026-06-20" });
    insertDoc(db, { path: "notes/lonely.md", type: "note", updated: "2026-06-20" });

    // One resolved link and one broken one out of the same document. The
    // broken row carries target_id NULL, which must not count as an incoming
    // link for anything — the orphan scan reads target_id in bulk now, and a
    // NULL swept into that set would silently rescue whichever document the
    // set was keyed on.
    db.run("INSERT INTO links (source_id, target, target_id) VALUES (?, ?, ?)", [source, "target", target]);
    db.run("INSERT INTO links (source_id, target, target_id) VALUES (?, ?, ?)", [source, "nowhere", null]);

    const orphans = categories(audit(db, taxonomy, { now: NOW }), "orphan");
    expect(orphans.map((o) => o.path)).toEqual(["notes/lonely.md"]);
    db.close();
  });
});
