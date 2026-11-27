/**
 * The in-process CLI runner (#4844): `runCliInProcess` runs the same
 * `runBrainCli` the bin calls, so a test can cover CLI behaviour without a
 * process per call. The parity table holds it to the spawned bin: the same
 * arguments against one fixture brain give the same stdout, stderr and exit
 * code. The process boundary itself (stdio completion, the exit a parent sees,
 * environment isolation) stays with the spawned runner.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import * as cliMain from "../src/cli/main";
import { setContext, type BrainContext } from "../src/lib/context";
import { packageVersion } from "../src/package-version";
import { cleanup, keylessEnv, makeTempBrain, runCli, type CliResult } from "./cli-harness";
import { runCliInProcess } from "./cli-in-process-runner";

const MAIN = join(import.meta.dir, "../src/cli/main.ts");

let root: string;

beforeAll(async () => {
  root = makeTempBrain();
  const indexed = await runCli(root, ["index", "--json"]);
  expect(indexed.code, indexed.stderr).toBe(0);
});

afterAll(() => cleanup(root));

/** The fields of one `brain list --json` entry. */
const LIST_FIELDS = ["path", "title", "type", "relevance", "status", "summary", "updated", "deadline", "generatedFrom", "tags", "score", "snippet"];

const ROWS: { name: string; args: string[]; expect: (result: CliResult) => void }[] = [
  {
    name: "--version",
    args: ["--version"],
    expect: (r) => expect(r).toEqual({ stdout: `${packageVersion()}\n`, stderr: "", code: 0 }),
  },
  {
    name: "a --json read command",
    args: ["list", "--limit", "2", "--json"],
    expect: (r) => {
      expect(r.code).toBe(0);
      const listed = JSON.parse(r.stdout) as Record<string, unknown>[];
      expect(listed).toHaveLength(2);
      expect(Object.keys(listed[0])).toEqual(LIST_FIELDS);
    },
  },
  {
    name: "a text-output command",
    args: ["list", "--limit", "2", "--human"],
    expect: (r) => {
      expect(r.code).toBe(0);
      expect(r.stdout.startsWith("2 document(s):\n")).toBe(true);
    },
  },
  {
    name: "a usage error",
    args: ["search", "harbour", "--limit", "abc"],
    expect: (r) => expect(r).toEqual({ stdout: "", stderr: '--limit must be a whole number of 1 or more, got "abc"\n', code: 1 }),
  },
  {
    name: "an unknown command",
    args: ["frobnicate"],
    expect: (r) =>
      expect(r).toEqual({ stdout: "", stderr: "Unknown command: frobnicate\nRun `brain --help` for usage information.\n", code: 1 }),
  },
  {
    name: "an internal failure",
    // `me` is a directory: reading it fails outside any usage check.
    args: ["read", "me"],
    expect: (r) => expect(r).toEqual({ stdout: "", stderr: "EISDIR: illegal operation on a directory, read\n", code: 2 }),
  },
];

describe("runCliInProcess matches the spawned bin", () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const spawned = await runCli(root, row.args);
      const inProcess = await runCliInProcess(root, row.args);
      // Each runner meets the row on its own, and the report names which did not.
      const missed: string[] = [];
      for (const [runner, result] of [["spawned", spawned], ["in-process", inProcess]] as const) {
        try {
          row.expect(result);
        } catch (e) {
          missed.push(`${runner}: ${(e as Error).message}`);
        }
      }
      expect(missed).toEqual([]);
      expect(inProcess).toEqual(spawned);
    }, 60_000);
  }
});

