import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const command = join(ROOT, "packages/ui-react/tests/browser/hygiene-server-command.ts");

test("hygiene command retains each capture after container scratch cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-hygiene-retention-"));
  try {
    const cwd = join(root, "packages/ui-kit"), scratch = join(root, "scratch");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(scratch);
    const probe = join(root, "capture.ts");
    // Exercise the actual command and filesystem handoff. This controlled
    // screenshot writer isolates retention; pinned browser proof supplies PNGs.
    writeFileSync(probe, `
      import { writeFileSync } from "node:fs";
      import { hygieneServer } from ${JSON.stringify(command)};
      let capture = 0;
      const ctx = { frame: async () => ({ locator: () => ({
        screenshot: async ({ path }) => {
          const bytes = Buffer.from("capture-" + (++capture));
          writeFileSync(path, bytes);
          return bytes;
        }
      }) }) };
      const paths = [];
      for (let i = 0; i < 2; i++) paths.push(await hygieneServer(ctx, {
        op: "capture", name: "c5-dark-320-failure.png", selector: "#scene"
      }));
      console.log(JSON.stringify(paths));
    `);
    const child = Bun.spawnSync([process.execPath, probe], {
      cwd, env: { ...process.env, TMPDIR: scratch }, timeout: 10000,
    });
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(child.exitCode).toBe(0);
    // The existing local review path and its return value remain available.
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual([
      join(scratch, "c5-dark-320-failure.png"), join(scratch, "c5-dark-320-failure.png"),
    ]);
    expect(readFileSync(join(scratch, "c5-dark-320-failure.png"), "utf8")).toBe("capture-2");
    rmSync(scratch, { recursive: true });
    const files = [...new Bun.Glob("tmp/hygiene-proof/**/c5-dark-320-failure.png").scanSync({ cwd: root })];
    expect(files).toHaveLength(2);
    expect(files.map(file => readFileSync(join(root, file), "utf8")).sort()).toEqual(["capture-1", "capture-2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
