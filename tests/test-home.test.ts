import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHomeSnapshot, createInvokingTestHome, installTestHome } from "../scripts/test-home";

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

test("the invoking-home guard detects a same-size overwrite without adding paths", () => {
  const invoking = createInvokingTestHome();
  try {
    const sentinel = join(invoking.config, "sentinel");
    const bytes = readFileSync(sentinel);
    expect(bytes.toString()).toBe("Odysseus: invoking storage stays untouched.\n");
    invoking.assertUnchanged();
    writeFileSync(sentinel, Buffer.alloc(bytes.length, 120));
    expect(readFileSync(sentinel).length).toBe(bytes.length);
    expect(() => invoking.assertUnchanged()).toThrow("TEST_WROTE_INVOKING_CLAUDE_HOME");
  } finally { invoking.dispose(); }
  expect(existsSync(invoking.root)).toBe(false);
});

test("home isolation leaves filesystem originals and descriptors available to fixture spies", async () => {
  const fs = await import("node:fs");
  const descriptor = Object.getOwnPropertyDescriptor(fs, "mkdtempSync")!;
  const original = fs.mkdtempSync;
  const created: string[] = [];
  const observe = ((...args: Parameters<typeof original>) => {
    const path = Reflect.apply(original, fs, args);
    created.push(String(path));
    return path;
  }) as typeof original;
  const spy = spyOn(fs, "mkdtempSync").mockImplementation(observe);
  try {
    const path = fs.mkdtempSync(join(tmpdir(), "odysseus-home-spy-"));
    expect(existsSync(path)).toBe(true);
    expect(created).toEqual([path]);
  } finally {
    spy.mockRestore();
    Object.defineProperty(fs, "mkdtempSync", descriptor);
    for (const path of created) rmSync(path, { recursive: true, force: true });
  }
});
