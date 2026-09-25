import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { audit } from "../src/lib/auditor";
import { openDatabase } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { brainConfigSchema } from "../src/lib/config";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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

describe("audit fact-drift (#392)", () => {
  const factTaxonomy = buildTaxonomy({
    user: brainConfigSchema.parse({
      taxonomy: {
        facts: {
          ranger_since: { source: "me/basics/FACTS.md", patterns: ["ranger since (\\d{4})"] },
          trail_seasons: { source: "me/basics/FACTS.md", patterns: ["(\\w+) seasons on the trail crew"] },
          loop_miles: { source: "me/basics/FACTS.md", patterns: ["loop of (\\d+(?:\\.\\d+)?) miles"] },
        },
      },
    }),
  });

  /** Documents on disk (frontmatter + body) and in the index (body only), as the indexer leaves them. */
  function brain(docs: Array<{ path: string; frontmatter?: string; body: string; status?: string }>): { root: string; db: Database } {
    const root = mkdtempSync(join(tmpdir(), "brain-fact-drift-"));
    roots.push(root);
    const db = freshDb();
    for (const doc of docs) {
      mkdirSync(dirname(join(root, doc.path)), { recursive: true });
      writeFileSync(join(root, doc.path), `---\ntype: identity\ntitle: T\n${doc.frontmatter ?? ""}---\n${doc.body}`);
      insertDoc(db, { path: doc.path, type: "identity", updated: "2026-06-01", content: doc.body, status: doc.status });
    }
    return { root, db };
  }
  const SOURCE = {
    path: "me/basics/FACTS.md",
    frontmatter: "facts: { ranger_since: 2019, trail_seasons: four, loop_miles: 12.5 }\n",
    // The source states another value in its own prose; it is never reported.
    body: "Once a ranger since 2017 in the old notes.\n",
  };

  test("a drifted restatement is one issue; a matching one, the source and an archived piece are none", () => {
    const { root, db } = brain([
      SOURCE,
      { path: "me/basics/long-bio.md", body: "Alex has been a ranger since 2018, after four seasons on the trail crew.\n" },
      { path: "me/basics/short-bio.md", body: "A ranger since 2019.\n" },
      { path: "me/basics/old-bio.md", body: "A ranger since 2016.\n", status: "archived" },
    ]);
    const drift = categories(audit(db, factTaxonomy, { now: NOW, root }), "fact-drift");
    expect(drift.map((i) => i.path)).toEqual(["me/basics/long-bio.md"]);
    expect(drift[0]).toMatchObject({
      severity: "warning",
      message: "ranger_since: found 2018, canonical 2019",
    });
    expect(drift[0].suggestion).toContain("me/basics/FACTS.md");
    db.close();
  });

  test("facts_ignore suppresses exactly that key on exactly that document", () => {
    const drifted = "A ranger since 2018, after three seasons on the trail crew.\n";
    const { root, db } = brain([
      SOURCE,
      { path: "journal/2020-retrospective.md", frontmatter: "facts_ignore: [ranger_since]\n", body: drifted },
      { path: "me/basics/long-bio.md", body: drifted },
    ]);
    const drift = categories(audit(db, factTaxonomy, { now: NOW, root }), "fact-drift");
    expect(drift.map((i) => `${i.path} ${i.message}`).sort()).toEqual([
      "journal/2020-retrospective.md trail_seasons: found three, canonical four",
      "me/basics/long-bio.md ranger_since: found 2018, canonical 2019",
      "me/basics/long-bio.md trail_seasons: found three, canonical four",
    ]);
    db.close();
  });

  test("numbers compare as numbers, and a value inside code is not a restatement", () => {
    const { root, db } = brain([
      SOURCE,
      {
        path: "me/basics/short-bio.md",
        body: "A ranger since 2019, who walks a loop of 12.50 miles — see `ranger since 2010` in the example.\n\n```\nranger since 2011\n```\n",
      },
    ]);
    expect(categories(audit(db, factTaxonomy, { now: NOW, root }), "fact-drift")).toEqual([]);
    db.close();
  });

  test("a pattern without exactly one capture group fails config load, naming the key", () => {
    for (const patterns of [["ranger since \\d{4}"], ["(ranger) since (\\d{4})"]]) {
      const parsed = brainConfigSchema.safeParse({
        taxonomy: { facts: { ranger_since: { source: "me/basics/FACTS.md", patterns } } },
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues.map((i) => i.message).join("\n")).toContain('fact "ranger_since"');
    }
    expect(
      brainConfigSchema.safeParse({
        taxonomy: { facts: { ranger_since: { source: "me/basics/FACTS.md", patterns: ["ranger since (?:about )?(\\d{4})"] } } },
      }).success
    ).toBe(true);
  });
});
