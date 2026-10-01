import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { openDatabase } from "../src/lib/db";
import type { ValidationIssue } from "../src/lib/validate";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

interface ValidationResult {
  issues: ValidationIssue[];
  errors: number;
  warnings: number;
}

describe("Gemini instructions stay outside brain content", () => {
  for (const customExclusions of [false, true]) {
    test(`${customExclusions ? "user file exclusions" : "default exclusions"}: real sync, index and validation keep the contract out`, async () => {
      const root = makeTempBrain({ empty: true });
      try {
        const saveConfig = (emitters: string[]) => writeFileSync(join(root, "brain.config.json"), JSON.stringify({
          skills: { emitters },
          taxonomy: { canonical: { identity: "", currentFocus: "" } },
          ...(customExclusions ? { exclude: { files: ["notes/omitted.md"] } } : {}),
        }));
        saveConfig([]);
        mkdirSync(join(root, "notes"));
        const note = "---\ntitle: Odysseus prepares for the Sirens\ntype: note\ntags: [voyage]\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n\nWax plugs protect the crew on the voyage.\n";
        expect(note.trim().length).toBeGreaterThan(0);
        writeFileSync(join(root, "notes/sirens.md"), note);
        // Exact root-relative exclusions must not hide a same-named content note.
        writeFileSync(join(root, "notes/GEMINI.md"), note.replace("Wax plugs", "A mast rope"));
        if (customExclusions) writeFileSync(join(root, "notes/omitted.md"), "Deliberately excluded, without frontmatter.\n");

        const before = await runCli(root, ["validate", "--json"]);
        expect(before.code).toBe(0);
        expect((JSON.parse(before.stdout) as ValidationResult).errors).toBe(0);
        saveConfig(["gemini"]);
        const sync = await runCli(root, ["skills", "sync", "--json"]);
        expect(sync.code).toBe(0);
        const emitted = JSON.parse(sync.stdout) as { emitters: { agent: string; written: string[] }[]; warnings: string[] };
        expect(emitted.warnings).toEqual([]);
        expect(emitted.emitters.find(e => e.agent === "gemini")?.written).toContain("GEMINI.md");
        const contract = readFileSync(join(import.meta.dir, "../CONTRACT.md"), "utf8").trim();
        expect(contract.length).toBeGreaterThan(0);
        expect(readFileSync(join(root, "GEMINI.md"), "utf8")).toContain(contract);
        expect((await runCli(root, ["index", "--json"])).code).toBe(0);

        const after = await runCli(root, ["validate", "--json"]);
        const validation = JSON.parse(after.stdout) as ValidationResult;
        expect(validation.issues.filter(i => i.file === "GEMINI.md")).toEqual([]);
        expect(after.code).toBe(0);
        expect(validation.errors).toBe(0);
        expect(validation.issues).toEqual([]);
        expect(validation.warnings).toBe(0);
        const db = openDatabase(join(root, "brain.db"));
        try {
          const paths = (db.query("SELECT path FROM documents ORDER BY path").all() as { path: string }[]).map(row => row.path);
          expect(paths).toEqual(["notes/GEMINI.md", "notes/sirens.md"]);
        } finally {
          db.close();
        }
        const search = await runCli(root, ["search", "wax plugs", "--mode", "fts", "--json"]);
        expect(search.code).toBe(0);
        const results = (JSON.parse(search.stdout) as { results: { path: string }[] }).results;
        expect(results.length).toBeGreaterThan(0);
        expect(results.map(r => r.path)).toContain("notes/sirens.md");

        writeFileSync(join(root, "notes/invalid.md"), "An ordinary note still needs frontmatter.\n");
        const invalid = await runCli(root, ["validate", "--json"]);
        expect(invalid.code).toBe(1);
        expect((JSON.parse(invalid.stdout) as ValidationResult).issues).toContainEqual({
          file: "notes/invalid.md", level: "error", message: "Missing YAML frontmatter",
        });
      } finally {
        cleanup(root);
      }
    });
  }
});
