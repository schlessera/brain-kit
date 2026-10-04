import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = join(ROOT, "packages/core/tests/hygiene.test.ts");
const CASE = "a module finding on an excluded path is dropped, and a failing check is reported";
const FINAL_ASSERTION = 'expect(detection.candidates.filter((c) => c.category === "mood-drift").map((c) => c.path)).toEqual(["notes/a.md"]);';

for (const fail of [false, true]) {
  test(`hygiene module fixture cleans its owned root after ${fail ? "assertion failure" : "success"}`, () => {
    const owner = mkdtempSync(join(tmpdir(), "hygiene-cleanup-proof-"));
    try {
      const childTmp = join(owner, "child-tmp");
      mkdirSync(childTmp);
      // A concurrent fixture with the same prefix must survive file cleanup.
      const sentinel = "brain-hygiene-empty-unrelated";
      mkdirSync(join(childTmp, sentinel));
      writeFileSync(join(childTmp, sentinel, "keep.txt"), "unrelated fixture bytes");

      let file = SOURCE;
      if (fail) {
        const source = readFileSync(SOURCE, "utf8");
        expect(source.split(FINAL_ASSERTION)).toHaveLength(2);
        // Preserve the real module and all three behavior assertions. The
        // deliberate failure is last; only import locations change in this
        // disposable copy so the original dependencies and cleanup still run.
        const failing = source.replace(FINAL_ASSERTION,
          `${FINAL_ASSERTION}\n    expect("controlled hygiene cleanup failure").toBe("deliberate refusal");`)
          .replace(/from "(\.{1,2}\/[^"\n]+)"/g,
            (_match, path: string) => `from ${JSON.stringify(resolve(dirname(SOURCE), path))}`);
        file = join(owner, "controlled-hygiene.test.ts");
        writeFileSync(file, failing);
      }

      const child = Bun.spawnSync([
        process.execPath, "run", "test", file, "--test-name-pattern", CASE,
      ], { cwd: ROOT, env: { ...process.env, TMPDIR: childTmp }, timeout: 20000 });
      const output = new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
      if (fail) {
        expect(output).toContain("controlled hygiene cleanup failure");
        expect(output).toContain("error: expect(received).toBe(expected)");
        expect(output).toContain(`(fail) detection > ${CASE}`);
        expect(child.exitCode).toBe(1);
      } else {
        expect(output).toContain(`(pass) detection > ${CASE}`);
        expect(child.exitCode).toBe(0);
      }
      // Observe after the real test process exits, before owner cleanup.
      expect(readdirSync(childTmp).sort()).toEqual([sentinel]);
      expect(readFileSync(join(childTmp, sentinel, "keep.txt"), "utf8")).toBe("unrelated fixture bytes");
    } finally {
      rmSync(owner, { recursive: true, force: true });
    }
  });
}
