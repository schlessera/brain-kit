// React's act flag is put back as it was found (#4999,
// docs/process/test-authoring.md D5), in three ways:
//
// - The shared save and restore, across lifetimes that start from different
//   descriptors, in a child process whose slot no other file has touched.
// - Every happy-dom helper, once per starting state, each state in its own
//   child process: a helper's module body registers only on its first import
//   in a process, so the child imports every helper once, in turn, and checks
//   after each unregister that the descriptor is the one the child started with.
// - Every test file that runs its DOM in a child process, and one render test
//   file, run whole in a child that checks the flag after their last teardown
//   hook. Testing Library writes the flag back in an `afterAll` of its own, and
//   Bun runs `afterAll` hooks in registration order, so a restore registered
//   before Testing Library's import is undone by it.
import { afterAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { enterActEnvironment, restoreActEnvironment } from "./act-environment.js";

const CHILD_MARKER = "BRAIN_UI_REACT_ACT_ENVIRONMENT_CHILD";
const LIFECYCLE_TARGET = "BRAIN_UI_REACT_ACT_ENVIRONMENT_TARGET";
const KEY = "IS_REACT_ACT_ENVIRONMENT";
const STATES: Record<string, PropertyDescriptor | undefined> = {
  absent: undefined,
  false: { configurable: true, enumerable: true, writable: true, value: false },
  "non-writable": { configurable: true, enumerable: false, writable: false, value: false },
};
const helpers = ["dom.ts", ...readdirSync(new URL("./render/", import.meta.url)).filter((name) => name.endsWith("-dom.ts")).sort()];
/** Each file's own child marker and environment, as its parent test spawns it. */
const lifecycles: { file: string; env: Record<string, string> }[] = [
  { file: "./destination-press.test.tsx", env: { BRAIN_UI_REACT_DESTINATION_PRESS_CHILD: "1" } },
  { file: "./expired-scratch-links.test.tsx", env: { BRAIN_UI_REACT_EXPIRED_SCRATCH_CHILD: "1" } },
  { file: "./file-viewer-binary-fallback.test.tsx", env: { BRAIN_UI_REACT_BINARY_FALLBACK_CHILD: "1" } },
  { file: "./notification-zone.test.tsx", env: { BRAIN_UI_REACT_NOTIFICATION_ZONE_CHILD: "1", TZ: "Europe/Athens" } },
  { file: "./pdf-preview.test.tsx", env: { BRAIN_UI_REACT_PDF_PREVIEW_CHILD: "1" } },
  { file: "./registration-on-mount.test.tsx", env: { BRAIN_UI_REACT_REGISTRATION_TEST_CHILD: "behavior" } },
  { file: "./registration-on-mount.test.tsx", env: { BRAIN_UI_REACT_REGISTRATION_TEST_CHILD: "counts" } },
  { file: "./shell-stores.test.tsx", env: { BRAIN_UI_REACT_SHELL_STORES_CHILD: "1" } },
  { file: "./soft-keyboard.test.tsx", env: { BRAIN_UI_REACT_SOFT_KEYBOARD_CHILD: "1" } },
  { file: "./render/turn-journal-google.test.tsx", env: {} },
];

function setFlag(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, KEY, descriptor);
  else Reflect.deleteProperty(globalThis, KEY);
}

async function child(env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(["bun", "test", import.meta.path, "--timeout", "30000"], {
    cwd: import.meta.dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Act flag child ${JSON.stringify(env)} failed (${exitCode})\n${stdout}${stderr}`);
  return `${stdout}${stderr}`;
}

const mode = process.env[CHILD_MARKER];
if (mode === undefined) {
  test("each lifetime of the shared save restores its own original", async () => {
    expect(await child({ [CHILD_MARKER]: "lifetimes" })).toMatch(/\b1 pass\b/);
  });

  for (const name of Object.keys(STATES)) {
    test(`every DOM helper restores the act flag it found ${name}`, async () => {
      // A child that registered no tests also exits 0.
      expect(await child({ [CHILD_MARKER]: name })).toMatch(new RegExp(`\\b${helpers.length} pass\\b`));
    });
  }

  for (const { file, env } of lifecycles) {
    test(`${file} ${JSON.stringify(env)} leaves the act flag as it found it after its last teardown`, async () => {
      const output = await child({ [CHILD_MARKER]: "lifecycle", [LIFECYCLE_TARGET]: file, ...env });
      expect(output).toMatch(/\b[1-9]\d* pass\b/);
      expect(output).toMatch(/\b0 fail\b/);
      expect(output).toContain(`ACT_FLAG_AFTER_TEARDOWN ${file}`);
    });
  }
} else if (mode === "lifetimes") {
  test("each lifetime of the shared save restores its own original", () => {
    for (const start of [STATES.false, STATES["non-writable"], STATES.absent, { configurable: true, enumerable: true, writable: true, value: true }]) {
      setFlag(start);
      enterActEnvironment();
      enterActEnvironment();
      expect(Object.getOwnPropertyDescriptor(globalThis, KEY)).toEqual({ configurable: true, enumerable: true, writable: true, value: true });
      restoreActEnvironment();
      expect(Object.getOwnPropertyDescriptor(globalThis, KEY)).toEqual(start);
      restoreActEnvironment();
      expect(Object.getOwnPropertyDescriptor(globalThis, KEY), "a second restore changes nothing").toEqual(start);
    }
  });
} else if (mode === "lifecycle") {
  const file = process.env[LIFECYCLE_TARGET]!;
  const start = STATES.false;
  setFlag(start);
  await import(file);
  // Registered after every hook the file and Testing Library registered, so it runs last.
  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(globalThis, KEY), `${file} left the act flag as it found it`).toEqual(start);
    console.log(`ACT_FLAG_AFTER_TEARDOWN ${file}`);
  });
} else {
  if (!(mode in STATES)) throw new Error(`Unknown act flag state "${mode}"`);
  const start = STATES[mode];
  setFlag(start);

  for (const name of helpers) {
    test(`${name} puts back the act flag it found ${mode}`, async () => {
      const helper = (await import(`./render/${name}`)) as Record<string, unknown>;
      const named = (pattern: RegExp) => Object.entries(helper).filter(([key, value]) => pattern.test(key) && typeof value === "function").map(([, value]) => value as () => unknown);
      const unregister = named(/^unregister\w*Dom$/);
      expect(unregister, `${name} exports one unregister`).toHaveLength(1);
      // The module body registered; without this the restore would pass vacuously.
      expect((globalThis as Record<string, unknown>)[KEY], `${name} turned the flag on`).toBe(true);
      // A test file registers again after its helper's module body did, and must
      // not have the body's `true` taken for the original.
      for (const register of named(/^register\w*Dom$/)) register();
      expect((globalThis as Record<string, unknown>)[KEY], `${name} keeps the flag on`).toBe(true);
      await unregister[0]!();
      expect(Object.getOwnPropertyDescriptor(globalThis, KEY), `${name} restored the flag`).toEqual(start);
    });
  }
}
