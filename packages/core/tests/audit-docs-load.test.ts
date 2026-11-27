/**
 * One hygiene, audit or briefing run loads the corpus once (#4786).
 *
 * `loadAuditDocs` selects every markdown row with its body. Each consumer used
 * to load it again: detection, the audit it runs, the diagrams check and the
 * reconcile's document map; the briefing loaded it, then the audit it counts
 * loaded it twice more. These tests count executions of that statement, count
 * registry reads of `_index.md`, and pin the diagrams check's disk reads.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { hygieneCommand } from "../src/cli/commands/hygiene";
import { generateBriefing } from "../src/cli/commands/briefing";
import { auditWithModules, findRepeatedText, REPEATED_TEXT_MIN_CHARS, REPEATED_TEXT_MIN_DOCS, type AuditDoc } from "../src/lib/auditor";
import { initContext, type BrainContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { detectCandidates } from "../src/lib/hygiene";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-12T12:00:00Z");
/** The statement `loadAuditDocs` runs, by its select list. */
const LOAD = /SELECT id, path, title, type, status, relevance, updated, next_review, content,/;

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Count executions of the corpus load on every connection while `body` runs. */
async function countLoads(body: () => Promise<unknown>): Promise<number> {
  let loads = 0;
  const proto = Database.prototype as unknown as Record<"prepare" | "query", (this: Database, sql: string, ...rest: unknown[]) => unknown>;
  const descriptors = {
    prepare: Object.getOwnPropertyDescriptor(proto, "prepare")!,
    query: Object.getOwnPropertyDescriptor(proto, "query")!,
  };
  for (const name of ["prepare", "query"] as const) {
    const real = descriptors[name].value as (this: Database, sql: string, ...rest: unknown[]) => { all: (...a: unknown[]) => unknown };
    Object.defineProperty(proto, name, {
      ...descriptors[name],
      value: function (this: Database, sql: string, ...rest: unknown[]) {
        const statement = real.call(this, sql, ...rest);
        if (!LOAD.test(sql)) return statement;
        const all = statement.all.bind(statement);
        statement.all = (...params: unknown[]) => {
          loads++;
          return all(...params);
        };
        return statement;
      },
    });
  }
  try {
    await body();
  } finally {
    Object.defineProperty(proto, "prepare", descriptors.prepare);
    Object.defineProperty(proto, "query", descriptors.query);
  }
  return loads;
}

describe("one corpus load per command", () => {
  let root: string;
  let brain: BrainContext;
  beforeAll(async () => {
    root = makeTempBrain();
    roots.push(root);
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    brain = await initContext({ root });
  });

  test("the diagrams module is not enabled, so the diagrams check runs", () => {
    expect(brain.modules.some((mod) => mod.state !== "dormant" && mod.manifest.name === "diagrams")).toBe(false);
  });

  test("detection followed by the reconcile's document map loads once", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    spies.push(log);
    const loads = await countLoads(() => hygieneCommand.run(["reconcile", "--dry-run"], { json: true, brain }));
    expect(log.mock.calls).toHaveLength(1);
    expect(loads).toBe(1);
  });

  test("auditWithModules on its own loads once", async () => {
    const db = openDatabase(brain.dbPath, { readonly: true });
    try {
      expect(await countLoads(() => auditWithModules(db, brain, { now: NOW }))).toBe(1);
    } finally {
      db.close();
    }
  });

  test("generateBriefing loads once", async () => {
    expect(await countLoads(() => generateBriefing(brain, 15, { now: NOW }))).toBe(1);
  });

  test("one detection reads each _index.md once for registry planning", async () => {
    const reads = new Map<string, number>();
    const real = fs.readFileSync;
    spies.push(
      spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
        if (typeof path === "string" && path.endsWith("_index.md") && /planRegistry/.test(new Error().stack ?? "")) {
          const key = resolve(path);
          reads.set(key, (reads.get(key) ?? 0) + 1);
        }
        return (real as (...a: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readFileSync)
    );
    const db = openDatabase(brain.dbPath, { readonly: true });
    try {
      await detectCandidates(db, brain, NOW);
    } finally {
      db.close();
    }
    expect(reads.size).toBeGreaterThan(0);
    expect([...reads].filter(([, n]) => n !== 1)).toEqual([]);
  });
});

