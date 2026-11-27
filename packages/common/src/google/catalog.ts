/**
 * The Google operation catalog (plan §4): operation ids, the tools that group
 * them, each operation's base effect class and approval entity, the strict
 * input schemas every front door validates against, limits and error codes.
 *
 * v1 holds the Gmail operations. Calendar (#4221), and later Contacts and
 * Tasks (plan §13), join by adding their ids to {@link GOOGLE_OPERATIONS},
 * their tools to {@link GOOGLE_TOOL_NAMES}, a spec per operation and a schema
 * per tool; nothing here assumes Gmail is the only service.
 */
import { z } from "zod";
import { parseGoogleMailbox } from "./address.js";
import { BIDI_CONTROL, BODY_CONTROL } from "./encoding.js";
import {
  GMAIL_DRAFT_ID_PATTERN, GMAIL_MESSAGE_ID_PATTERN, GMAIL_THREAD_ID_PATTERN,
  GOOGLE_HOST_CURSOR_PATTERN, isGmailLabelId,
} from "./ids.js";

/** The services with operations in the catalog. */
export const GOOGLE_SERVICES = ["gmail"] as const;
export type GoogleService = typeof GOOGLE_SERVICES[number];

/**
 * The effect classes, lowest first (plan §1). The order is the escalation
 * order: a call's class is the highest of its base and every escalation.
 */
export const GOOGLE_EFFECT_CLASSES = ["read", "reversible", "irreversible"] as const;
export type GoogleEffectClass = typeof GOOGLE_EFFECT_CLASSES[number];

/** The higher of two classes. Escalation only: it never returns a class below either argument. */
export function escalateGoogleEffect(a: GoogleEffectClass, b: GoogleEffectClass): GoogleEffectClass {
  return GOOGLE_EFFECT_CLASSES.indexOf(a) >= GOOGLE_EFFECT_CLASSES.indexOf(b) ? a : b;
}

/** The two read views (plan §1, §6). `structured` does not taint; `content` does. */
export const GOOGLE_VIEWS = ["structured", "content"] as const;
export type GoogleView = typeof GOOGLE_VIEWS[number];

export const GMAIL_OPERATIONS = [
  "gmail.search",
  "gmail.thread.get", "gmail.message.get", "gmail.draft.get", "gmail.labels.list",
  "gmail.modify", "gmail.trash",
  "gmail.draft.save", "gmail.draft.delete", "gmail.draft.send",
] as const;
export type GmailOperation = typeof GMAIL_OPERATIONS[number];

/** Every operation id, `<service>.<verb>`. "Per-tool approval" in policy and the ledger is per operation id. */
export const GOOGLE_OPERATIONS = [...GMAIL_OPERATIONS] as const;
export type GoogleOperation = GmailOperation;

export const isGoogleOperation = (value: unknown): value is GoogleOperation =>
  typeof value === "string" && (GOOGLE_OPERATIONS as readonly string[]).includes(value);

export const GMAIL_TOOL_NAMES = Object.freeze({
  search: "brain_google_gmail_search",
  read: "brain_google_gmail_read",
  modify: "brain_google_gmail_modify",
  trash: "brain_google_gmail_trash",
  draft: "brain_google_gmail_draft",
  send: "brain_google_gmail_send",
} as const);
export type GmailToolName = typeof GMAIL_TOOL_NAMES[keyof typeof GMAIL_TOOL_NAMES];

/** Every tool, in roster order. Each is `brain_google_<service>_<verb>`. */
export const GOOGLE_TOOL_NAMES: readonly GoogleToolName[] = Object.freeze(Object.values(GMAIL_TOOL_NAMES));
export type GoogleToolName = GmailToolName;

export const isGoogleToolName = (value: unknown): value is GoogleToolName =>
  typeof value === "string" && (GOOGLE_TOOL_NAMES as readonly string[]).includes(value);

/**
 * What a standing approval attaches to (plan §4, "Approval entity"):
 * - `none`: nothing is remembered (reads, and irreversible operations, which
 *   always show a card);
 * - `action`: each modify action (`archive`, `label:<id>`, …), see
 *   {@link gmailModifyActions};
 * - `drafts`: the account's drafts as one entity;
 * - `never_remembered`: an approval is never remembered, whatever is asked (Q2).
 */
