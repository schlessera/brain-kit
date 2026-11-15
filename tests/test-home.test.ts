import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHomeSnapshot, installTestHome } from "../scripts/test-home";

for (const configPresent of [false, true]) {
  test(`test home restores environment descriptors with config ${configPresent ? "set" : "absent"} and snapshots detect host overwrites`, () => {
    const descriptors = new Map(["HOME", "CLAUDE_CONFIG_DIR"].map(name => [name, Object.getOwnPropertyDescriptor(process.env, name)]));
    const root = mkdtempSync(join(tmpdir(), "odysseus-test-home-"));
    const config = join(root, ".claude"); mkdirSync(config);
    const sentinel = join(config, "sentinel"); writeFileSync(sentinel, "Ithaca\n");
    process.env.HOME = root;
    if (configPresent) process.env.CLAUDE_CONFIG_DIR = config;
    else delete process.env.CLAUDE_CONFIG_DIR;
    const before = ["HOME", "CLAUDE_CONFIG_DIR"].map(name => Object.getOwnPropertyDescriptor(process.env, name));
    const isolated = installTestHome();
    try {
      expect(process.env.HOME).toBe(join(isolated.root, "home"));
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(isolated.root, "home/.claude"));
      const baseline = claudeHomeSnapshot(root);
      // Same path and byte count: a directory-count-only guard misses this.
      writeFileSync(sentinel, "Troy!!\n");
      expect(readFileSync(sentinel, "utf8")).toBe("Troy!!\n");
      expect(claudeHomeSnapshot(root)).not.toBe(baseline);
    } finally {
      isolated.dispose();
      try {
        expect(existsSync(isolated.root)).toBe(false);
        expect(["HOME", "CLAUDE_CONFIG_DIR"].map(name => Object.getOwnPropertyDescriptor(process.env, name))).toEqual(before);
      } finally {
        for (const [name, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(process.env, name, descriptor);
          else delete process.env[name];
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}
