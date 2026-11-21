/**
 * Argv for every catalog operation (plan §8, "Invocation discipline").
 *
 *   gog --no-input --json --color=never --account=<alias>
 *       --enable-commands-exact=<command> [--readonly] [--gmail-no-send]
 *       <command path> <--flag=value …> [-- <positionals>]
 *
 * Every builder takes input that passed a strict schema built from the
 * catalog's own validators (`../catalog.ts`), and every value becomes one
 * `--flag=value` element or one positional after `--`, so a leading `-` is
 * never read as a flag. Lists gog splits on commas are joined from validated
 * ids and bare addresses only. A value holding a control character, a line
 * separator or NUL is refused, whatever its field. Bodies and raw messages
 * go through stdin, never argv. No builder passes a flag that makes gog
 * write a file ({@link GOG_FORBIDDEN_FLAGS}).
 *
 * The transport-level inputs differ from the tool inputs where the host has
 * already done work: a search takes Google's page token where the tool takes
 * the host cursor, modify and trash take message ids (the host resolves
 * threads first, under its write lock), a draft save takes the recipients
 * and text the host composed, and a send takes the exact bytes the card was
 * built from.
 */
import { z } from "zod";
import { parseGoogleMailbox } from "../address.js";
import {
  GMAIL_DRAFT_INPUT, GMAIL_LIMITS, GMAIL_MODIFY_INPUT, GMAIL_SEARCH_INPUT, GMAIL_TRASH_INPUT, type GoogleOperation,
} from "../catalog.js";
import { GMAIL_DRAFT_ID_PATTERN, GMAIL_MESSAGE_ID_PATTERN, GMAIL_THREAD_ID_PATTERN } from "../ids.js";
import { GMAIL_RAW_DRAFT_LIMITS } from "../mime.js";
import { GOG_COMMANDS, GOG_SEND_COMMAND, type GogCommand } from "./commands.js";

// ------------------------------------------------------------------ inputs

const messageId = z.string().regex(GMAIL_MESSAGE_ID_PATTERN);
const threadId = z.string().regex(GMAIL_THREAD_ID_PATTERN);
const draftId = z.string().regex(GMAIL_DRAFT_ID_PATTERN);
/** Google's page token for the next search page, as an earlier search returned it. */
const pageToken = z.string().min(1).max(512).regex(/^[A-Za-z0-9_+/=.-]+$/);
const draft = GMAIL_DRAFT_INPUT.shape;
const recipients = draft.to.unwrap();
const subject = draft.subject.unwrap();
const body = draft.body.unwrap();

export const GOG_SEARCH_INPUT = z.strictObject({
  query: GMAIL_SEARCH_INPUT.shape.query,
  limit: GMAIL_SEARCH_INPUT.shape.limit,
  page_token: pageToken.optional(),
});
export const GOG_THREAD_INPUT = z.strictObject({ thread_id: threadId });
export const GOG_MESSAGE_INPUT = z.strictObject({ message_id: messageId });
export const GOG_DRAFT_GET_INPUT = z.strictObject({ draft_id: draftId });
export const GOG_LABELS_INPUT = z.strictObject({});

const messagesOnly = (input: { message_ids?: string[]; thread_ids?: string[] }) => input.message_ids !== undefined && input.thread_ids === undefined;
const MESSAGES_ONLY = "the transport takes message ids; the host resolves threads to their messages first";
export const GOG_MODIFY_INPUT = GMAIL_MODIFY_INPUT.refine(messagesOnly, MESSAGES_ONLY);
export const GOG_TRASH_INPUT = GMAIL_TRASH_INPUT.refine(messagesOnly, MESSAGES_ONLY);

export const GOG_DRAFT_SAVE_INPUT = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    to: recipients,
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject,
    body,
    /** For a reply the host composed: threads the draft and sets In-Reply-To and References. */
    reply_to_message_id: messageId.optional(),
  }),
  z.strictObject({
    action: z.literal("update"),
    draft_id: draftId,
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: subject.optional(),
    body: body.optional(),
  }).refine(input => Object.keys(input).length > 2, "an update changes at least one of to, cc, bcc, subject and body"),
]);
export const GOG_DRAFT_DELETE_INPUT = z.strictObject({ draft_id: draftId });
export const GOG_SEND_INPUT = z.strictObject({
  /** The exact RFC 822 bytes the send card was built from. */
  raw: z.instanceof(Uint8Array).refine(raw => raw.length > 0 && raw.length <= GMAIL_RAW_DRAFT_LIMITS.bytes, "must be the draft's raw message"),
  thread_id: threadId.optional(),
});

