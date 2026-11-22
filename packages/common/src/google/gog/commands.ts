/**
 * The gog commands the Gmail catalog runs (plan §8, "Invocation discipline"),
 * and the only flags and positionals each may be given.
 *
 * This is the list the schema snapshot is generated from
 * (`scripts/gog-schema-snapshot.ts`) and the pin checks against a binary's
 * own `gog schema --json` at first use. An argv builder that needs another
 * flag adds it here, regenerates the snapshot and so makes the pin check it.
 *
 * A key is the command's dot path, which is also the value of the exact
 * allow-list (`--enable-commands-exact=<key>`) every invocation carries.
 */

/** Global flags an invocation may carry, before its command path. */
export const GOG_ROOT_FLAGS = [
  "no-input", "json", "color", "account", "enable-commands-exact", "readonly", "gmail-no-send", "force",
] as const;
export type GogRootFlag = typeof GOG_ROOT_FLAGS[number];

export interface GogCommandSpec {
  /** The command path, canonical names only. */
  path: readonly string[];
  /** Command flags the builders may set. */
  flags: readonly string[];
  /** Positionals, in order, always after `--`. */
  positionals: readonly string[];
  /** The last positional repeats (one or more ids); otherwise each is given exactly once. */
  variadic: boolean;
  /** Whether the command changes anything at Google. Reads carry `--readonly`. */
  write: boolean;
}

export const GOG_COMMANDS = Object.freeze({
  "gmail.search": { path: ["gmail", "search"], flags: ["max", "page", "ids-only"], positionals: ["query"], variadic: false, write: false },
  "gmail.thread.get": { path: ["gmail", "thread", "get"], flags: [], positionals: ["threadId"], variadic: false, write: false },
  "gmail.get": { path: ["gmail", "get"], flags: ["format"], positionals: ["messageId"], variadic: false, write: false },
  "gmail.drafts.get": { path: ["gmail", "drafts", "get"], flags: ["format"], positionals: ["draftId"], variadic: false, write: false },
  "gmail.labels.list": { path: ["gmail", "labels", "list"], flags: [], positionals: [], variadic: false, write: false },
  "gmail.batch.modify": { path: ["gmail", "batch", "modify"], flags: ["add", "remove"], positionals: ["messageId"], variadic: true, write: true },
  "gmail.trash": { path: ["gmail", "trash"], flags: [], positionals: ["messageId"], variadic: true, write: true },
  "gmail.drafts.create": {
    path: ["gmail", "drafts", "create"], flags: ["to", "cc", "bcc", "subject", "body-file", "reply-to-message-id"], positionals: [], variadic: false, write: true,
  },
  "gmail.drafts.update": {
    path: ["gmail", "drafts", "update"], flags: ["to", "cc", "bcc", "subject", "body-file"], positionals: ["draftId"], variadic: false, write: true,
  },
  "gmail.drafts.delete": { path: ["gmail", "drafts", "delete"], flags: [], positionals: ["draftId"], variadic: false, write: true },
  "gmail.send": { path: ["gmail", "send"], flags: ["raw-file", "thread-id"], positionals: [], variadic: false, write: true },
} as const satisfies Record<string, GogCommandSpec>);

export type GogCommand = keyof typeof GOG_COMMANDS;
export const GOG_COMMAND_NAMES = Object.freeze(Object.keys(GOG_COMMANDS) as GogCommand[]);

/**
 * The one gog command that sends mail. It alone runs without
 * `--gmail-no-send`, and only the host's send path builds it (plan §4).
 */
export const GOG_SEND_COMMAND = "gmail.send" satisfies GogCommand;

/**
 * Flags no builder may ever pass: each makes gog write a file (its default
 * directory is the credential home), read one the host did not choose, widen
 * what runs, or change the output a codec reads.
 */
export const GOG_FORBIDDEN_FLAGS = Object.freeze([
  "download", "out-dir", "attach", "body-html-file", "signature-file", "home", "access-token", "client", "enable-commands",
  "disable-commands", "wrap-untrusted", "results-only", "select", "plain", "dry-run", "verbose", "all", "query", "quote",
  "reply-all", "track", "track-split", "from", "use-indexed-attachment-ids", "sanitize-content", "full",
]);

/**
 * What the committed snapshot records from one gog release's
 * `gog schema --json`: the commands and flags above, each with the type gog
 * declares for it, and the exit codes the error mapping relies on.
 */
export interface GogSchemaSnapshot {
  /** The `build` string of the schema it was generated from. */
  gog: string;
  schema_version: number;
  exit_codes: Readonly<Record<string, number>>;
  root_flags: Readonly<Record<string, string>>;
  commands: Readonly<Record<GogCommand, {
    path: readonly string[];
    flags: Readonly<Record<string, string>>;
    positionals: Readonly<Record<string, string>>;
  }>>;
}
