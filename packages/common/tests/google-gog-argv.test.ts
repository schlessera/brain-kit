/**
 * The invocation discipline table (plan §8, §11; #4205): every catalog
 * operation's argv uses only snapshot flags, reads carry --readonly,
 * everything but the host send path carries --gmail-no-send, every call
 * carries exactly one --enable-commands-exact naming its own command, bodies
 * go through stdin, and hostile values are refused or built safely.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GOOGLE_OPERATIONS, type GoogleOperation } from "@schlessera/brain-common/internal/google-operations";
import { GOG_ENVIRONMENT_NAMES, GOG_EXIT_CODES, GOG_OPERATION_INPUTS, gogEnvironment } from "@schlessera/brain-common/internal/google-gog";
import { GogArgvError, gogArgv, gogInvocation, type GogInvocation } from "../src/google/gog/argv.ts";
import { GOG_COMMANDS, GOG_FORBIDDEN_FLAGS, GOG_ROOT_FLAGS, GOG_SEND_COMMAND, type GogCommand } from "../src/google/gog/commands.ts";
import { GOG_SCHEMA_SNAPSHOT } from "../src/google/gog/snapshot.ts";
import { renderSnapshot, schemaFromBinary, snapshotFromSchema, SNAPSHOT_FILE } from "../../../scripts/gog-schema-snapshot.ts";
import { createFakeGog } from "./support/fake-gog.ts";
import { schemaFromSnapshot } from "./support/gog-schema.ts";

/** What the offline test guard adds to every child it spawns (scripts/test-network-guard.ts). */
const GUARD_ADDED = /^(?:GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|BRAIN_WORKSPACE_LEASE)$/;

const NUL = String.fromCharCode(0);
const ACCOUNT = "ithaca";
const BODY = "I am on my way home.\nKeep weaving the shroud by day.";
const RAW = new TextEncoder().encode("From: Odysseus <odysseus@example.com>\r\nTo: Penelope <penelope@example.com>\r\nSubject: Home\r\n\r\nSoon.\r\n");

interface Case { label: string; operation: GoogleOperation; input: unknown; command: GogCommand }

const CASES: Case[] = [
  { label: "search, every field", operation: "gmail.search", input: { query: "from:penelope@example.com newer_than:7d", limit: 25, page_token: "09876543210987654321" }, command: "gmail.search" },
  { label: "search, query only", operation: "gmail.search", input: { query: "in:inbox" }, command: "gmail.search" },
  { label: "thread read", operation: "gmail.thread.get", input: { thread_id: "19a0c3d2e4f50601" }, command: "gmail.thread.get" },
  { label: "message read", operation: "gmail.message.get", input: { message_id: "19a0c3d2e4f50602" }, command: "gmail.get" },
  { label: "raw draft read", operation: "gmail.draft.get", input: { draft_id: "r-1234567890123456789" }, command: "gmail.drafts.get" },
  { label: "label list", operation: "gmail.labels.list", input: {}, command: "gmail.labels.list" },
  { label: "modify", operation: "gmail.modify", input: { message_ids: ["19a0c3d2e4f50601", "19a0c3d2e4f50602"], add_label_ids: ["Label_12"], remove_label_ids: ["INBOX", "UNREAD"] }, command: "gmail.batch.modify" },
  { label: "trash", operation: "gmail.trash", input: { message_ids: ["19a0c3d2e4f50700"] }, command: "gmail.trash" },
  { label: "draft create", operation: "gmail.draft.save", input: { action: "create", to: ["Penelope <penelope@example.com>"], cc: ["telemachus@example.com"], bcc: ["eumaeus@example.com"], subject: "Home", body: BODY }, command: "gmail.drafts.create" },
  { label: "draft reply", operation: "gmail.draft.save", input: { action: "create", to: ["penelope@example.com"], subject: "Re: Suitors at the hall", body: BODY, reply_to_message_id: "19a0c3d2e4f50601" }, command: "gmail.drafts.create" },
  { label: "draft update with a body", operation: "gmail.draft.save", input: { action: "update", draft_id: "r-1234567890123456789", to: ["penelope@example.com"], body: BODY }, command: "gmail.drafts.update" },
  { label: "draft update without a body", operation: "gmail.draft.save", input: { action: "update", draft_id: "r-1234567890123456789", subject: "Home at last" }, command: "gmail.drafts.update" },
  { label: "draft delete", operation: "gmail.draft.delete", input: { draft_id: "r-1234567890123456789" }, command: "gmail.drafts.delete" },
  { label: "send", operation: "gmail.draft.send", input: { raw: RAW, thread_id: "19a0c3d2e4f50601" }, command: "gmail.send" },
];

