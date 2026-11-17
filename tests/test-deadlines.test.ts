// Test watchdogs scale under known load (#4191). The pure parts are tested
// directly; the last receipt runs real `bun test` with the scaling preload.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEADLINE_FACTOR_ENV, deadlineFactor, parseDeadlineFactor, scaledRegistrar, scaledTestModule, watchdogMs } from "../scripts/test-deadlines";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("the factor", () => {
  test("is one unless a loaded run set it, so a watchdog keeps its written duration", () => {
    expect(deadlineFactor({})).toBe(1);
    expect(deadlineFactor({ [DEADLINE_FACTOR_ENV]: "" })).toBe(1);
    expect(watchdogMs(27_000, {}), "UNLOADED_WATCHDOG_IS_UNCHANGED").toBe(27_000);
  });

  test("multiplies a watchdog under a loaded run", () => {
    expect(deadlineFactor({ [DEADLINE_FACTOR_ENV]: "8" })).toBe(8);
    expect(watchdogMs(27_000, { [DEADLINE_FACTOR_ENV]: "8" }), "WATCHDOG_SCALES_WITH_THE_RUN").toBe(216_000);
    expect(watchdogMs(0.5, { [DEADLINE_FACTOR_ENV]: "100" })).toBe(50);
  });

  test("a malformed factor is refused, never read as one", () => {
    for (const raw of ["0", "-2", "1.5", "8x", " 8", "0x8", "101", "1000", "NaN"]) {
      expect(() => deadlineFactor({ [DEADLINE_FACTOR_ENV]: raw }), raw).toThrow("whole number from 1 to 100");
      expect(() => watchdogMs(1000, { [DEADLINE_FACTOR_ENV]: raw }), raw).toThrow("whole number from 1 to 100");
    }
    for (const value of [0, 1.5, 101, NaN, Infinity, null, undefined, {}]) expect(() => parseDeadlineFactor(value), String(value)).toThrow("whole number from 1 to 100");
    expect([parseDeadlineFactor(1), parseDeadlineFactor("100"), parseDeadlineFactor(8)]).toEqual([1, 100, 8]);
  });

  test("a watchdog is a positive, finite duration", () => {
    for (const value of [0, -1, NaN, Infinity]) expect(() => watchdogMs(value, {}), String(value)).toThrow("positive, finite number of milliseconds");
  });
});

/** A stand-in registrar that records what reaches it, with the chained forms `bun:test` has. */
function registrar() {
  const calls: { via: string; self: unknown; args: unknown[] }[] = [];
  const base = function (this: unknown, ...args: unknown[]) { calls.push({ via: "test", self: this, args }); } as ((...args: unknown[]) => void) & Record<string, unknown>;
  base.only = function (this: unknown, ...args: unknown[]) { calls.push({ via: "only", self: this, args }); };
  base.each = function (this: unknown, ...table: unknown[]) {
    calls.push({ via: "each", self: this, args: table });
    return (...args: unknown[]) => { calls.push({ via: "each-row", self: undefined, args }); };
  };
  base.label = "the registrar";
  Object.defineProperty(base, "frozen", { value: () => "frozen", writable: false, configurable: false });
  return { base, calls };
}