/** Each operation's transport input. */
export const GOG_OPERATION_INPUTS = Object.freeze({
  "gmail.search": GOG_SEARCH_INPUT,
  "gmail.thread.get": GOG_THREAD_INPUT,
  "gmail.message.get": GOG_MESSAGE_INPUT,
  "gmail.draft.get": GOG_DRAFT_GET_INPUT,
  "gmail.labels.list": GOG_LABELS_INPUT,
  "gmail.modify": GOG_MODIFY_INPUT,
  "gmail.trash": GOG_TRASH_INPUT,
  "gmail.draft.save": GOG_DRAFT_SAVE_INPUT,
  "gmail.draft.delete": GOG_DRAFT_DELETE_INPUT,
  "gmail.draft.send": GOG_SEND_INPUT,
} as const satisfies Record<GoogleOperation, z.ZodType>);

export type GogOperationInput<O extends GoogleOperation> = z.infer<typeof GOG_OPERATION_INPUTS[O]>;

// ------------------------------------------------------------- invocation

export type GogFlag = readonly [name: string, value: string | true];

/** One gog process: the command, its flags and positionals, and what goes to stdin. */
export interface GogInvocation {
  command: GogCommand;
  flags: readonly GogFlag[];
  positionals: readonly string[];
  /** Root `--force`: skips gog's confirmation, which `--no-input` would otherwise refuse. */
  force: boolean;
  stdin: Uint8Array | null;
}

/** A refused argv value. The field is named; the value never is. */
export class GogArgvError extends Error {
  constructor(readonly field: string, readonly rule: string) {
    super(`${field}: ${rule}`);
    this.name = "GogArgvError";
  }
}

/** Controls (C0, C1, DEL, NUL), and the Unicode line and paragraph separators. */
const NOT_ARGV = /[\p{Cc}\u2028\u2029]/u;
/** A gog account alias: what `gog auth alias` accepts, never an address and never `auto`. */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isGogAccountAlias = (value: unknown): value is string =>
  typeof value === "string" && ALIAS.test(value) && value.toLowerCase() !== "auto";

function value(field: string, text: string): string {
  if (NOT_ARGV.test(text)) throw new GogArgvError(field, "holds a control character or a line break");
  return text;
}

/** A comma list gog splits itself, from values that each passed a validator and can hold no comma. */
function commaList(field: string, items: readonly string[]): string {
  for (const item of items) {
    if (item.length === 0 || item.includes(",") || item.includes("\\")) throw new GogArgvError(field, "an item cannot be part of a comma list");
  }
  return value(field, items.join(","));
}