function build(operation: GoogleOperation, input: unknown): { call: GogInvocation; argv: string[] } {
  const parsed = GOG_OPERATION_INPUTS[operation].parse(input);
  const call = gogInvocation(operation, parsed as never);
  return { call, argv: gogArgv(call, ACCOUNT) };
}

/** Splits an argv into root flags, the command path, command flags and the positionals after `--`. */
function parse(argv: string[], command: GogCommand) {
  const path = GOG_COMMANDS[command].path as readonly string[];
  const at = argv.findIndex((_, index) => path.every((name, offset) => argv[index + offset] === name));
  const dash = argv.indexOf("--");
  return {
    root: argv.slice(0, at),
    path: argv.slice(at, at + path.length),
    local: argv.slice(at + path.length, dash === -1 ? undefined : dash),
    positionals: dash === -1 ? [] : argv.slice(dash + 1),
  };
}
const flagName = (arg: string) => arg.slice(2).split("=")[0]!;

describe("the discipline table covers the whole catalog", () => {
  test("every operation and every gog command has a row", () => {
    expect(new Set(CASES.map(row => row.operation))).toEqual(new Set(GOOGLE_OPERATIONS));
    expect(new Set<string>(CASES.map(row => row.command))).toEqual(new Set(Object.keys(GOG_COMMANDS)));
  });
  for (const row of CASES) {
    test(`${row.label} builds ${row.command}`, () => {
      expect(build(row.operation, row.input).call.command).toBe(row.command);
    });
  }
});

describe("snapshot-only flags", () => {
  for (const row of CASES) {
    test(`${row.label}: every flag and positional is one the snapshot records, in its type's form`, () => {
      const { argv } = build(row.operation, row.input);
      const parts = parse(argv, row.command);
      const snapshot = GOG_SCHEMA_SNAPSHOT.commands[row.command];
      expect(parts.path).toEqual([...snapshot.path]);
      expect(parts.root.length).toBeGreaterThan(0);
      for (const arg of parts.root) {
        expect(arg.startsWith("--")).toBe(true);
        const type = GOG_SCHEMA_SNAPSHOT.root_flags[flagName(arg)];
        expect(type, arg).toBeDefined();
        expect(arg.includes("="), arg).toBe(type !== "bool");
      }
      for (const arg of parts.local) {
        expect(arg.startsWith("--"), arg).toBe(true);
        const type = snapshot.flags[flagName(arg)];
        expect(type, arg).toBeDefined();
        expect(arg.includes("="), arg).toBe(type !== "bool");
      }
      const positionals = Object.keys(snapshot.positionals);
      if (positionals.length === 0) expect(parts.positionals).toEqual([]);
      else expect(parts.positionals.length).toBeGreaterThan(0);
      for (const arg of [...parts.root, ...parts.local]) expect(GOG_FORBIDDEN_FLAGS).not.toContain(flagName(arg));
    });
  }
});

describe("read-only and no-send switches", () => {
  const READ_COMMANDS: GogCommand[] = ["gmail.search", "gmail.thread.get", "gmail.get", "gmail.drafts.get", "gmail.labels.list"];
  for (const row of CASES) {
    test(`${row.label}: --readonly exactly when it reads`, () => {
      const { argv } = build(row.operation, row.input);
      expect(parse(argv, row.command).root.filter(arg => arg === "--readonly")).toHaveLength(READ_COMMANDS.includes(row.command) ? 1 : 0);
    });
    test(`${row.label}: --gmail-no-send unless it is the host send path`, () => {
      const { argv } = build(row.operation, row.input);
      // Keyed on the operation, not on the command the table expects: a builder that drifts to the send command fails here.
      expect(argv.slice(0, argv.indexOf("gmail")).filter(arg => arg === "--gmail-no-send")).toHaveLength(row.operation === "gmail.draft.send" ? 0 : 1);
    });
  }
  test("only gmail.draft.send builds the send command, by what every builder returns", () => {
    const sending = CASES.filter(row => build(row.operation, row.input).call.command === GOG_SEND_COMMAND).map(row => row.operation);
    expect([...new Set(sending)]).toEqual(["gmail.draft.send"]);
  });
});

