/**
 * Published SkillEmitter contract suite — the executable form of the promises
 * in docs/extending/skill-emitters.md and on the interface in ../lib/seams.ts:
 *
 *   1. `agent` is a string
 *   2. `emit` returns `{ written, removed }` synchronously, as repo-relative
 *      paths; everything it reports written exists afterwards (a link
 *      resolves), everything it reports removed does not
 *   3. every skill it is given is reachable from the emitted layout: a
 *      written path names it, or a written file mentions it (a written
 *      directory counts through the paths and files inside it)
 *   4. a skill dropped from the list leaves the layout: no emitted path still
 *      names it and no emitted file still mentions it
 *   5. re-emitting an unchanged list removes nothing and leaves the layout in
 *      place
 *   6. the canonical home, `.agents/skills/`, is read, never written: no
 *      emitted path lies inside it and every SKILL.md there is unchanged
 *
 * The suite builds a scratch repository with two skills in the canonical home
 * and drives the emitter against it. No agent is run and nothing leaves the
 * scratch directory.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, normalize } from "node:path";

import type { SkillEmitter, SkillManifest } from "../lib/seams.js";
import type { ContractTestPrimitives } from "./primitives.js";

export interface SkillEmitterContractHarness {
  name: string;
  /** A fresh emitter; the suite calls it once per case. */
  emitter(): SkillEmitter;
}

const ALPHA = "contract-alpha-skill";
const BETA = "contract-beta-skill";

interface ScratchRepo {
  root: string;
  skills: SkillManifest[];
  skillFile(name: string): string;
}

/** A scratch repository holding ALPHA and BETA in `.agents/skills/`. */
function scratchRepo(): ScratchRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "brain-emitter-contract-")));
  const skillFile = (name: string) => join(root, ".agents", "skills", name, "SKILL.md");
  const skills = [ALPHA, BETA].map((name, i): SkillManifest => {
    const description = `Contract fixture number ${i + 1}, for the emitter suite.`;
    const dir = join(root, ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      skillFile(name),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow fixture procedure ${i + 1}.\n`
    );
    return { name, description, dir, source: "local", frontmatter: { name, description } };
  });
  return { root, skills, skillFile };
}

/** True when `rel` is a plain repo-relative path: not absolute, no `..`. */
function isRepoRelative(rel: string): boolean {
  if (typeof rel !== "string" || rel === "" || isAbsolute(rel)) return false;
  return !normalize(rel).split(/[\\/]/).includes("..");
}

/**
 * Does the emitted path `rel` name `skill`, or does the file there mention it?
 * A directory reaches it through anything inside it. A link to a directory
 * (the claude and pi layouts) names the skill itself, so it is never walked
 * into the canonical home it points at.
 */
function reaches(root: string, rel: string, skill: string): boolean {
  if (rel.split(/[\\/]/).some((segment) => basename(segment, extname(segment)) === skill)) {
    return true;
  }
  const abs = join(root, rel);
  if (!existsSync(abs)) return false;
  if (statSync(abs).isFile()) return readFileSync(abs, "utf8").includes(skill);
  if (lstatSync(abs).isSymbolicLink()) return false;
  return readdirSync(abs).some((entry) => reaches(root, join(rel, entry), skill));
}

function withRepo(fn: (repo: ScratchRepo) => void): void {
  const repo = scratchRepo();
  try {
    fn(repo);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}

/** Register the SkillEmitter contract suite for one emitter harness. */
export function runSkillEmitterContract(
  harness: SkillEmitterContractHarness,
  primitives: ContractTestPrimitives
): void {
  const { describe, expect, test } = primitives;

  describe(`SkillEmitter contract: ${harness.name}`, () => {
    test("agent is a string", () => {
      expect(typeof harness.emitter().agent).toBe("string");
    });

    test("emit reports repo-relative paths: written ones exist, removed ones do not", () => {
      withRepo(({ root, skills }) => {
        const result = harness.emitter().emit(skills, root);
        expect(Array.isArray(result?.written) && Array.isArray(result?.removed)).toBe(true);
        expect(result.written.length).toBeGreaterThan(0);

        const reported = [...result.written, ...result.removed];
        expect(reported.filter((rel) => !isRepoRelative(rel))).toEqual([]);
        expect(result.written.filter((rel) => !existsSync(join(root, rel)))).toEqual([]);
        expect(result.removed.filter((rel) => existsSync(join(root, rel)))).toEqual([]);
      });
    });

    test("every skill is reachable from the emitted layout", () => {
      withRepo(({ root, skills }) => {
        const { written } = harness.emitter().emit(skills, root);
        const unreached = skills
          .map((s) => s.name)
          .filter((name) => !written.some((rel) => reaches(root, rel, name)));
        expect(unreached).toEqual([]);
      });
    });

    test("a skill dropped from the list leaves the layout", () => {
      withRepo(({ root, skills }) => {
        const emitter = harness.emitter();
        const first = emitter.emit(skills, root);
        const second = emitter.emit(
          skills.filter((s) => s.name !== BETA),
          root
        );

        expect(second.removed.filter((rel) => existsSync(join(root, rel)))).toEqual([]);
        const emitted = [...new Set([...first.written, ...second.written])];
        const stale = emitted.filter(
          (rel) => existsSync(join(root, rel)) && reaches(root, rel, BETA)
        );
        expect(stale).toEqual([]);
        expect(emitted.some((rel) => existsSync(join(root, rel)) && reaches(root, rel, ALPHA))).toBe(
          true
        );
      });
    });

    test("re-emitting an unchanged list removes nothing and keeps the layout", () => {
      withRepo(({ root, skills }) => {
        const emitter = harness.emitter();
        const first = emitter.emit(skills, root);
        const second = emitter.emit(skills, root);

        expect(second.removed).toEqual([]);
        expect(first.written.filter((rel) => !existsSync(join(root, rel)))).toEqual([]);
      });
    });

    test("the canonical home is read, never written", () => {
      withRepo(({ root, skills, skillFile }) => {
        const before = skills.map((s) => readFileSync(skillFile(s.name), "utf8"));
        const { written, removed } = harness.emitter().emit(skills, root);

        const inHome = [...written, ...removed].filter((rel) =>
          normalize(rel).split(/[\\/]/).slice(0, 2).join("/").startsWith(".agents/skills")
        );
        expect(inHome).toEqual([]);
        expect(skills.map((s) => readFileSync(skillFile(s.name), "utf8"))).toEqual(before);
      });
    });
  });
}