export const GOOGLE_APPROVAL_ENTITIES = ["none", "action", "drafts", "never_remembered"] as const;
export type GoogleApprovalEntity = typeof GOOGLE_APPROVAL_ENTITIES[number];

export interface GoogleOperationSpec {
  service: GoogleService;
  tool: GoogleToolName;
  /** The class before escalation. */
  base: GoogleEffectClass;
  entity: GoogleApprovalEntity;
}

export const GOOGLE_OPERATION_SPECS: Readonly<Record<GoogleOperation, GoogleOperationSpec>> = Object.freeze({
  "gmail.search": { service: "gmail", tool: GMAIL_TOOL_NAMES.search, base: "read", entity: "none" },
  "gmail.thread.get": { service: "gmail", tool: GMAIL_TOOL_NAMES.read, base: "read", entity: "none" },
  "gmail.message.get": { service: "gmail", tool: GMAIL_TOOL_NAMES.read, base: "read", entity: "none" },
  "gmail.draft.get": { service: "gmail", tool: GMAIL_TOOL_NAMES.read, base: "read", entity: "none" },
  "gmail.labels.list": { service: "gmail", tool: GMAIL_TOOL_NAMES.read, base: "read", entity: "none" },
  "gmail.modify": { service: "gmail", tool: GMAIL_TOOL_NAMES.modify, base: "reversible", entity: "action" },
  // Reversible only once its inverse is proven (plan §7); until then, irreversible.
  "gmail.trash": { service: "gmail", tool: GMAIL_TOOL_NAMES.trash, base: "irreversible", entity: "none" },
  "gmail.draft.save": { service: "gmail", tool: GMAIL_TOOL_NAMES.draft, base: "reversible", entity: "drafts" },
  "gmail.draft.delete": { service: "gmail", tool: GMAIL_TOOL_NAMES.draft, base: "irreversible", entity: "none" },
  "gmail.draft.send": { service: "gmail", tool: GMAIL_TOOL_NAMES.send, base: "irreversible", entity: "never_remembered" },
});

/** The bounds every Gmail input and result is held to. */
export const GMAIL_LIMITS = Object.freeze({
  /** Message or thread ids per modify or trash call (plan §4); policy `items_per_call` may be lower. */
  idsPerCall: 25,
  /** Label ids added, and removed, per modify call. */
  labelChangesPerCall: 10,
  /** Search hits per page: default and maximum (plan §9). */
  searchDefault: 10,
  searchMax: 25,
  /** Search query, characters, one line. */
  queryChars: 500,
  /** Recipients per address field of a draft. */
  recipientsPerField: 50,
  /** One mailbox as written, display name included. */
  mailboxChars: 320,
  /** A draft subject, characters, one line. */
  subjectChars: 500,
  /** A draft's plain-text body, characters. */
  draftBodyChars: 32_768,
  /** A read's text body: per message and per thread, characters (plan §9). */
  messageBodyChars: 32_768,
  threadBodyChars: 131_072,
  /** Content-view header values, snippets and attachment names, characters. */
  headerChars: 2_000,
  snippetChars: 500,
  attachmentNameChars: 255,
  /** Gmail's own cap on a label name, characters (code points). */
  labelNameChars: 225,
});

/**
 * Refusal codes. The plan names `invalid_input`, `unavailable`,
 * `policy_denied`, `not_found`, `draft_not_displayable`, `draft_locked`,
 * `recording_unavailable` and `transport_incompatible`. `outcome_unknown` is
 * a write that timed out or lost its answer and may have happened; it is
 * never retried. `approval_declined`, `forbidden`, `rate_limited` and
 * `upstream_error` follow the host GitHub tools for a declined or edited
 * card and gog's exit codes 6, 7 and 8 (plan §8).
 */
export const GOOGLE_ERROR_CODES = [
  "invalid_input", "unavailable", "policy_denied", "approval_declined", "not_found", "forbidden", "rate_limited",
  "upstream_error", "already_sent", "draft_not_displayable", "draft_locked", "recording_unavailable", "transport_incompatible",
  "outcome_unknown",
] as const;
export type GoogleErrorCode = typeof GOOGLE_ERROR_CODES[number];

/** One refusal: a code, a short machine reason, and a message for the model. */
export interface GoogleError {
  code: GoogleErrorCode;
  reason: string | null;
  message: string;
}

// ------------------------------------------------------------------ fields