describe("one exact command allow-list per call", () => {
  for (const row of CASES) {
    test(`${row.label}: exactly one --enable-commands-exact, naming ${row.command}`, () => {
      const { argv } = build(row.operation, row.input);
      const exact = argv.filter(arg => arg.startsWith("--enable-commands-exact"));
      expect(exact).toEqual([`--enable-commands-exact=${row.command}`]);
      expect(GOG_COMMANDS[row.command].path.join(".")).toBe(row.command);
      expect(argv.filter(arg => arg.startsWith("--enable-commands=") || arg.startsWith("--disable-commands"))).toEqual([]);
    });
  }
});

describe("bodies on stdin", () => {
  const decode = (bytes: Uint8Array | null) => bytes === null ? null : new TextDecoder().decode(bytes);
  for (const row of CASES) {
    test(`${row.label}: stdin carries exactly the body, and argv none of it`, () => {
      const { call, argv } = build(row.operation, row.input);
      const input = row.input as { body?: string; raw?: Uint8Array };
      if (input.body !== undefined) {
        expect(decode(call.stdin)).toBe(input.body);
        expect(argv).toContain("--body-file=-");
      } else if (input.raw !== undefined) {
        expect(call.stdin).toEqual(input.raw);
        expect(argv).toContain("--raw-file=-");
      } else {
        expect(call.stdin).toBeNull();
        expect(argv.some(arg => arg.endsWith("-file=-"))).toBe(false);
      }
      for (const arg of argv) {
        expect(arg.includes("Keep weaving"), arg).toBe(false);
        expect(arg.includes("Soon."), arg).toBe(false);
      }
    });
  }
});

describe("approved draft bodies reach stdin unchanged", () => {
  const bodies: [string, string][] = [
    ["ASCII", "Home to Ithaca."],
    ["astral emoji", "Home \u{1F600}"],
    ["combining marks", "Pe\u0301nelope"],
    ["CRLF", "Home\r\nto Ithaca.\r\n"],
    ["32,768 characters", "a".repeat(32_768)],
  ];
  for (const action of ["create", "update"] as const) {
    for (const [name, body] of bodies) {
      test(`${action}: ${name} round-trips through the real schema and invocation`, () => {
        const input = action === "create"
          ? { action, to: ["penelope@example.com"], subject: "Home", body }
          : { action, draft_id: "r-1234567890123456789", body };
        const { call } = build("gmail.draft.save", input);
        expect(call.command).toBe(action === "create" ? "gmail.drafts.create" : "gmail.drafts.update");
        expect(call.stdin).not.toBeNull();
        expect(new TextDecoder().decode(call.stdin!)).toBe(body);
      });
    }
  }
});

