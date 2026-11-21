/**
 * The live shape check (plan §11): maintainer-run and read-only. Runs each
 * Gmail read operation once against a real account, with exactly the
 * transport's argv (`--readonly`, `--no-input`, `--gmail-no-send` and the
 * per-operation `--enable-commands-exact`), and prints only the JSON key
 * paths of each answer beside the fixtures' key paths
 * (packages/common/tests/fixtures/gog), with the difference, and the
 * transport's own codec's verdict on the answer: `codec: "accepted"`, or
 * `codec: {refused: <code>, at: <key path>}`. No value, no id and no stderr
 * is ever printed, so the output can be pasted into a PR after
 * `bun scripts/check-leakage.ts`.
 *
 *   bun scripts/google-shape-check.ts --gog <gog binary> --account <alias> [--home <gog home>] [--query <gmail query>]
 *
 * It gates every gog upgrade and every landing. It refuses to run in CI and
 * under the offline test guard: no test may reach a real account. The ids
 * it needs for the next read (a thread from the search, its first message,
 * a draft from `gmail drafts list`) stay in memory.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { GOG_OPERATION_INPUTS, gogArgv, gogInvocation, isGogAccountAlias, type GogInvocation } from "../packages/common/src/google/gog/argv.ts";
import { GOG_READ_CODECS, GogShapeError } from "../packages/common/src/google/gog/codecs.ts";
import { GOG_PINS } from "../packages/common/src/google/gog/pins.ts";
import { runGogProcess } from "../packages/common/src/google/gog/runner.ts";

export const FIXTURE_DIR = resolve(import.meta.dir, "../packages/common/tests/fixtures/gog");

/** The read operations it checks, with the fixtures each is compared with. */
export const SHAPE_FIXTURES = Object.freeze({
  "gmail.labels.list": ["labels-list.json"],
  "gmail.search": ["search-ids.json", "search-empty.json"],
  "gmail.thread.get": ["thread-hall.json", "thread-swine.json", "thread-pylos.json"],
  "gmail.message.get": ["message-get.json", "message-herald.json", "message-ledger.json"],
  "gmail.draft.get": ["draft-raw.json"],
} as const);
export type ShapeOperation = keyof typeof SHAPE_FIXTURES;

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const typeOf = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/**
 * Every key path of a JSON value with its leaf type, sorted and unique:
 * `$.thread.messages[].payload.parts[]*.body.data: string`. Arrays collapse
 * to `[]`, a MIME part tree's nesting to `parts[]*`, and a key that is not an
 * identifier (so could be data) to `<key>`. Never a value.
 */
export function keyPaths(value: unknown, path = "$"): string[] {
  const out = new Set<string>();
  const add = (at: string, type: string) => out.add(`${at.replace(/(?:\.parts\[\])+/g, ".parts[]*")}: ${type}`);
  const visit = (node: unknown, at: string) => {
    if (Array.isArray(node)) {
      if (node.length === 0) add(at, "[]");
      for (const item of node) visit(item, `${at}[]`);
    } else if (node !== null && typeof node === "object") {
      const entries = Object.entries(node);
      if (entries.length === 0) add(at, "{}");
      for (const [key, child] of entries) visit(child, `${at}.${KEY.test(key) ? key : "<key>"}`);
    } else {
      add(at, typeOf(node));
    }
  };
  visit(value, path);
  return [...out].sort();
}

export function fixtureKeyPaths(operation: ShapeOperation, dir = FIXTURE_DIR): string[] {
  return [...new Set(SHAPE_FIXTURES[operation].flatMap(name => keyPaths(JSON.parse(readFileSync(join(dir, name), "utf8")))))].sort();
}

export function diffKeyPaths(live: readonly string[], fixtures: readonly string[]): { only_live: string[]; only_fixtures: string[] } {
  const known = new Set(fixtures);
  const seen = new Set(live);
  return { only_live: live.filter(path => !known.has(path)), only_fixtures: fixtures.filter(path => !seen.has(path)) };
}

/**
 * What the transport's own codec (`GOG_READ_CODECS`) makes of one answer:
 * accepted, or refused with the code the transport would answer and where,
 * as a key path. A codec that throws anything but a shape error is
 * `codec_error`; its message is never carried.
 */
export type CodecVerdict = "accepted" | { refused: "transport_incompatible"; at: string } | { refused: "codec_error" };

const SHAPE_PATH = /^\$(?:\.(?:[A-Za-z_][A-Za-z0-9_]{0,63}|<key>)(?:\[\]\*?)*)*$/;

/**
 * A codec error path in key-path form: indexes collapse to `[]` and a MIME
 * part tree's nesting to `parts[]*`, as {@link keyPaths} writes them. A path
 * that is not key names and indexes alone is `<path>`.
 */
export function shapePath(path: string): string {
  const collapsed = path.replace(/\[\d+\]/g, "[]").replace(/(?:\.parts\[\])+/g, ".parts[]*");
  return SHAPE_PATH.test(collapsed) ? collapsed : "<path>";
}

export async function codecVerdict(operation: ShapeOperation, json: unknown): Promise<CodecVerdict> {
  try {
    await GOG_READ_CODECS[operation](json);
    return "accepted";
  } catch (error) {
    if (error instanceof GogShapeError) return { refused: "transport_incompatible", at: shapePath(error.path) };
    return { refused: "codec_error" };
  }
}