/** Bare addr-specs: display names never reach gog's comma-split recipient flags. */
function addresses(field: string, mailboxes: readonly string[]): string {
  return commaList(field, mailboxes.map(mailbox => {
    const parsed = parseGoogleMailbox(mailbox);
    if (!parsed.ok) throw new GogArgvError(field, "is not a plain email address");
    return parsed.mailbox.address;
  }));
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function invocation(command: GogCommand, parts: Partial<Omit<GogInvocation, "command">> = {}): GogInvocation {
  return { command, flags: parts.flags ?? [], positionals: parts.positionals ?? [], force: parts.force ?? false, stdin: parts.stdin ?? null };
}

function draftFlags(input: { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string }): GogFlag[] {
  const flags: GogFlag[] = [];
  if (input.to) flags.push(["to", addresses("to", input.to)]);
  if (input.cc) flags.push(["cc", addresses("cc", input.cc)]);
  if (input.bcc) flags.push(["bcc", addresses("bcc", input.bcc)]);
  if (input.subject !== undefined) flags.push(["subject", value("subject", input.subject)]);
  return flags;
}

/**
 * The invocation for one validated operation input. A gmail.search is the
 * search alone: the transport reads each hit's thread with
 * `gmail.thread.get` afterwards (see `transport.ts`).
 */
export function gogInvocation<O extends GoogleOperation>(operation: O, input: GogOperationInput<O>): GogInvocation {
  switch (operation) {
    case "gmail.search": {
      const { query, limit, page_token } = input as GogOperationInput<"gmail.search">;
      const flags: GogFlag[] = [["ids-only", true], ["max", String(limit ?? GMAIL_LIMITS.searchDefault)]];
      if (page_token !== undefined) flags.push(["page", value("page_token", page_token)]);
      return invocation("gmail.search", { flags, positionals: [value("query", query)] });
    }
    case "gmail.thread.get":
      return invocation("gmail.thread.get", { positionals: [value("thread_id", (input as GogOperationInput<"gmail.thread.get">).thread_id)] });
    case "gmail.message.get":
      return invocation("gmail.get", {
        flags: [["format", "full"]], positionals: [value("message_id", (input as GogOperationInput<"gmail.message.get">).message_id)],
      });
    case "gmail.draft.get":
      return invocation("gmail.drafts.get", {
        flags: [["format", "raw"]], positionals: [value("draft_id", (input as GogOperationInput<"gmail.draft.get">).draft_id)],
      });
    case "gmail.labels.list":
      return invocation("gmail.labels.list");
    case "gmail.modify": {
      const { message_ids, add_label_ids, remove_label_ids } = input as GogOperationInput<"gmail.modify">;
      const flags: GogFlag[] = [];
      if (add_label_ids) flags.push(["add", commaList("add_label_ids", add_label_ids)]);
      if (remove_label_ids) flags.push(["remove", commaList("remove_label_ids", remove_label_ids)]);
      return invocation("gmail.batch.modify", { flags, positionals: message_ids!.map(id => value("message_ids", id)) });
    }
    case "gmail.trash": {
      const { message_ids } = input as GogOperationInput<"gmail.trash">;
      return invocation("gmail.trash", { positionals: message_ids!.map(id => value("message_ids", id)) });
    }
    case "gmail.draft.save": {
      const save = input as GogOperationInput<"gmail.draft.save">;
      if (save.action === "create") {
        const flags = [...draftFlags(save), ["body-file", "-"] as const];
        if (save.reply_to_message_id) flags.push(["reply-to-message-id", value("reply_to_message_id", save.reply_to_message_id)]);
        return invocation("gmail.drafts.create", { flags, stdin: utf8(save.body) });
      }
      const flags = draftFlags(save);
      if (save.body !== undefined) flags.push(["body-file", "-"]);
      return invocation("gmail.drafts.update", {
        flags, positionals: [value("draft_id", save.draft_id)], stdin: save.body !== undefined ? utf8(save.body) : null,
      });
    }
    case "gmail.draft.delete":
      return invocation("gmail.drafts.delete", { positionals: [value("draft_id", (input as GogOperationInput<"gmail.draft.delete">).draft_id)], force: true });
    case "gmail.draft.send": {
      const { raw, thread_id } = input as GogOperationInput<"gmail.draft.send">;
      const flags: GogFlag[] = [["raw-file", "-"]];
      if (thread_id !== undefined) flags.push(["thread-id", value("thread_id", thread_id)]);
      return invocation(GOG_SEND_COMMAND, { flags, stdin: raw });
    }
  }
  throw new GogArgvError("operation", "is not a catalog operation");
}

/**
 * The full argv for one invocation under one account alias. Refuses a flag
 * or positional the command's spec does not list, so a builder cannot drift
 * from the snapshot the pin checked.
 */
export function gogArgv(call: GogInvocation, account: string): string[] {
  if (!isGogAccountAlias(account)) throw new GogArgvError("account", "is not a gog account alias");
  const spec = GOG_COMMANDS[call.command];
  if (!spec) throw new GogArgvError("command", "is not a catalog command");
  const argv = ["--no-input", "--json", "--color=never", `--account=${account}`, `--enable-commands-exact=${call.command}`];
  if (!spec.write) argv.push("--readonly");
  if (call.command !== GOG_SEND_COMMAND) argv.push("--gmail-no-send");
  if (call.force) argv.push("--force");
  argv.push(...spec.path);
  for (const [name, flagValue] of call.flags) {
    if (!(spec.flags as readonly string[]).includes(name)) throw new GogArgvError(name, `is not a flag of ${call.command}`);
    argv.push(flagValue === true ? `--${name}` : `--${name}=${value(name, flagValue)}`);
  }
  const count = call.positionals.length;
  if (spec.variadic ? count < spec.positionals.length : count !== spec.positionals.length) {
    throw new GogArgvError("positionals", `${call.command} takes ${spec.variadic ? "at least " : ""}${spec.positionals.length} positional(s)`);
  }
  if (call.positionals.length > 0) argv.push("--", ...call.positionals.map(positional => value("positional", positional)));
  return argv;
}
