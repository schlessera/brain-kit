/**
 * Shapes of the identifiers Google mints for Gmail (plan §6, step 2, and
 * "What structured means, exactly"). Taken from a read-only probe of a real
 * account, shapes only; no value from it is recorded anywhere.
 *
 * A value that matches one of these shapes is a Google-minted identifier a
 * structured result may carry. Anything else is refused at input and dropped
 * from a structured result: no other text can pass as an id.
 */

/** Gmail message and thread ids: lower-case hex (16 characters in practice). */
export const GMAIL_MESSAGE_ID_PATTERN = /^[0-9a-f]{1,32}$/;
/** Thread ids share the message id shape. */
export const GMAIL_THREAD_ID_PATTERN = GMAIL_MESSAGE_ID_PATTERN;
/**
 * Draft ids: one lower-case letter, an optional `-` or `:` separator, then
 * digits (`r` + digits, `r-` + 19 digits and `s:` + 19 digits are observed).
 */
export const GMAIL_DRAFT_ID_PATTERN = /^[a-z][-:]?[0-9]{1,24}$/;
/** User label ids: `Label_` and digits. The name is the owner's; the id is Google's. */
export const GMAIL_USER_LABEL_ID_PATTERN = /^Label_[0-9]{1,24}$/;
/** System label ids: upper case, digits and underscores. Known or not, they are Google's. */
export const GMAIL_SYSTEM_LABEL_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The closed list of system label ids brain-kit knows. An upper-case id not
 * on it is an unknown system label: it is accepted as input (Google may add
 * labels), escalates every modify that names it, and is dropped from
 * structured results, whose system labels are a closed enum.
 */
export const GMAIL_SYSTEM_LABELS = [
  "INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "SPAM", "TRASH", "CHAT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
  // Superstars: the starred variants Gmail's settings can enable.
  "YELLOW_STAR", "ORANGE_STAR", "RED_STAR", "PURPLE_STAR", "BLUE_STAR", "GREEN_STAR",
  "RED_BANG", "ORANGE_GUILLEMET", "YELLOW_BANG", "GREEN_CHECK", "BLUE_INFO", "PURPLE_QUESTION",
  "RED_CIRCLE", "GREEN_CIRCLE",
] as const;
export type GmailSystemLabel = typeof GMAIL_SYSTEM_LABELS[number];

/**
 * The only system labels a modify may add or remove and stay reversible
 * (plan §4): archive and unarchive, read and unread, star and unstar.
 */
export const GMAIL_REVERSIBLE_SYSTEM_LABELS = ["INBOX", "UNREAD", "STARRED"] as const satisfies readonly GmailSystemLabel[];

const KNOWN_SYSTEM = new Set<string>(GMAIL_SYSTEM_LABELS);

/** How a label id reads: a user label, a known system label, or an upper-case id brain-kit does not know. */
export type GmailLabelKind = "user" | "system" | "unknown_system";

const text = (value: unknown): value is string => typeof value === "string";

export const isGmailMessageId = (value: unknown): value is string => text(value) && GMAIL_MESSAGE_ID_PATTERN.test(value);
export const isGmailThreadId = (value: unknown): value is string => text(value) && GMAIL_THREAD_ID_PATTERN.test(value);
export const isGmailDraftId = (value: unknown): value is string => text(value) && GMAIL_DRAFT_ID_PATTERN.test(value);

/** The kind of a label id, or null when it has neither label shape. */
export function gmailLabelKind(value: unknown): GmailLabelKind | null {
  if (!text(value)) return null;
  if (GMAIL_USER_LABEL_ID_PATTERN.test(value)) return "user";
  if (!GMAIL_SYSTEM_LABEL_ID_PATTERN.test(value)) return null;
  return KNOWN_SYSTEM.has(value) ? "system" : "unknown_system";
}

/** Any label id shape, unknown system labels included: what an input may name. */
export const isGmailLabelId = (value: unknown): value is string => gmailLabelKind(value) !== null;

/** A user label or a known system label: what a structured result may carry. */
export const isKnownGmailLabelId = (value: unknown): value is string => {
  const kind = gmailLabelKind(value);
  return kind === "user" || kind === "system";
};

/** A sha256 digest in lower-case hex: a draft fingerprint or a sent-message digest. */
export const GOOGLE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const isGoogleDigest = (value: unknown): value is string => text(value) && GOOGLE_DIGEST_PATTERN.test(value);

/**
 * A page cursor the host mints and maps to Google's page token in its own
 * session table (plan §4, §6). Opaque to the model; Google's token never
 * leaves the host. Minting belongs to the host: 16 or more random bytes,
 * base64url, after the prefix.
 */
export const GOOGLE_HOST_CURSOR_PREFIX = "gc_";
export const GOOGLE_HOST_CURSOR_PATTERN = /^gc_[A-Za-z0-9_-]{16,64}$/;
export const isGoogleHostCursor = (value: unknown): value is string => text(value) && GOOGLE_HOST_CURSOR_PATTERN.test(value);
