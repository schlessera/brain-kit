import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const workspaceDirs = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .filter(entry => !JSON.parse(readFileSync(join(ROOT, "packages", entry.name, "package.json"), "utf8")).private)
  .map(entry => entry.name);

function withCleanFixture(check: (root: string, preserved: Map<string, string>) => void): void {
  const root = mkdtempSync(join(tmpdir(), "brain-clean-"));
  try {
    mkdirSync(join(root, "scripts"));
    cpSync(join(ROOT, "scripts", "clean.ts"), join(root, "scripts", "clean.ts"));
    cpSync(join(ROOT, "scripts", "workspace-lease.mjs"), join(root, "scripts", "workspace-lease.mjs"));
    const preserved = new Map<string, string>();
    const keep = (relative: string) => {
      const content = `Keep ${relative}\n`;
      const file = join(root, relative);
      mkdirSync(resolve(file, ".."), { recursive: true });
      writeFileSync(file, content);
      preserved.set(relative, content);
    };
    for (const dir of workspaceDirs) {
      const dist = join(root, "packages", dir, "dist", "nested");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "built.js"), "Stale build\n");
      keep(`packages/${dir}/src/source.ts`);
      keep(`packages/${dir}/skills/example/SKILL.md`);
    }
    keep("dist/outside-workspaces.txt");
    keep("packages/unlisted/dist/keep.txt");
    keep("packages/core/distribution/keep.txt");
    // Recursively removing dist must remove a link inside it, not follow that
    // link into a directory outside the intended cleanup scope.
    symlinkSync(join(root, "dist"), join(root, "packages", "core", "dist", "outside-link"), "dir");
    check(root, preserved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runClean(root: string) {
  // Run from elsewhere: the actual script must locate its own repository,
  // rather than treating the caller's current directory as a deletion root.
  return Bun.spawnSync([process.execPath, join(root, "scripts", "clean.ts")], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("the actual clean script", () => {
  test("removes every publishable workspace's nonempty dist directory", () => {
    withCleanFixture(root => {
      expect(workspaceDirs.length).toBeGreaterThan(0);
      for (const dir of ["module-images", "render-template", "scrape", "ui-kit", "module-video"]) {
        expect(workspaceDirs).toContain(dir);
        expect(existsSync(join(root, "packages", dir, "dist", "nested", "built.js"))).toBe(true);
      }
      const result = runClean(root);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const remaining = workspaceDirs.filter(dir => existsSync(join(root, "packages", dir, "dist")));
      expect(remaining, "no published workspace may retain stale build output").toEqual([]);
      // A second invocation must also succeed after all intended output is gone.
      expect(runClean(root).exitCode).toBe(0);
    });
  });

  test("preserves source, skills and files outside the intended dist directories", () => {
    withCleanFixture((root, preserved) => {
      expect(preserved.size).toBeGreaterThan(3);
      const result = runClean(root);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      for (const [relative, content] of preserved) {
        expect(existsSync(join(root, relative)), `keeps ${relative}`).toBe(true);
        expect(readFileSync(join(root, relative), "utf8")).toBe(content);
      }
    });
  });
});
