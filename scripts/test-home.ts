/** Test-owned host storage; production's HOME fallback remains untouched. */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Metadata includes ctime/inode, so an equal-size overwrite is still a change. */
export function claudeHomeSnapshot(home: string): string {
  const entries: unknown[] = [];
  const visit = (path: string) => {
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entries.push([path, stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
    // Never follow a user's symlinks outside the guarded tree.
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(join(home, ".claude"));
  return JSON.stringify(entries);
}

export function installTestHome() {
  const descriptors = new Map(["HOME", "CLAUDE_CONFIG_DIR"].map(name => [name, Object.getOwnPropertyDescriptor(process.env, name)]));
  const root = mkdtempSync(join(tmpdir(), "brain-test-home-"));
  const home = join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
  // Override an inherited host config too, rather than preserving a real path.
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  return {
    root,
    dispose() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(process.env, name, descriptor);
        else delete process.env[name];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
