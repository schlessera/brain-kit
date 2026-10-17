import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../scripts/upstream-report.ts");
const REFERENCES = "skills/diagram-design/references/";

test("a local two-commit clone produces the pinned grouped report without running clone code", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-upstream-"));
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", "-C", root, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid",
        GIT_AUTHOR_DATE: "2026-07-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T00:00:00Z" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    return child.stdout.toString().trim();
  };
  const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  try {
    git("init");
    put("scripts/verify-geometry.py", "raise RuntimeError('upstream checker executed')\n");
    put("skills/diagram-design/scripts/self_check.py", "# baseline\n");
    put(REFERENCES + "type-old.md", "Old grammar\n");
    put("CHANGELOG.md", "# Changes\n\n## 1.0\nOld entry\n");
    git("add", "."); git("commit", "-m", "Odysseus baseline");
    const from = git("rev-parse", "HEAD");
    put(REFERENCES + "type-relay.md", "Relay grammar\n");
    rmSync(join(root, REFERENCES + "type-old.md"));
    put("scripts/verify-geometry.py", "raise RuntimeError('changed checker executed')\n");
    put("skills/diagram-design/scripts/self_check.py", "raise RuntimeError('nested checker executed')\n");
    put("scripts/unrelated.py", "raise RuntimeError('unrelated tooling executed')\n");
    put("CHANGELOG.md", "# Changes\n\n## 1.1\nRelay rule\n\n## 1.0\nOld entry\n");
    git("add", "."); git("commit", "-m", "Odysseus update");
    const to = git("rev-parse", "HEAD");
    // A configured external diff is executable code in the untrusted clone.
    const marker = join(root, "executed");
    put("diff-driver.sh", `#!/bin/sh\nprintf ran > ${marker}\n`);
    chmodSync(join(root, "diff-driver.sh"), 0o700);
    git("config", "diff.external", join(root, "diff-driver.sh"));
    // Working-tree-only grammar must not leak into a committed-state report.
    put(REFERENCES + "type-uncommitted.md", "Not committed\n");
    const run = (json: boolean) => Bun.spawnSync([process.execPath, SCRIPT, root, "--since", from, ...(json ? ["--json"] : [])], { stdout: "pipe", stderr: "pipe" });
    const result = run(true);
    expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
    expect(existsSync(marker), "UPSTREAM_CODE_NEVER_EXECUTED").toBe(false);
    expect(JSON.parse(result.stdout.toString()), "UPSTREAM_GROUPED_REPORT").toEqual({
      schema_version: 1, from, to,
      groups: {
        typeGrammars: [{ path: REFERENCES + "type-old.md", status: "removed" }, { path: REFERENCES + "type-relay.md", status: "added" }],
        semanticPatterns: [], primitivesAndRules: [],
        checkers: [{ path: "scripts/verify-geometry.py", status: "changed" }, { path: "skills/diagram-design/scripts/self_check.py", status: "changed" }], otherReferences: [],
      }, changelog: ["## 1.1", "Relay rule"],
    });
    const human = run(false);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.toString()).toBe(`${from} → ${to}\n\ntypeGrammars\nremoved ${REFERENCES}type-old.md\nadded ${REFERENCES}type-relay.md\n\nsemanticPatterns\n\nprimitivesAndRules\n\ncheckers\nchanged scripts/verify-geometry.py\nchanged skills/diagram-design/scripts/self_check.py\n\notherReferences\n\nCHANGELOG additions\n## 1.1\nRelay rule\n`);
    expect(existsSync(marker), "UPSTREAM_CODE_NEVER_EXECUTED").toBe(false);
    // Missing promisor objects must refuse rather than start a remote helper.
    git("config", "remote.origin.promisor", "true");
    git("config", "remote.origin.url", `ext::${join(root, "diff-driver.sh")}`);
    git("config", "protocol.ext.allow", "always");
    const blob = git("rev-parse", `${from}:CHANGELOG.md`);
    rmSync(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    const missing = run(true);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("fetch required history/objects separately");
    expect(existsSync(marker), "UPSTREAM_REMOTE_HELPER_NEVER_EXECUTED").toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("report refuses non-repositories and option-shaped commit input", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-not-clone-"));
  try {
    for (const commit of ["abcdef0", "--help"]) {
      const result = Bun.spawnSync([process.execPath, SCRIPT, root, "--since", commit, "--json"], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(1); expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toMatch(/repository|commit hash/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
