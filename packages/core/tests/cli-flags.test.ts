/**
 * Per-command flag declarations (#4834). `parseArgs` validates every core
 * command against one global vocabulary, so nothing at run time says which
 * flags a command reads. Each `CoreCommand` declares them instead, and this
 * file holds the declarations to five things:
 *
 * - the vocabulary: every declared flag is one `parseArgs` knows, as the kind
 *   it knows it as, and only the flags named in `UNREAD` are known to no
 *   command;
 * - the source: every flag a command's file reads is declared (the read check);
 * - the help block: every flag a command's help names is declared;
 * - the documentation: every `brain <core command> …` invocation in the
 *   template, the skills and `docs/` passes only flags its command declares;
 * - the hosts: every flag first-party code outside core passes a core command
 *   is declared.
 *
 * The read check is a source scan, not a type. It sees a flag that a command's
 * own file reads through `flags.name`, `flags["name"]`, a helper called with
 * the flags or the raw arguments and a literal name (`stringFlag(flags, "x")`,
 * `repeatedFlag(args, "x")`), a literal `"--name"` compared or searched for,
 * and the bin's reads in `main.ts` and `read-only.ts`: a `MUTATING_WITH_FLAGS`
 * row, a read-only.ts line that names one command, and a read on a line that
 * starts `if (mutates`, which the bin makes for every writing command (the
 * `--dry-run` that skips the read-only-mount refusal). It cannot see a read in
 * another module that receives the whole flags object or the argument list, a
 * name built at run time, a read-only.ts line that names two commands, any
 * other bin read outside those three shapes, or a read through a per-verb
 * table (`geo`, `schedule`, `queue` and `compute`, whose tables are compared
 * with their declarations instead).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { GLOBAL_FLAGS } from "../src/cli/command-flags";
import { CORE_COMMANDS } from "../src/cli/commands/index";
import { BOOLEAN_FLAGS as COMPUTE_BOOLEAN, VALUE_FLAGS as COMPUTE_VALUE } from "../src/cli/commands/compute";
import { OPTIONS as GEO_OPTIONS } from "../src/cli/commands/geo";
import { ALLOWED as QUEUE_ALLOWED } from "../src/cli/commands/queue";
import { ALLOWED as SCHEDULE_ALLOWED } from "../src/cli/commands/schedule";
import { BOOLEAN_FLAGS, VALUE_FLAGS } from "../src/cli/io";
import type { CoreCommand } from "../src/cli/types";

// A command object without a declaration does not type-check.
// @ts-expect-error `flags` is required on CoreCommand
const undeclared: CoreCommand = { summary: "x", run: async () => {} };
void undeclared;

const REPO = join(import.meta.dir, "../../..");
const CLI = join(import.meta.dir, "../src/cli");
const GLOBAL = new Set([...GLOBAL_FLAGS.boolean, ...GLOBAL_FLAGS.value]);

/**
 * Flags in the global vocabulary that no command reads. Each was searched for
 * under `packages/core/src` as `flags.<name>`, `flags["<name>"]` and
 * `"--<name>"`. `quiet` is passed by core's own git hooks
 * (`brain index --incremental --quiet`) and read by nothing. Removing them, or
 * refusing them, waits for the ruling in #4832.
 */
const UNREAD = ["name", "path", "quiet"];