/** C0/C1 controls and the Unicode line and paragraph separators: never in a one-line value. */
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

const oneLine = (max: number) => z.string().min(1).max(max)
  .refine(value => !NOT_ONE_LINE.test(value), "must be one line without control characters")
  .refine(value => value.trim().length > 0, "must not be blank");

const messageId = z.string().regex(GMAIL_MESSAGE_ID_PATTERN, "must be a Gmail message id");
const threadId = z.string().regex(GMAIL_THREAD_ID_PATTERN, "must be a Gmail thread id");
const draftId = z.string().regex(GMAIL_DRAFT_ID_PATTERN, "must be a Gmail draft id").describe("A Gmail draft id from an earlier result.");
const labelId = z.string().max(80).refine(isGmailLabelId, "must be a Gmail label id (INBOX, Label_123, …), never a label name");
const hostCursor = z.string().regex(GOOGLE_HOST_CURSOR_PATTERN, "must be a next_cursor from an earlier result");
const view = z.enum(GOOGLE_VIEWS).default("content")
  .describe("structured returns only ids, labels, dates, counts and flags and keeps the session untainted; content adds senders, recipients, subjects, snippets and bodies. Default content.");

const ids = <T extends z.ZodString>(id: T) => z.array(id).min(1).max(GMAIL_LIMITS.idsPerCall);
const labelIds = z.array(labelId).min(1).max(GMAIL_LIMITS.labelChangesPerCall);
const mailbox = z.string().min(3).max(GMAIL_LIMITS.mailboxChars)
  .refine(value => parseGoogleMailbox(value).ok, "must be one plain email address (no groups, comments or quoted local parts)");
const recipients = z.array(mailbox).min(1).max(GMAIL_LIMITS.recipientsPerField);
const subject = oneLine(GMAIL_LIMITS.subjectChars)
  .refine(value => !BIDI_CONTROL.test(value), "must not hold bidirectional embedding, override or isolate characters");
const body = z.string().max(GMAIL_LIMITS.draftBodyChars)
  .refine(value => !BODY_CONTROL.test(value), "must be plain text the send card can show (no control or bidirectional embedding, override or isolate characters)")
  .describe("The plain-text body. No HTML, no attachments.");

function duplicates(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (values ?? []).filter(value => seen.has(value) || !seen.add(value));
}

/** Exactly one of `message_ids` and `thread_ids`, without repeats. */
function oneTarget(input: { message_ids?: string[]; thread_ids?: string[] }, context: z.RefinementCtx): void {
  if ((input.message_ids === undefined) === (input.thread_ids === undefined)) {
    context.addIssue({ code: "custom", message: "give exactly one of message_ids and thread_ids", path: [] });
  }
  for (const key of ["message_ids", "thread_ids"] as const) {
    if (duplicates(input[key]).length > 0) context.addIssue({ code: "custom", message: "ids must not repeat", path: [key] });
  }
}

// ------------------------------------------------------------------ schemas

export const GMAIL_READ_TARGETS = ["thread", "message", "draft", "labels"] as const;
export type GmailReadTarget = typeof GMAIL_READ_TARGETS[number];
const READ_ID: Record<Exclude<GmailReadTarget, "labels">, RegExp> = {
  thread: GMAIL_THREAD_ID_PATTERN, message: GMAIL_MESSAGE_ID_PATTERN, draft: GMAIL_DRAFT_ID_PATTERN,
};

export const GMAIL_DRAFT_ACTIONS = ["create", "reply", "update", "delete"] as const;
export type GmailDraftAction = typeof GMAIL_DRAFT_ACTIONS[number];

/** Which draft fields each action takes; anything else is refused. */
const DRAFT_FIELDS: Record<GmailDraftAction, { required: readonly string[]; optional: readonly string[] }> = {
  create: { required: ["to", "subject", "body"], optional: ["cc", "bcc", "quote_message_id"] },
  reply: { required: ["message_id", "body"], optional: ["reply_all"] },
  update: { required: ["draft_id"], optional: ["to", "cc", "bcc", "subject", "body"] },
  delete: { required: ["draft_id"], optional: [] },
};