describe("runCliInProcess", () => {
  test("importing main.ts prints nothing, requests no exit and leaves the console alone", () => {
    // A child, so the module is evaluated fresh rather than taken from this process's cache.
    const probe = `
      const keys = ["log", "info", "debug", "warn", "error"];
      const calls = [];
      const spies = Object.fromEntries(keys.map((k) => [k, (...a) => calls.push([k, ...a.map(String)])]));
      for (const k of keys) console[k] = spies[k];
      const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
      process.stdout.write = (c) => (calls.push(["stdout", String(c)]), true);
      process.stderr.write = (c) => (calls.push(["stderr", String(c)]), true);
      const exits = [];
      process.exit = (c) => { exits.push(c ?? null); };
      const mod = await import(${JSON.stringify(MAIN)});
      const consoleKept = keys.every((k) => console[k] === spies[k]);
      process.stdout.write = writes.stdout;
      process.stderr.write = writes.stderr;
      require("fs").writeSync(1, JSON.stringify({ calls, exits, consoleKept, runBrainCli: typeof mod.runBrainCli }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", probe], { env: keylessEnv(root), stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ calls: [], exits: [], consoleKept: true, runBrainCli: "function" });
  });

  test("the bin holds no command dispatch", () => {
    const bin = readFileSync(join(import.meta.dir, "../src/cli/brain.ts"), "utf8");
    expect(bin).toContain("runBrainCli(process.argv.slice(2))");
    for (const dispatch of ["buildRegistry", "initContext", "registry.commands", "entry.run"]) expect(bin).not.toContain(dispatch);
  });

  test("a command that throws leaves the console, stdio and environment as they were", async () => {
    const names = ["log", "error", "warn", "info", "debug"] as const;
    const before = names.map((name) => Object.getOwnPropertyDescriptor(console, name));
    const writes = [process.stdout, process.stderr].map((stream) => Object.getOwnPropertyDescriptor(stream, "write"));
    const env = { ...process.env };
    const which = Bun.which;
    const result = await runCliInProcess(root, ["read", "me"], { BRAIN_IN_PROCESS_PROBE: "set" });
    expect(Bun.which).toBe(which);
    expect(result.code).toBe(2);
    expect(names.map((name) => Object.getOwnPropertyDescriptor(console, name))).toEqual(before);
    expect([process.stdout, process.stderr].map((stream) => Object.getOwnPropertyDescriptor(stream, "write"))).toEqual(writes);
    // Every key the harness set (the keyless set, the extra one) is back to its value from before.
    for (const key of [...Object.keys(keylessEnv(root)), "BRAIN_IN_PROCESS_PROBE", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect({ key, value: process.env[key] }).toEqual({ key, value: env[key] });
    }
  }, 60_000);

  test("a call that rejects after the harness replaced the console puts everything back (#4934)", async () => {
    const names = ["log", "error", "warn", "info", "debug"] as const;
    const before = names.map((name) => Object.getOwnPropertyDescriptor(console, name));
    const writes = [process.stdout, process.stderr].map((stream) => Object.getOwnPropertyDescriptor(stream, "write"));
    const env = { ...process.env };
    const which = Bun.which;
    // A brain context the call must clear for itself and hand back.
    const sentinel = { root: "/ithaca" } as BrainContext;
    const outer = setContext(sentinel);
    let replaced: boolean[] = [];
    let handedBack: BrainContext | null = null;
    const fault = spyOn(cliMain, "runBrainCli").mockImplementation(async () => {
      replaced = names.map((name, i) => Object.getOwnPropertyDescriptor(console, name)?.value !== before[i]?.value);
      console.log("Odysseus sets sail");
      process.stdout.write("from Ogygia\n");
      throw new Error("the raft broke apart");
    });
    try {
      await expect(runCliInProcess(root, ["--version"], { BRAIN_IN_PROCESS_PROBE: "set" })).rejects.toThrow("the raft broke apart");
    } finally {
      fault.mockRestore();
      handedBack = setContext(outer);
    }
    // The fault ran with every console method already replaced.
    expect(replaced).toEqual(names.map(() => true));
    expect(names.map((name) => Object.getOwnPropertyDescriptor(console, name))).toEqual(before);
    expect([process.stdout, process.stderr].map((stream) => Object.getOwnPropertyDescriptor(stream, "write"))).toEqual(writes);
    expect(Bun.which).toBe(which);
    for (const key of [...Object.keys(keylessEnv(root)), "BRAIN_IN_PROCESS_PROBE", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect({ key, value: process.env[key] }).toEqual({ key, value: env[key] });
    }
    expect(handedBack).toBe(sentinel);
    // The overlap guard was released: the next call runs.
    expect((await runCliInProcess(root, ["--version"])).code).toBe(0);
  }, 60_000);

  test("two overlapping calls fail clearly instead of interleaving output", async () => {
    const first = runCliInProcess(root, ["list", "--limit", "1", "--json"]);
    await expect(runCliInProcess(root, ["--version"])).rejects.toThrow(/is still running; await each call before the next/);
    expect((await first).code).toBe(0);
  }, 60_000);
});
