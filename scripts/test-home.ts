/** Test-owned host storage; production's HOME fallback remains untouched. */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export function installTestHome(parent = tmpdir()) {
  const descriptors = new Map(["HOME", "CLAUDE_CONFIG_DIR"].map(name => [name, Object.getOwnPropertyDescriptor(process.env, name)]));
  const root = mkdtempSync(join(parent, "brain-test-home-"));
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

/** A disposable invoking home lets the launcher guard every child filesystem API
 * without patching the functions that race/refusal tests must spy on themselves.
 * The preload creates a separate working home; this sentinel must stay untouched.
 */
export function createInvokingTestHome() {
  const root = mkdtempSync(join(tmpdir(), "brain-test-invoking-home-"));
  const home = join(root, "home"), config = join(home, ".claude");
  mkdirSync(config, { recursive: true });
  const resources = join(root, "resources");
  mkdirSync(resources);
  writeFileSync(join(config, "sentinel"), "Odysseus: invoking storage stays untouched.\n");
  const baseline = claudeHomeSnapshot(home);
  return {
    root, home, config, resources,
    assertUnchanged() {
      if (claudeHomeSnapshot(home) !== baseline)
        throw new Error("TEST_WROTE_INVOKING_CLAUDE_HOME: a test changed the invoking Claude storage");
    },
    dispose() {
      try {
        // The preload records its PID/start identity in this invocation-owned
        // tree. Its conventional ledger must outlive every repetition, but the
        // parent removes it after observing the complete child group drain.
        let identity: { pid: number; start: string } | undefined;
        try { identity = JSON.parse(readFileSync(join(resources, "admission.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (identity) rmSync(join(tmpdir(),
          `brain-host-admission-test-${process.getuid?.() ?? "user"}-${identity.pid}-${identity.start}`), { recursive: true, force: true });
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}