describe("hostile values are refused or built safely", () => {
  const refused = (operation: GoogleOperation, input: unknown) => GOG_OPERATION_INPUTS[operation].safeParse(input).success;
  const valueOf = (argv: string[], flag: string) => argv.filter(arg => arg.startsWith(`--${flag}=`));

  test("a leading dash stays a value: positionals follow --, flag values share their element", () => {
    const search = build("gmail.search", { query: "-in:inbox -label:Ithaca", page_token: "-12" }).argv;
    expect(search.slice(search.indexOf("--") + 1)).toEqual(["-in:inbox -label:Ithaca"]);
    expect(valueOf(search, "page")).toEqual(["--page=-12"]);
    const draft = build("gmail.draft.save", { action: "create", to: ["penelope@example.com"], subject: "--readonly=false", body: BODY }).argv;
    expect(valueOf(draft, "subject")).toEqual(["--subject=--readonly=false"]);
    expect(draft.filter(arg => arg.startsWith("--readonly"))).toEqual([]);
    for (const id of ["-19a0c3d2e4f50601", "--help"]) {
      expect(refused("gmail.thread.get", { thread_id: id })).toBe(false);
      expect(refused("gmail.draft.get", { draft_id: id })).toBe(false);
    }
  });

  test("a comma is kept in one element where gog does not split, and never reaches a list gog splits", () => {
    const search = build("gmail.search", { query: "from:penelope@example.com,telemachus@example.com" }).argv;
    expect(search.slice(search.indexOf("--") + 1)).toEqual(["from:penelope@example.com,telemachus@example.com"]);
    const draft = build("gmail.draft.save", {
      action: "create", to: ["\"Laertes, father of Odysseus\" <laertes@example.com>", "Penelope <penelope@example.com>"], subject: "Ithaca, at last", body: BODY,
    }).argv;
    expect(valueOf(draft, "to")).toEqual(["--to=laertes@example.com,penelope@example.com"]);
    expect(valueOf(draft, "subject")).toEqual(["--subject=Ithaca, at last"]);
    const modify = build("gmail.modify", { message_ids: ["19a0c3d2e4f50601"], add_label_ids: ["Label_12", "STARRED"] }).argv;
    expect(valueOf(modify, "add")).toEqual(["--add=Label_12,STARRED"]);
    expect(refused("gmail.modify", { message_ids: ["19a0c3d2e4f50601"], add_label_ids: ["Label_12,TRASH"] })).toBe(false);
    expect(refused("gmail.search", { query: "in:inbox", page_token: "12,13" })).toBe(false);
  });

  test("a newline is refused in every single-line value; a body keeps its lines on stdin", () => {
    expect(refused("gmail.search", { query: "in:inbox\nlabel:TRASH" })).toBe(false);
    expect(refused("gmail.search", { query: "in:inbox", page_token: "12\n13" })).toBe(false);
    expect(refused("gmail.draft.save", { action: "create", to: ["penelope@example.com"], subject: "Home\nBcc: suitor@example.com", body: BODY })).toBe(false);
    expect(refused("gmail.draft.save", { action: "create", to: ["penelope@example.com\n"], subject: "Home", body: BODY })).toBe(false);
    expect(refused("gmail.thread.get", { thread_id: "19a0c3d2e4f50601\n" })).toBe(false);
    expect(refused("gmail.draft.save", { action: "create", to: ["penelope@example.com"], subject: "Home", body: BODY })).toBe(true);
  });

  test("a NUL is refused in every value, the body included", () => {
    expect(refused("gmail.search", { query: `in:inbox${NUL}` })).toBe(false);
    expect(refused("gmail.draft.save", { action: "create", to: ["penelope@example.com"], subject: `Home${NUL}`, body: BODY })).toBe(false);
    expect(refused("gmail.draft.save", { action: "create", to: ["penelope@example.com"], subject: "Home", body: `Soon.${NUL}` })).toBe(false);
    expect(refused("gmail.modify", { message_ids: [`19a0c3d2e4f50601${NUL}`], add_label_ids: ["STARRED"] })).toBe(false);
  });

  test("argv itself refuses what a schema let through: line breaks, NUL, a comma in a list item, an unlisted flag", () => {
    const base: GogInvocation = { command: "gmail.thread.get", flags: [], positionals: ["19a0c3d2e4f50601"], force: false, stdin: null };
    const refusal = (call: GogInvocation) => {
      try {
        gogArgv(call, ACCOUNT);
        return null;
      } catch (error) {
        return error instanceof GogArgvError ? error.rule : String(error);
      }
    };
    expect(refusal(base)).toBeNull();
    expect(refusal({ ...base, positionals: ["19a0c3d2e4f50601\n--readonly=false"] })).toBe("holds a control character or a line break");
    expect(refusal({ ...base, positionals: [`19a0c3d2e4f50601${NUL}`] })).toBe("holds a control character or a line break");
    expect(refusal({ ...base, positionals: [`19a0c3d2e4f50601${String.fromCharCode(0x2028)}`] })).toBe("holds a control character or a line break");
    expect(refusal({ command: "gmail.search", flags: [["page", `1\r2`]], positionals: ["in:inbox"], force: false, stdin: null })).toBe("holds a control character or a line break");
    expect(refusal({ ...base, flags: [["full", true]] })).toBe("is not a flag of gmail.thread.get");
    expect(refusal({ ...base, positionals: [] })).toBe("gmail.thread.get takes 1 positional(s)");
    expect(refusal({ ...base, positionals: ["19a0c3d2e4f50601", "19a0c3d2e4f50602"] })).toBe("gmail.thread.get takes 1 positional(s)");
    expect(() => gogInvocation("gmail.modify", { message_ids: ["19a0c3d2e4f50601"], add_label_ids: ["Label_1,Label_2"] } as never)).toThrow(GogArgvError);
    for (const account of ["auto", "AUTO", "penelope@example.com", "-ithaca", "ithaca house", "ithaca\n", ""]) {
      expect(() => gogArgv(base, account), account).toThrow("account: is not a gog account alias");
    }
  });
});