/** One operation's answer as the script saw it: gog's exit, how it ended, and its JSON (null when there was none). */
export interface ShapeAnswer {
  exit: number | null;
  end: string;
  json: unknown;
}

/** One operation's report: the key paths, their difference from the fixtures', and the codec's verdict. */
export async function operationReport(operation: ShapeOperation, answer: ShapeAnswer, dir = FIXTURE_DIR): Promise<Record<string, unknown>> {
  if (answer.json === null) return { exit: answer.exit, end: answer.end };
  const live = keyPaths(answer.json);
  return { exit: answer.exit, live, ...diffKeyPaths(live, fixtureKeyPaths(operation, dir)), codec: await codecVerdict(operation, answer.json) };
}

/** Why it must not run here, or null. */
export function shapeCheckRefusal(env: Readonly<Record<string, string | undefined>>, guardInstalled: boolean): string | null {
  if (env.CI || env.GITHUB_ACTIONS) return "google-shape-check refuses to run in CI: it reaches a real Google account.";
  if (guardInstalled || env.NODE_ENV === "test") return "google-shape-check refuses to run under the offline test guard: no test may reach a real Google account.";
  return null;
}

/** What reaches gog from the maintainer's shell: what finds their gog home and keyring, and no other GOG_* name. */
const PASSED = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "GOG_HOME", "GOG_KEYRING_BACKEND", "GOG_KEYRING_PASSWORD", "GOG_TIMEZONE"];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at]!;
    const value = argv[at + 1];
    if (!["--gog", "--account", "--home", "--query"].includes(name) || value === undefined) throw new Error(`unknown or incomplete argument ${name}`);
    out[name.slice(2)] = value;
  }
  return out;
}

async function main(): Promise<number> {
  const refusal = shapeCheckRefusal(process.env, Boolean((globalThis as Record<symbol, unknown>)[Symbol.for("brain-kit.test-network-guard.installed")]));
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  let args: Record<string, string>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: bun scripts/google-shape-check.ts --gog <gog binary> --account <alias> [--home <gog home>] [--query <gmail query>]`);
    return 2;
  }
  if (!args.gog || !existsSync(args.gog)) return console.error("--gog must name an existing gog binary"), 2;
  if (!isGogAccountAlias(args.account)) return console.error("--account must be a gog account alias, not an address or auto"), 2;
  const gog = realpathSync(resolve(args.gog));
  const env: Record<string, string> = {};
  for (const name of PASSED) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  if (args.home) env.GOG_HOME = resolve(args.home);

  const run = async (call: GogInvocation | string[]) => {
    const argv = Array.isArray(call) ? call : gogArgv(call, args.account!);
    const result = await runGogProcess(gog, argv, { env, stdin: null, timeoutMs: 60_000, stdoutCap: 32 * 1024 * 1024 });
    const exit = result.end.kind === "exit" ? result.end.exitCode : null;
    if (exit !== 0 || !result.stdout) return { exit, end: result.end.kind, json: null as unknown };
    try {
      return { exit, end: result.end.kind, json: JSON.parse(new TextDecoder().decode(result.stdout)) as unknown };
    } catch {
      return { exit, end: "not_json", json: null as unknown };
    }
  };

  const version = await runGogProcess(gog, ["version"], { env, stdin: null, timeoutMs: 30_000, stdoutCap: 64 * 1024 });
  const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(gog)).digest("hex");
  const report: Record<string, unknown> = {
    gog: version.stdout ? new TextDecoder().decode(version.stdout).trim().split("\n")[0] : null,
    pinned: GOG_PINS.some(pin => Object.values(pin.sha256).includes(sha256)),
    operations: {} as Record<string, unknown>,
  };
  const operations = report.operations as Record<string, unknown>;

  // A live id goes back into argv only through the transport's own input
  // schema; one that does not have the catalog's id shape is reported, never printed.
  const read = async (operation: ShapeOperation, input: Record<string, unknown>) => {
    const parsed = GOG_OPERATION_INPUTS[operation].safeParse(input);
    if (!parsed.success) {
      operations[operation] = { refused: "the live id does not have the catalog's id shape" };
      return null;
    }
    const answer = await run(gogInvocation(operation, parsed.data as never));
    operations[operation] = await operationReport(operation, answer);
    return answer.json;
  };
  await read("gmail.labels.list", {});
  const search = await read("gmail.search", { query: args.query ?? "newer_than:30d", limit: 3 });
  const threadId = (search as { threads?: { id?: unknown }[] } | null)?.threads?.[0]?.id;
  if (threadId !== undefined) {
    const thread = await read("gmail.thread.get", { thread_id: threadId });
    const messageId = (thread as { thread?: { messages?: { id?: unknown }[] } } | null)?.thread?.messages?.[0]?.id;
    if (messageId !== undefined) await read("gmail.message.get", { message_id: messageId });
  }
  // Not a catalog operation: a read-only listing, under its own exact allow-list, to find one draft id.
  const drafts = await run(["--no-input", "--json", "--color=never", `--account=${args.account}`, "--enable-commands-exact=gmail.drafts.list",
    "--readonly", "--gmail-no-send", "gmail", "drafts", "list", "--max=1"]);
  const draftId = (drafts.json as { drafts?: { id?: unknown }[] } | null)?.drafts?.[0]?.id;
  if (draftId !== undefined) await read("gmail.draft.get", { draft_id: draftId });
  for (const operation of Object.keys(SHAPE_FIXTURES)) operations[operation] ??= { skipped: "no item to read" };

  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (import.meta.main) process.exit(await main());