describe("the diagrams check keeps reading the file", () => {
  const fenced = "```diagram\nflowchart: Ithaca -> Troy\n```";
  const note = (body: string) =>
    `---\ntitle: 'Voyage chart'\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n---\n\n${body}\n`;

  async function indexedBrain(body: string): Promise<BrainContext> {
    const root = makeTempBrain({ empty: true });
    roots.push(root);
    writeFileSync(join(root, "brain.config.json"), JSON.stringify({ taxonomy: {} }));
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/chart.md"), note(body));
    writeFileSync(join(root, "notes/other.md"), note("The wine-dark sea."));
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    return initContext({ root });
  }

  async function audited(brain: BrainContext): Promise<{ issues: { path: string; category: string }[]; failed: string[] }> {
    const failed: string[] = [];
    const db = openDatabase(brain.dbPath, { readonly: true });
    try {
      const issues = await auditWithModules(db, brain, { now: NOW, onCheckFailed: (check) => failed.push(check) });
      return { issues: issues.filter((i) => i.category.startsWith("diagram-")), failed };
    } finally {
      db.close();
    }
  }

  test("a fence added to the file after indexing is reported without a reindex", async () => {
    const brain = await indexedBrain("No chart yet.");
    appendFileSync(join(brain.root, "notes/chart.md"), `\n${fenced}\n`);
    const { issues } = await audited(brain);
    expect(issues.map((i) => [i.path, i.category])).toEqual([["notes/chart.md", "diagram-module"]]);
  });

  test("an unreadable file whose indexed body has a fence is diagram-source and a failed check", async () => {
    const brain = await indexedBrain(fenced);
    const file = join(brain.root, "notes/chart.md");
    rmSync(file);
    // A file that now leads outside the brain cannot be read: a read failure
    // other than a missing file.
    const outside = makeTempBrain({ empty: true });
    roots.push(outside);
    writeFileSync(join(outside, "elsewhere.md"), note("Nothing here."));
    symlinkSync(join(outside, "elsewhere.md"), file);
    const { issues, failed } = await audited(brain);
    expect(issues.map((i) => [i.path, i.category])).toEqual([["notes/chart.md", "diagram-source"]]);
    expect(failed).toContain("diagram-module");
  });
});

describe("repeated text", () => {
  const paragraph = (n: number) => `Odysseus tells the Phaeacians of voyage ${n}. `.repeat(Math.ceil(REPEATED_TEXT_MIN_CHARS / 40));
  const doc = (i: number, body: string): AuditDoc => ({
    id: i, path: `notes/n${String(i).padStart(2, "0")}.md`, title: `N${i}`, type: "note", status: "active", relevance: "secondary",
    updated: "2026-07-12", next_review: null, content: body, generated_from: null, verification: null,
  });

  test("a paragraph shared by exactly the minimum is found; one shared by one fewer is not", () => {
    const shared = paragraph(1), almost = paragraph(2);
    expect(shared.trim().length).toBeGreaterThanOrEqual(REPEATED_TEXT_MIN_CHARS);
    const docs = Array.from({ length: REPEATED_TEXT_MIN_DOCS }, (_, i) =>
      doc(i, `${shared}\n\n${i < REPEATED_TEXT_MIN_DOCS - 1 ? almost : "Ithaca at last."}\n`)
    );
    const found = findRepeatedText(docs);
    expect(found).toHaveLength(1);
    expect(found[0].paths).toEqual(docs.map((d) => d.path));
    expect(found[0].text).toBe(shared.trim().replace(/\s+/g, " "));
  });
});