export const GMAIL_SEARCH_INPUT = z.strictObject({
  query: oneLine(GMAIL_LIMITS.queryChars).describe("Gmail search syntax, one line, such as category:promotions older_than:30d."),
  view,
  limit: z.number().int().min(1).max(GMAIL_LIMITS.searchMax).optional().describe(`Threads per page, 1 to ${GMAIL_LIMITS.searchMax}; default ${GMAIL_LIMITS.searchDefault}.`),
  cursor: hostCursor.optional().describe("The next_cursor of the previous page."),
});

export const GMAIL_READ_INPUT = z.strictObject({
  target: z.enum(GMAIL_READ_TARGETS).describe("What to read: one thread, one message, one draft, or the account's labels."),
  id: z.string().max(64).optional().describe("The thread, message or draft id; omitted for labels."),
  view: view.describe("As for search. The label list is always structured."),
}).superRefine((input, context) => {
  if (input.target === "labels") {
    if (input.id !== undefined) context.addIssue({ code: "custom", message: "labels take no id", path: ["id"] });
  } else if (input.id === undefined || !READ_ID[input.target].test(input.id)) {
    context.addIssue({ code: "custom", message: `must be a Gmail ${input.target} id`, path: ["id"] });
  }
});

export const GMAIL_MODIFY_INPUT = z.strictObject({
  message_ids: ids(messageId).optional(),
  thread_ids: ids(threadId).optional().describe("Threads are resolved to their messages when the call runs."),
  add_label_ids: labelIds.optional().describe("Label ids to add. Adding INBOX unarchives, UNREAD marks unread, STARRED stars."),
  remove_label_ids: labelIds.optional().describe("Label ids to remove. Removing INBOX archives, UNREAD marks read, STARRED unstars."),
}).superRefine((input, context) => {
  oneTarget(input, context);
  const add = input.add_label_ids ?? [];
  const remove = input.remove_label_ids ?? [];
  if (add.length + remove.length === 0) context.addIssue({ code: "custom", message: "add or remove at least one label", path: [] });
  if (duplicates([...new Set(add), ...new Set(remove)]).length > 0) context.addIssue({ code: "custom", message: "a label cannot be added and removed at once", path: [] });
  for (const key of ["add_label_ids", "remove_label_ids"] as const) {
    if (duplicates(input[key]).length > 0) context.addIssue({ code: "custom", message: "label ids must not repeat", path: [key] });
  }
});

export const GMAIL_TRASH_INPUT = z.strictObject({
  message_ids: ids(messageId).optional(),
  thread_ids: ids(threadId).optional(),
}).superRefine(oneTarget);

export const GMAIL_DRAFT_INPUT = z.strictObject({
  action: z.enum(GMAIL_DRAFT_ACTIONS).describe("create a new draft, reply to a message, update a draft, or delete one."),
  draft_id: draftId.optional(),
  message_id: messageId.optional().describe("For reply: the message replied to. The host resolves recipients and quoted text from its thread."),
  reply_all: z.boolean().optional().describe("For reply: include every recipient of the message replied to."),
  quote_message_id: messageId.optional().describe("For create: a message whose text the draft quotes, as a forward."),
  to: recipients.optional(),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: subject.optional(),
  body: body.optional(),
}).superRefine((input, context) => {
  const fields = DRAFT_FIELDS[input.action];
  const given = Object.keys(input).filter(key => key !== "action" && input[key as keyof typeof input] !== undefined);
  for (const key of fields.required) {
    if (!given.includes(key)) context.addIssue({ code: "custom", message: `${input.action} needs ${key}`, path: [key] });
  }
  for (const key of given) {
    if (!fields.required.includes(key) && !fields.optional.includes(key)) {
      context.addIssue({ code: "custom", message: `${input.action} does not take ${key}`, path: [key] });
    }
  }
  if (input.action === "update" && given.length === 1) {
    context.addIssue({ code: "custom", message: "update changes at least one of to, cc, bcc, subject and body", path: [] });
  }
});

export const GMAIL_SEND_INPUT = z.strictObject({ draft_id: draftId });

/** Each tool's strict input. The host's own checks (policy, hidden labels, pre-reads) apply after these. */
export const GOOGLE_INPUT_SCHEMAS = Object.freeze({
  [GMAIL_TOOL_NAMES.search]: GMAIL_SEARCH_INPUT,
  [GMAIL_TOOL_NAMES.read]: GMAIL_READ_INPUT,
  [GMAIL_TOOL_NAMES.modify]: GMAIL_MODIFY_INPUT,
  [GMAIL_TOOL_NAMES.trash]: GMAIL_TRASH_INPUT,
  [GMAIL_TOOL_NAMES.draft]: GMAIL_DRAFT_INPUT,
  [GMAIL_TOOL_NAMES.send]: GMAIL_SEND_INPUT,
} as const satisfies Record<GoogleToolName, z.ZodObject>);