describe("a scaled registrar", () => {
  const body = () => {}, FACTOR = 8;

  test("multiplies the number or the options timeout beside a test body, and nothing else", () => {
    const { base, calls } = registrar(), scaled = scaledRegistrar(base, FACTOR, 1);
    scaled("the bow is strung", body, 5000);
    scaled("the bow is strung", body, { timeout: 5000, retry: 2 });
    scaled("the bow is strung", { timeout: 5000 }, body);
    scaled("the bow is strung", body);
    scaled("twelve axes", body, { retry: 2 });
    expect(calls.map(call => call.args)).toEqual([
      ["the bow is strung", body, 40_000],
      ["the bow is strung", body, { timeout: 40_000, retry: 2 }],
      ["the bow is strung", { timeout: 40_000 }, body],
      ["the bow is strung", body],
      ["twelve axes", body, { retry: 2 }],
    ]);
  });

  test("leaves the caller's options object alone, and a timeout that is not finite", () => {
    const { base, calls } = registrar(), scaled = scaledRegistrar(base, FACTOR, 1);
    const options = { timeout: 250 };
    scaled("the suitors wait", body, options);
    scaled("the loom is unpicked", body, Infinity);
    expect(options, "CALLER_OPTIONS_NOT_MUTATED").toEqual({ timeout: 250 });
    expect(calls.map(call => call.args[2])).toEqual([{ timeout: 2000 }, Infinity]);
  });

  test("a hook's timeout follows its body in first position", () => {
    const { base, calls } = registrar(), scaled = scaledRegistrar(base, FACTOR, 0);
    scaled(body, 300);
    scaled(body, { timeout: 300 });
    scaled(body);
    expect(calls.map(call => call.args)).toEqual([[body, 2400], [body, { timeout: 2400 }], [body]]);
  });

  test("chained forms scale too: a property, and the registrar a table returns", () => {
    const { base, calls } = registrar(), scaled = scaledRegistrar(base, FACTOR, 1) as typeof base & { only: (...args: unknown[]) => void; each: (...table: unknown[]) => (...args: unknown[]) => void };
    scaled.only("the scar is recognised", body, 100);
    // The table is not a test: a number in it is data, not a timeout.
    scaled.each([1, 2], 7)("ship %d", body, 100);
    expect(calls.map(call => [call.via, call.args])).toEqual([
      ["only", ["the scar is recognised", body, 800]],
      ["each", [[1, 2], 7]],
      ["each-row", ["ship %d", body, 800]],
    ]);
  });

  test("a chained call reaches the registrar itself as its receiver, as Bun requires", () => {
    const { base, calls } = registrar(), scaled = scaledRegistrar(base, FACTOR, 1) as typeof base & { only: (...args: unknown[]) => void };
    scaled.only("the scar is recognised", body);
    expect(calls[0]!.self, "RECEIVER_IS_THE_REAL_REGISTRAR").toBe(base);
    expect(scaled.only).toBe(scaled.only);
  });

  test("other properties pass through unchanged, a frozen one included", () => {
    const { base } = registrar(), scaled = scaledRegistrar(base, FACTOR, 1) as typeof base & { frozen: () => string };
    expect(scaled.label).toBe("the registrar");
    expect(scaled.frozen()).toBe("frozen");
  });
});

describe("a scaled bun:test module", () => {
  test("scales tests, hooks and the file-wide default, and keeps everything else", () => {
    const seen: Record<string, unknown[][]> = {};
    const record = (name: string) => (...args: unknown[]) => { (seen[name] ??= []).push(args); };
    const expectStandIn = () => "expect";
    const real: Record<string, unknown> = { describe: record("describe"), expect: expectStandIn, default: {} };
    for (const name of ["test", "it", "beforeAll", "beforeEach", "afterAll", "afterEach", "setDefaultTimeout"]) real[name] = record(name);
    const scaled = scaledTestModule(real, 4) as Record<string, (...args: unknown[]) => void>;
    const body = () => {};
    scaled.test!("the raft holds", body, 100); scaled.it!("the raft holds", body, { timeout: 100 });
    for (const hook of ["beforeAll", "beforeEach", "afterAll", "afterEach"]) scaled[hook]!(body, 100);
    scaled.setDefaultTimeout!(100); scaled.describe!("the voyage", body, 100);
    expect(seen).toEqual({ test: [["the raft holds", body, 400]], it: [["the raft holds", body, { timeout: 400 }]],
      beforeAll: [[body, 400]], beforeEach: [[body, 400]], afterAll: [[body, 400]], afterEach: [[body, 400]],
      setDefaultTimeout: [[400]], describe: [["the voyage", body, 100]] });
    expect(scaled.expect as unknown, "EVERYTHING_ELSE_IS_THE_MODULE'S_OWN").toBe(expectStandIn);
    expect(scaled.default as unknown, "DEFAULT_EXPORT_IS_THE_SCALED_MODULE").toBe(scaled);
    expect(real.test, "THE_REAL_MODULE_IS_NOT_MUTATED").not.toBe(scaled.test);
    expect(() => scaledTestModule(real, 0)).toThrow("whole number from 1 to 100");
  });
});

