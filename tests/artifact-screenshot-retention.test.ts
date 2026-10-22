import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const helper = "packages/ui-react/tests/fixtures/artifact-recovery-capture.ts";

test("artifact recovery retains exact captures after later failure and fixture teardown", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-artifact-retention-"));
  try {
    const fixture = join(root, "scratch"), path = join(fixture, "artifact-dark-320.png");
    mkdirSync(fixture);
    const module = join(root, helper);
    mkdirSync(resolve(module, ".."), { recursive: true });
    // Run the unmodified helper in a disposable package tree, as in a unit
    // worker. The real-browser cases supply PNG proof; these bytes test handoff.
    writeFileSync(module, readFileSync(join(ROOT, helper)));
    const probe = join(root, "capture.ts");
    writeFileSync(probe, `
      import { readFileSync, rmSync, writeFileSync } from "node:fs";
      import { artifactRecoveryCapture } from ${JSON.stringify(module)};
      const path = ${JSON.stringify(path)}, paths = [];
      let count = 0;
      try {
        for (let i = 0; i < 2; i++) await artifactRecoveryCapture(path, async target => {
          paths.push(target);
          const bytes = Buffer.from("capture-" + (++count));
          writeFileSync(target, bytes);
          return bytes;
        });
        console.log(JSON.stringify({ paths, lastScratchBytes: readFileSync(path, "utf8") }));
        throw new Error("LATER_ARTIFACT_ASSERTION_FAILURE");
      } finally {
        rmSync(${JSON.stringify(fixture)}, { recursive: true });
      }
    `);
    const child = Bun.spawnSync([process.execPath, probe], {
      cwd: join(root, "packages/ui-react"), timeout: 10000,
    });
    expect(new TextDecoder().decode(child.stderr)).toContain("error: LATER_ARTIFACT_ASSERTION_FAILURE");
    expect(child.exitCode).toBe(1);
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ paths: [path, path], lastScratchBytes: "capture-2" });
    expect(existsSync(fixture)).toBe(false);
    const files = [...new Bun.Glob("packages/ui-react/.vitest-attachments/artifact-recovery/**/artifact-dark-320.png").scanSync({ cwd: root })];
    expect(files, "ARTIFACT_CAPTURES_SURVIVE_FIXTURE_TEARDOWN").toHaveLength(2);
    expect(files.map(file => readFileSync(join(root, file), "utf8")).sort()).toEqual(["capture-1", "capture-2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