export type GmailSearchInput = z.infer<typeof GMAIL_SEARCH_INPUT>;
export type GmailReadInput = z.infer<typeof GMAIL_READ_INPUT>;
export type GmailModifyInput = z.infer<typeof GMAIL_MODIFY_INPUT>;
export type GmailTrashInput = z.infer<typeof GMAIL_TRASH_INPUT>;
export type GmailDraftInput = z.infer<typeof GMAIL_DRAFT_INPUT>;
export type GmailSendInput = z.infer<typeof GMAIL_SEND_INPUT>;
export type GoogleToolInput<T extends GoogleToolName> = z.infer<typeof GOOGLE_INPUT_SCHEMAS[T]>;

const READ_OPERATION: Record<GmailReadTarget, GmailOperation> = {
  thread: "gmail.thread.get", message: "gmail.message.get", draft: "gmail.draft.get", labels: "gmail.labels.list",
};

/** The operation a validated tool input names. */
export function googleOperationOf<T extends GoogleToolName>(tool: T, input: GoogleToolInput<T>): GoogleOperation {
  switch (tool) {
    case GMAIL_TOOL_NAMES.search: return "gmail.search";
    case GMAIL_TOOL_NAMES.read: return READ_OPERATION[(input as GmailReadInput).target];
    case GMAIL_TOOL_NAMES.modify: return "gmail.modify";
    case GMAIL_TOOL_NAMES.trash: return "gmail.trash";
    case GMAIL_TOOL_NAMES.draft: return (input as GmailDraftInput).action === "delete" ? "gmail.draft.delete" : "gmail.draft.save";
    case GMAIL_TOOL_NAMES.send: return "gmail.draft.send";
  }
  throw new Error(`unknown Google tool ${String(tool)}`);
}

/** A validated call: the tool, its operation and its parsed input. */
export type GoogleToolCall = { [T in GoogleToolName]: { tool: T; operation: GoogleOperation; input: GoogleToolInput<T> } }[GoogleToolName];

export type GoogleToolCallResult =
  | { ok: true; call: GoogleToolCall }
  | { ok: false; error: GoogleError & { code: "invalid_input" }; issues: string[] };

/**
 * Validates one tool call as every front door must: a known tool name, then
 * its strict schema, then the operation it names. Issues name the field and
 * the rule, never echo the value.
 */
export function parseGoogleToolCall(tool: string, input: unknown): GoogleToolCallResult {
  if (!isGoogleToolName(tool)) {
    return { ok: false, error: { code: "invalid_input", reason: "unknown_tool", message: "This is not a Google tool." }, issues: [] };
  }
  const parsed = GOOGLE_INPUT_SCHEMAS[tool].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.length ? issue.path.join(".") : "input"}: ${issue.message}`);
    return { ok: false, error: { code: "invalid_input", reason: "schema", message: `The input was refused: ${issues.join("; ")}.` }, issues };
  }
  const call = { tool, input: parsed.data, operation: googleOperationOf(tool, parsed.data as never) } as GoogleToolCall;
  return { ok: true, call };
}

/**
 * The approval entities of a modify (plan §4): `archive` / `unarchive`
 * (INBOX), `mark_read` / `mark_unread` (UNREAD), `star` / `unstar` (STARRED),
 * and `label:<id>` / `unlabel:<id>` for every other label. Sorted, unique.
 */
export function gmailModifyActions(input: Pick<GmailModifyInput, "add_label_ids" | "remove_label_ids">): string[] {
  const named = new Map<string, [add: string, remove: string]>([
    ["INBOX", ["unarchive", "archive"]], ["UNREAD", ["mark_unread", "mark_read"]], ["STARRED", ["star", "unstar"]],
  ]);
  const actions = new Set<string>();
  for (const id of input.add_label_ids ?? []) actions.add(named.get(id)?.[0] ?? `label:${id}`);
  for (const id of input.remove_label_ids ?? []) actions.add(named.get(id)?.[1] ?? `unlabel:${id}`);
  return [...actions].sort();
}