// Timeouts of 100 ms around work of 300 ms: certain to trip unscaled, and far inside
// twenty times the timeout however loaded this host is.
const FLEET = `import { beforeAll, describe, expect, it, mock, test } from "bun:test";
const row = async () => { await Bun.sleep(300); };
test("a number beside the body", row, 100);
test("an options object", row, { timeout: 100 });
it("the it alias", row, 100);
test.each([1, 2])("a table row %d", async ship => { await row(); expect(ship).toBeGreaterThan(0); }, 100);
describe("in a group", () => {
  beforeAll(row, 100);
  test("after a slow hook", () => { mock.restore(); expect(1).toBe(1); });
  test("after a test restored its mocks", row, 100);
});
`;
// The runner's globals, with no import at all.
const GLOBALS = `test("a global registrar", async () => { await Bun.sleep(300); }, 100);\n`;

describe("the scaling preload, under real bun test", () => {
  function fleet() {
    const dir = mkdtempSync(join(tmpdir(), "odysseus-test-deadlines-")); scratch.push(dir);
    writeFileSync(join(dir, "fleet.test.ts"), FLEET); writeFileSync(join(dir, "globals.test.ts"), GLOBALS);
    // An earlier preload that already imported bun:test, as the offline preload has.
    writeFileSync(join(dir, "earlier.ts"), 'import { afterEach } from "bun:test";\nafterEach(() => {});\n');
    return dir;
  }
  async function run(dir: string, factor: string | undefined, ...flags: string[]) {
    const env: Record<string, string | undefined> = { ...process.env, [DEADLINE_FACTOR_ENV]: factor };
    for (const name of ["CLAUDECODE", "AGENT", "REPL_ID", "CI", "GITHUB_ACTIONS"]) delete env[name];
    const proc = Bun.spawn([process.execPath, "test", "--preload", "./earlier.ts", "--preload", join(ROOT, "scripts/test-deadline-preload.ts"),
      "--timeout", "30000", ...flags, "./fleet.test.ts", "./globals.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: (out + err).replace(/\x1b\[[0-9;]*m/g, "") };
  }

  test("every explicit timeout form is multiplied, in each file and each repetition", async () => {
    const result = await run(fleet(), "20", "--rerun-each=2");
    expect(result.output, "EXPLICIT_TIMEOUTS_SCALED").toContain(" 0 fail");
    expect(result.code, result.output).toBe(0);
    // Seven tests in the fleet and one global, twice.
    expect(result.output, "EVERY_FORM_RAN_TWICE").toContain(" 16 pass");
  }, 60_000);

  test.each([["unset", undefined], ["one", "1"]] as const)("with the factor %s the preload does nothing, and the same tests trip their timeouts", async (_name, factor) => {
    const result = await run(fleet(), factor);
    expect(result.code, result.output).toBe(1);
    for (const name of ["a number beside the body", "an options object", "the it alias", "a table row 1", "a table row 2", "a global registrar"])
      expect(result.output, "UNSCALED_TIMEOUT_TRIPS").toContain(`(fail) ${name} [`);
    expect(result.output).toContain("this test timed out after 100ms");
    // The group never gets past its slow hook.
    expect(result.output, "UNSCALED_HOOK_TIMEOUT_TRIPS").toContain("(fail) in a group >");
    expect(result.output).toContain("hook timed out");
  }, 60_000);

  test("a malformed factor stops the run instead of repeating it unscaled", async () => {
    const result = await run(fleet(), "eight");
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("The test deadline factor is a whole number from 1 to 100");
    expect(result.output).not.toContain(" 0 fail");
  }, 60_000);
});
