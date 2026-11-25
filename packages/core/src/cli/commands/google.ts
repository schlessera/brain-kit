import { readFileSync, statSync } from "node:fs";
import { GOOGLE_VIEWS, type GoogleView } from "@schlessera/brain-common/internal/google-operations";
import type { GogBinary } from "@schlessera/brain-common/internal/google-gog";
import { createStandaloneGoogle, type GoogleEnvelope, type GoogleReadCommand, type StandaloneGoogle } from "../../lib/google/standalone.js";
import { emit, parseArgs, UsageError } from "../io.js";
import type { CoreCommand } from "../types.js";

const USAGE = `brain google <command> [--json]

  status                                           The home, the pinned gog, the policy, the
                                                   connected alias and its scopes
  connect <address> [--write] [--remote [--auth-url URL]] [--credentials FILE]
                                                   Connect the policy's account alias
  gmail search <query…> [--view V] [--limit N] [--cursor C]
                                                   One page of threads (at most 25)
  gmail read thread|message|draft <id> [--view V]  One thread, message or draft
  gmail labels                                     The account's labels

The same Gmail reads as the hosted brain_google_* tools, under the governance
policy's google block, in the standalone posture: there is no session, so no
taint, no remembered approval and no card, and nothing is ever asked. --view
is content (the default: senders, subjects, snippets and bodies, marked
untrusted) or structured (ids, labels, dates, counts and flags only). A local
agent with shell access is inside this boundary; brain google status says so.

The home is BRAIN_UI_GOOGLE_HOME when set (an operator connecting the host),
else BRAIN_GOOGLE_HOME, else $XDG_DATA_HOME/brain/google, never inside a brain
repository. connect asks gog for read-only scopes unless --write, and with
--write for exactly gmail.readonly and gmail.modify; a broader grant is
removed and refused. --remote prints a URL to open elsewhere; run the same
command again with --auth-url and the URL the browser landed on.

Every command prints { ok, operation, data } or { ok: false, operation, error:
{ code, reason, message } } and exits 0 or 1.`;

/** The test seam: a factory for the standalone service. Production never passes a binary. */
export const googleCommandDeps: { binary: GogBinary | undefined; create: (root: string, binary?: GogBinary) => StandaloneGoogle } = {
  binary: undefined,
  create: (root, binary) => createStandaloneGoogle({ root, ...(binary ? { binary } : {}) }),
};

const COMMON = ["json", "human"];
const READ_TARGETS = { thread: "gmail.thread.get", message: "gmail.message.get", draft: "gmail.draft.get" } as const;

function only(flags: Record<string, string | boolean>, allowed: readonly string[], command: string): void {
  for (const key of Object.keys(flags)) if (![...COMMON, ...allowed].includes(key)) throw new UsageError(`Unsupported brain google ${command} flag: --${key}`);
}

function text(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`--${name} needs a value.`);
  return value;
}

function viewOf(flags: Record<string, string | boolean>): GoogleView | undefined {
  const value = text(flags, "view");
  if (value === undefined) return undefined;
  if (!(GOOGLE_VIEWS as readonly string[]).includes(value)) throw new UsageError(`--view is ${GOOGLE_VIEWS.join(" or ")}.`);
  return value as GoogleView;
}

function limitOf(flags: Record<string, string | boolean>): number | undefined {
  const value = text(flags, "limit");
  if (value === undefined) return undefined;
  if (!/^\d{1,3}$/u.test(value)) throw new UsageError("--limit needs a whole number.");
  return Number(value);
}

/** The OAuth client file, read here so gog gets it on stdin and never a path. */
function credentialsOf(flags: Record<string, string | boolean>): Uint8Array | undefined {
  const path = text(flags, "credentials");
  if (path === undefined) return undefined;
  try {
    if (!statSync(path).isFile() || statSync(path).size > 64 * 1024) throw new UsageError("--credentials names a file of at most 64 KiB.");
    return readFileSync(path);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("--credentials names a file that cannot be read.");
  }
}

function human(envelope: GoogleEnvelope): void {
  if (!envelope.ok) {
    console.error(`Refused (${envelope.error.code}${envelope.error.reason ? `: ${envelope.error.reason}` : ""}): ${envelope.error.message}`);
    return;
  }
  console.log(JSON.stringify(envelope.data, null, 2));
}

export const googleCommand: CoreCommand = {
  summary: "Connect a Google account and read Gmail under the governance policy",
  helpBlock: USAGE,
  async run(args, cli) {
    const { args: positional, flags } = parseArgs(args);
    const [word, ...rest] = positional;
    if (!word) throw new UsageError(`Usage: ${USAGE.split("\n")[0]}`);
    const service = () => googleCommandDeps.create(cli.brain.root, googleCommandDeps.binary);
    let envelope: GoogleEnvelope;
    switch (word) {
      case "status":
        only(flags, [], "status");
        if (rest.length) throw new UsageError("brain google status takes no arguments.");
        envelope = await service().status();
        break;
      case "connect": {
        only(flags, ["write", "remote", "auth-url", "credentials"], "connect");
        if (rest.length !== 1) throw new UsageError("Usage: brain google connect <address> [--write] [--remote [--auth-url URL]] [--credentials FILE]");
        const authUrl = text(flags, "auth-url");
        if (authUrl !== undefined && flags.remote !== true) throw new UsageError("--auth-url finishes a brain google connect --remote.");
        const credentials = credentialsOf(flags);
        envelope = await service().connect({
          address: rest[0]!, write: flags.write === true, remote: flags.remote === true,
          ...(authUrl !== undefined ? { authUrl } : {}), ...(credentials ? { credentials } : {}),
        });
        break;
      }
      case "gmail": {
        const [verb, ...words] = rest;
        let operation: GoogleReadCommand;
        let input: Record<string, unknown>;
        if (verb === "search") {
          only(flags, ["view", "limit", "cursor"], "gmail search");
          if (!words.length) throw new UsageError("brain google gmail search needs a query (Gmail search syntax; put -- before words that start with --).");
          const view = viewOf(flags);
          const limit = limitOf(flags);
          const cursor = text(flags, "cursor");
          operation = "gmail.search";
          input = { query: words.join(" "), ...(view ? { view } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) };
        } else if (verb === "read") {
          only(flags, ["view"], "gmail read");
          const [target, id, ...extra] = words;
          if (!target || !(target in READ_TARGETS) || id === undefined || extra.length) throw new UsageError("Usage: brain google gmail read thread|message|draft <id> [--view structured|content]");
          const view = viewOf(flags);
          operation = READ_TARGETS[target as keyof typeof READ_TARGETS];
          input = { target, id, ...(view ? { view } : {}) };
        } else if (verb === "labels") {
          only(flags, [], "gmail labels");
          if (words.length) throw new UsageError("brain google gmail labels takes no arguments.");
          operation = "gmail.labels.list";
          input = { target: "labels" };
        } else {
          throw new UsageError("Usage: brain google gmail search|read|labels …");
        }
        envelope = await service().read(operation, input);
        break;
      }
      default:
        throw new UsageError(`Unknown brain google command: ${word}. ${USAGE.split("\n")[0]}`);
    }
    emit(cli.json, envelope, () => human(envelope));
    return envelope.ok ? 0 : 1;
  },
};