/** The command word → the file under `cli/commands` its loader imports. */
const COMMAND_FILES: Record<string, string> = Object.fromEntries(
  [...readFileSync(join(CLI, "commands/index.ts"), "utf8").matchAll(/^ {2}(?:"([a-z-]+)"|([a-z-]+)): \{[\s\S]*?import\("\.\/([\w-]+)\.js"\)/gm)]
    .map((m) => [m[1] ?? m[2]!, `${m[3]}.ts`]),
);

const COMMANDS: Record<string, CoreCommand> = Object.fromEntries(
  await Promise.all(Object.entries(CORE_COMMANDS).map(async ([word, entry]) => [word, await entry.load()] as const)),
);

const declared = (word: string) => new Set([...COMMANDS[word]!.flags.boolean, ...COMMANDS[word]!.flags.value]);
const accepted = (word: string, flag: string) => GLOBAL.has(flag) || declared(word).has(flag);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

const READ_PATTERNS = [
  /(?<![\w./-])flags\??\.([a-z][a-z0-9]*)\b(?!\s*\()/g,
  /(?<![\w./-])flags\??\[\s*["'`]([a-z][a-z0-9-]*)["'`]\s*\]/g,
  /\b\w+\(\s*(?:flags|argv|args|rest|p)\s*,\s*["']([a-z][a-z0-9-]*)["']/g,
  /\b(?:values|booleans)\.(?:get|has)\(\s*["']([a-z][a-z0-9-]*)["']\s*\)/g,
  /(?:includes|indexOf|startsWith)\(\s*["']--([a-z][a-z0-9-]*)=?["']\s*\)/g,
  /[!=]==\s*["']--([a-z][a-z0-9-]*)["']/g,
];

/** The flags a source text reads, by the patterns the file header lists. */
function readsIn(source: string): Set<string> {
  const reads = new Set<string>();
  for (const pattern of READ_PATTERNS) for (const m of source.matchAll(pattern)) reads.add(m[1]!);
  return reads;
}

/** The CLI entry the bin runs (`runBrainCli`), which reads flags for writing commands before dispatch. */
const BRAIN_SOURCE = readFileSync(join(CLI, "main.ts"), "utf8");

/** The commands the bin treats as writing: `MUTATING_COMMANDS`, the `MUTATING_WITH_FLAGS` rows and `hygiene`'s repair forms. */
const WRITING_COMMANDS = new Set([
  ...[.../MUTATING_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(BRAIN_SOURCE)![1]!.replace(/\/\/.*$/gm, "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!),
  ...[...BRAIN_SOURCE.matchAll(/^ {2}([a-z-]+): \(args\) => /gm)].map((m) => m[1]!),
  "hygiene",
]);

/**
 * Writing commands that refuse a flag the bin reads for every writing command,
 * so the bin's read never lets the flag through to them. `geo` refuses any
 * flag outside its per-verb table, and `--dry-run` is not in it.
 */
const BIN_READ_REFUSED: Record<string, string[]> = { geo: ["dry-run"] };

/**
 * Reads the bin entry makes for one command: its `MUTATING_WITH_FLAGS` row in
 * main.ts, each read-only.ts line that names that command alone
 * (`command === "<word>"`), and, for a writing command, each main.ts line
 * that starts `if (mutates`. A read-only.ts line that names two commands is
 * not attributed.
 */
function binReads(word: string): Set<string> {
  const reads = new Set<string>();
  const brain = BRAIN_SOURCE;
  for (const m of brain.matchAll(/^ {2}([a-z-]+): \(args\) => (.*)$/gm)) if (m[1] === word) for (const r of readsIn(m[2]!)) reads.add(r);
  if (WRITING_COMMANDS.has(word)) {
    for (const m of brain.matchAll(/^\s*if \(mutates\b(.*)$/gm)) for (const r of readsIn(m[1]!)) if (!BIN_READ_REFUSED[word]?.includes(r)) reads.add(r);
  }
  for (const line of readFileSync(join(CLI, "read-only.ts"), "utf8").split("\n")) {
    const named = [...line.matchAll(/command === "([a-z-]+)"/g)].map((m) => m[1]);
    if (named.length === 1 && named[0] === word) for (const r of readsIn(line)) reads.add(r);
  }
  return reads;
}

describe("vocabulary", () => {
  test("every command has a source file and a declaration of sorted, unique, non-global flags", () => {
    expect(sorted(Object.keys(COMMAND_FILES))).toEqual(sorted(Object.keys(CORE_COMMANDS)));
    for (const [word, command] of Object.entries(COMMANDS)) {
      for (const list of [command.flags.boolean, command.flags.value]) {
        expect({ word, list: [...list] }).toEqual({ word, list: sorted(list) });
        expect({ word, global: list.filter((flag) => GLOBAL.has(flag)) }).toEqual({ word, global: [] });
      }
    }
  });

  test("each command that uses parseArgs declares booleans parseArgs knows as booleans and value flags it knows as value flags", () => {
    for (const [word, command] of Object.entries(COMMANDS)) {
      if (word === "compute") continue; // its own parser, compared below
      expect({ word, boolean: command.flags.boolean.filter((flag) => !BOOLEAN_FLAGS.has(flag)) }).toEqual({ word, boolean: [] });
      expect({ word, value: command.flags.value.filter((flag) => !VALUE_FLAGS.has(flag)) }).toEqual({ word, value: [] });
    }
  });

  test("the declarations and the global flags cover the whole vocabulary except the unread flags", () => {
    const covered = new Set(GLOBAL);
    for (const word of Object.keys(COMMANDS)) if (word !== "compute") for (const flag of declared(word)) covered.add(flag);
    expect(sorted(covered)).toEqual(sorted([...BOOLEAN_FLAGS, ...VALUE_FLAGS].filter((flag) => !UNREAD.includes(flag))));
  });

  test("compute declares exactly its own parser's flags", () => {
    expect(sorted(declared("compute"))).toEqual(sorted([...COMPUTE_BOOLEAN, ...COMPUTE_VALUE].filter((flag) => !GLOBAL.has(flag))));
    expect(sorted(COMMANDS.compute!.flags.boolean)).toEqual(sorted([...COMPUTE_BOOLEAN].filter((flag) => !GLOBAL.has(flag))));
    expect(sorted(COMMANDS.compute!.flags.value)).toEqual(sorted(COMPUTE_VALUE));
  });

  test("geo, schedule and queue declare exactly the union of their per-verb tables, less the global flags", () => {
    expect(sorted(declared("geo"))).toEqual(sorted(Object.values(GEO_OPTIONS).flat()));
    expect(sorted(declared("schedule"))).toEqual(sorted(Object.values(SCHEDULE_ALLOWED).flat().filter((flag) => !GLOBAL.has(flag))));
    expect(sorted(declared("queue"))).toEqual(sorted(QUEUE_ALLOWED.filter((flag) => !GLOBAL.has(flag))));
  });
});

describe("read check", () => {
  test("every flag a command's source reads is declared or global", () => {
    const undeclaredReads: Record<string, string[]> = {};
    for (const [word, file] of Object.entries(COMMAND_FILES)) {
      const reads = new Set([...readsIn(readFileSync(join(CLI, "commands", file), "utf8")), ...binReads(word)]);
      const missing = sorted([...reads].filter((flag) => !accepted(word, flag)));
      if (missing.length) undeclaredReads[word] = missing;
    }
    expect(undeclaredReads).toEqual({});
  });

  test("the scan sees reads of each kind", () => {
    expect(readsIn(`flags.limit; flags["max-tokens"]; stringFlag(flags, "mode"); repeatedFlag(args, "tag"); args.includes("--dry-run")`))
      .toEqual(new Set(["limit", "max-tokens", "mode", "tag", "dry-run"]));
    expect(binReads("tags")).toEqual(new Set(["apply", "dry-run"]));
    expect(binReads("index")).toEqual(new Set(["dry-run", "embeddings", "on-commit", "forget-cache"]));
    expect(binReads("process")).toEqual(new Set(["dry-run"]));
    expect(binReads("search")).toEqual(new Set());
    expect(binReads("geo")).toEqual(new Set());
    expect(sorted(WRITING_COMMANDS)).toEqual(sorted([
      "accept-mtime", "add", "archive", "config", "geo", "graph", "hygiene", "import", "index", "maintain", "process",
      "registry", "render", "scratch", "setup", "skills", "storage", "sync", "tags",
    ]));
  });
});

/**
 * Declared flags a command's help block does not name, one sorted list per
 * command. A change here is a reviewed diff: document the flag, or explain why
 * it stays undocumented. None is a help-block edit for #4834. Each `dry-run`
 * here is the bin's read for a writing command, which skips the
 * read-only-mount refusal; the command itself does not read it.
 */
const UNDOCUMENTED: Record<string, string[]> = {
  "accept-mtime": ["dry-run"],
  add: ["dry-run"],
  graph: ["dry-run"],
  import: ["dry-run"],
  index: ["dry-run"],
  list: ["include-archived"],
  maintain: ["dry-run"],
  module: ["action", "stdin"],
  process: ["dry-run"],
  queue: ["root"],
  registry: ["dry-run"],
  render: ["dry-run"],
  schedule: ["root"],
  scratch: ["dry-run"],
  setup: ["dry-run"],
  skills: ["dry-run"],
};

/** The `--flag` names in a text, before a bare `--` that ends the flags. */
function flagsIn(text: string): string[] {
  return [...text.split(/\s--(?:\s|$)/)[0]!.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
}

describe("help check", () => {
  test("every flag a command's help block names is declared or global", () => {
    const undeclaredInHelp: Record<string, string[]> = {};
    const undocumented: Record<string, string[]> = {};
    for (const [word, command] of Object.entries(COMMANDS)) {
      let help = command.helpBlock ?? "";
      const missing: string[] = [];
      // A help block that quotes another command (`brain index --compact`) names that command's flags.
      for (const m of help.matchAll(/`brain ([a-z-]+)([^`]*)`/g)) {
        if (m[1] === word || !Object.hasOwn(COMMANDS, m[1]!)) continue;
        missing.push(...flagsIn(m[2]!).filter((flag) => !accepted(m[1]!, flag)).map((flag) => `${m[1]} --${flag}`));
        help = help.replace(m[0], "");
      }
      const named = new Set([...help.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
      missing.push(...[...named].filter((flag) => !accepted(word, flag)));
      if (missing.length) undeclaredInHelp[word] = sorted(missing);
      const unnamed = sorted([...declared(word)].filter((flag) => !named.has(flag)));
      if (unnamed.length) undocumented[word] = unnamed;
    }
    expect(undeclaredInHelp).toEqual({});
    expect(undocumented).toEqual(UNDOCUMENTED);
  });
});

interface Invocation { file: string; line: number; command: string; text: string }

/** Every `brain <core command> …` invocation in fenced code and inline code of the Markdown under the template, the skills and docs. */
async function documentedInvocations(): Promise<Invocation[]> {
  const spans: { file: string; line: number; text: string }[] = [];
  for (const glob of ["template/**/*.md", "packages/*/skills/**/*.md", "docs/**/*.md"]) {
    for await (const file of new Bun.Glob(glob).scan({ cwd: REPO, dot: true })) {
      if (file.includes("node_modules")) continue;
      const lines = readFileSync(join(REPO, file), "utf8").split("\n");
      let fenced = false;
      let pending = "";
      let start = 0;
      lines.forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; pending = ""; return; }
        if (fenced) {
          if (!pending) start = index + 1;
          pending = pending ? `${pending} ${line.trimStart()}` : line;
          if (/\\\s*$/.test(pending)) { pending = pending.replace(/\\\s*$/, ""); return; }
          spans.push({ file, line: start, text: pending });
          pending = "";
        } else {
          for (const m of line.matchAll(/(`+)([^`]+?)\1/g)) spans.push({ file, line: index + 1, text: m[2]! });
        }
      });
    }
  }
  const invocations: Invocation[] = [];
  for (const span of spans) {
    for (const m of span.text.matchAll(/(?<![\w/.-])brain\s+([a-z][a-z-]*)((?:[ \t]+(?:"[^"]*"|'[^']*'|<[^>]*>|[^\s|;&()`<>]+))*)/g)) {
      // A module command is checked by its module, not here.
      if (Object.hasOwn(COMMANDS, m[1]!)) invocations.push({ file: span.file, line: span.line, command: m[1]!, text: m[0] });
    }
  }
  return invocations;
}

/** Documented invocations the check must not judge: file, the invocation's text, and why. None today. */
const IGNORED_INVOCATIONS: { file: string; text: string; reason: string }[] = [];

describe("documentation check", () => {
  test("every documented core invocation passes only flags its command declares", async () => {
    const invocations = await documentedInvocations();
    // The extractor finds the corpus, not nothing.
    expect(invocations.length).toBeGreaterThan(500);
    expect(invocations.some((i) => i.command === "search" && flagsIn(i.text).includes("mode"))).toBe(true);
    const ignored = (i: Invocation) => IGNORED_INVOCATIONS.some((x) => x.file === i.file && x.text === i.text);
    const failures = invocations
      .filter((i) => !ignored(i))
      .flatMap((i) => flagsIn(i.text).filter((flag) => !accepted(i.command, flag)).map((flag) => `${i.file}:${i.line} brain ${i.command} --${flag}`));
    expect(failures).toEqual([]);
  });
});

/**
 * Every flag first-party code outside packages/core passes to a core command,
 * with the file that passes it. Found with
 * `git grep -n -E 'execBrain\(|argv: \[("brain"|\.\.\.command|cliBin)|brain\.hygiene\(|cli\(\[' -- packages/ui-server/src packages/ui-backend-claude/src packages/ui-backend-pi/src`
 * and the `"--<flag>"` literals in each hit's file, plus argument lists
 * returned as `[...command, "<core command>", …]`. The two backends reach core
 * through the library, not its CLI, and have no hit. A row's flag must still
 * appear in its file as `--<flag>`. The hosted schedules' shell lines are not
 * rows: `SHELL_HOSTS` below parses them.
 */
const HOST_ROWS: { command: string; flags: string[]; file: string }[] = [
  { command: "module", flags: ["json", "stdin", "preview", "migrate", "revision", "action"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "search", flags: ["type", "tag", "limit", "mode"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "stats", flags: ["history"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "list", flags: ["type", "tag", "status", "relevance", "limit"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "hygiene", flags: ["json"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "sync", flags: ["json"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "add", flags: ["type", "title", "tags"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "index", flags: ["force", "json"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "storage", flags: ["json"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "config", flags: ["json"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "scratch", flags: ["pins-file", "json"], file: "packages/ui-server/src/brain/client.ts" },
  { command: "module", flags: ["json"], file: "packages/ui-server/src/cron/module-discovery.ts" },
  { command: "sync", flags: ["human"], file: "packages/ui-server/src/routes/brain.ts" },
  {
    command: "hygiene",
    flags: ["finding", "dry-run", "expect-fingerprint", "pattern", "to", "ignore-adjust", "handler", "input", "defer", "expect-preview", "reason", "until"],
    file: "packages/ui-server/src/inbox/hygiene-review.ts",
  },
  {
    command: "hygiene",
    flags: ["journal", "expect-fingerprint", "expect-approval", "expect-premise", "ignore-adjust", "pattern", "to", "copy", "copy-sha256"],
    file: "packages/ui-server/src/inbox/media-effects.ts",
  },
];

/**
 * Host files that run core commands as shell text, found with
 * `git grep -n -E '\bbrain (<core command words>)\b' -- packages/ui-server/src`
 * outside comments: the hosted schedules' crontab and sync job. Every
 * `brain <core command> …` in them is parsed and judged like a documented
 * invocation, so a flag added to a schedule line is checked. The words each
 * file must yield keep the parser from silently finding nothing.
 */
const SHELL_HOSTS: { file: string; commands: string[] }[] = [
  // `module` is the crontab comment emitted when `brain module list` is unavailable.
  { file: "packages/ui-server/src/cron/emit.ts", commands: ["hygiene", "index", "maintain", "module", "sync", "validate"] },
];

/** Flags a host passes that its command does not read, each filed. None today. */
const HOST_EXCEPTIONS: { command: string; flag: string; file: string; issue: string }[] = [];

describe("host check", () => {
  test("every flag a first-party host passes a core command is declared or global, and still appears in that host's file", () => {
    for (const row of HOST_ROWS) {
      const source = readFileSync(join(REPO, row.file), "utf8");
      for (const flag of row.flags) {
        expect({ ...row, flag, present: new RegExp(`(?<![\\w-])--${flag}(?![\\w-])`).test(source) }).toEqual({ ...row, flag, present: true });
        const excepted = HOST_EXCEPTIONS.some((x) => x.command === row.command && x.flag === flag && x.file === row.file);
        expect({ ...row, flag, accepted: excepted || accepted(row.command, flag) }).toEqual({ ...row, flag, accepted: true });
      }
    }
  });

  test("every flag a host's shell line passes a core command is declared or global", () => {
    for (const host of SHELL_HOSTS) {
      const source = readFileSync(join(REPO, host.file), "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
      const lines = [...source.matchAll(/(?<![\w/.-])brain ([a-z][a-z-]*)((?: +[^\s|&;>`'"$]+)*)/g)]
        .filter((m) => Object.hasOwn(COMMANDS, m[1]!))
        .map((m) => ({ command: m[1]!, flags: flagsIn(m[2]!) }));
      expect({ file: host.file, commands: sorted(lines.map((l) => l.command)) }).toEqual({ file: host.file, commands: host.commands });
      const undeclaredFlags = lines.flatMap((l) => l.flags.filter((flag) => !accepted(l.command, flag)).map((flag) => `brain ${l.command} --${flag}`));
      expect({ file: host.file, undeclared: undeclaredFlags }).toEqual({ file: host.file, undeclared: [] });
    }
  });
});