describe("the environment is the allow-list", () => {
  test("exactly the plan's names, the home as both GOG_HOME and HOME, nothing from the host", () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GOG_ACCESS_TOKEN: "ya29.suitor", GOG_ENABLE_COMMANDS: "*", GOG_JSON: "0", XDG_CONFIG_HOME: "/elsewhere" });
    try {
      const built = gogEnvironment({ home: "/srv/ithaca/gog", keyringPassword: "penelope-weaves-by-day", timezone: "Europe/Athens" });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(Object.keys(built.environment).sort()).toEqual([...GOG_ENVIRONMENT_NAMES].sort());
      expect(built.environment).toEqual({
        GOG_HOME: "/srv/ithaca/gog", HOME: "/srv/ithaca/gog", GOG_KEYRING_BACKEND: "file", GOG_KEYRING_PASSWORD: "penelope-weaves-by-day",
        GOG_TIMEZONE: "Europe/Athens", PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
      });
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  test("a value that cannot be one is refused by field", () => {
    const valid = { home: "/srv/ithaca/gog", keyringPassword: "penelope-weaves-by-day" };
    expect(gogEnvironment({ ...valid, home: "srv/ithaca" })).toEqual({ ok: false, reason: "home" });
    expect(gogEnvironment({ ...valid, home: "/srv/ithaca\n/x" })).toEqual({ ok: false, reason: "home" });
    expect(gogEnvironment({ ...valid, keyringPassword: "" })).toEqual({ ok: false, reason: "keyring_password" });
    expect(gogEnvironment({ ...valid, keyringPassword: `weave${NUL}` })).toEqual({ ok: false, reason: "keyring_password" });
    expect(gogEnvironment({ ...valid, timezone: "Europe/Athens; rm" })).toEqual({ ok: false, reason: "timezone" });
    expect(gogEnvironment(valid)).toMatchObject({ ok: true, environment: { GOG_TIMEZONE: "UTC" } });
  });
});

describe("the schema snapshot", () => {
  test("records exactly the commands, flags and positionals the builders may use, and the exit codes the mapping reads", () => {
    expect(Object.keys(GOG_SCHEMA_SNAPSHOT.commands).sort()).toEqual(Object.keys(GOG_COMMANDS).sort());
    for (const [command, spec] of Object.entries(GOG_COMMANDS) as [GogCommand, typeof GOG_COMMANDS[GogCommand]][]) {
      const recorded = GOG_SCHEMA_SNAPSHOT.commands[command];
      expect([...recorded.path], command).toEqual([...spec.path]);
      expect(Object.keys(recorded.flags).sort(), command).toEqual([...spec.flags].sort());
      expect(Object.keys(recorded.positionals), command).toEqual([...spec.positionals]);
    }
    expect(Object.keys(GOG_SCHEMA_SNAPSHOT.root_flags).sort()).toEqual([...GOG_ROOT_FLAGS].sort());
    expect(GOG_SCHEMA_SNAPSHOT.exit_codes).toEqual({ ...GOG_EXIT_CODES });
    expect(GOG_SCHEMA_SNAPSHOT.gog).toStartWith("v0.48.1 ");
  });

  test("the committed file is the generator's own output for the schema it records", () => {
    const regenerated = renderSnapshot(snapshotFromSchema(schemaFromSnapshot(GOG_SCHEMA_SNAPSHOT) as never));
    expect(regenerated).toBe(readFileSync(SNAPSHOT_FILE, "utf8"));
    expect(SNAPSHOT_FILE).toBe(join(import.meta.dir, "../src/google/gog/snapshot.ts"));
  });

  test("the generator runs a binary with the transport's environment, over a fresh empty home", async () => {
    const fake = createFakeGog({ schema: { stdout: schemaFromSnapshot(GOG_SCHEMA_SNAPSHOT) } });
    try {
      expect(snapshotFromSchema(await schemaFromBinary(fake.executable) as Parameters<typeof snapshotFromSchema>[0])).toEqual(GOG_SCHEMA_SNAPSHOT);
      const [call] = fake.callsOf("schema");
      expect(call!.argv).toEqual(["schema", "--json"]);
      expect(call!.env_names.filter(name => !GUARD_ADDED.test(name) && !(name === "BUN_OPTIONS" && call!.bun_options === "--no-env-file"))).toEqual([...GOG_ENVIRONMENT_NAMES].sort());
    } finally {
      fake.dispose();
    }
  });

  test("the generator refuses a release that lacks a flag the catalog uses", () => {
    const schema = schemaFromSnapshot(GOG_SCHEMA_SNAPSHOT);
    const search = schema.command.subcommands!.find(node => node.name === "gmail")!.subcommands!.find(node => node.name === "search")!;
    search.flags = search.flags.filter(flag => flag.name !== "ids-only");
    expect(() => snapshotFromSchema(schema as never)).toThrow("gog gmail search has no ids-only");
  });
});
