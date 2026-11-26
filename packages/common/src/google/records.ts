/**
 * The normalised records a Google transport produces (plan §3, §8): what a
 * codec has validated out of the transport's output, before any projection.
 *
 * Transport-neutral. The gog codecs (#4205) build them from gog's JSON, and a
 * direct REST implementation would build the same records from Gmail v1
 * responses. A record holds everything either view needs, so it is never
 * shown as it is: the host projects it with `projection.ts`, which decides
 * what a structured or a content result may carry. Every string here that a
 * third party could have written (headers, snippets, bodies, attachment
 * names) is untrusted.
 *
 * Shapes the codec must already have checked: `id`, `thread_id` and
 * `label_ids` are the strings Gmail returned; `internal_date` is RFC 3339 in
 * UTC, converted from Gmail's millisecond `internalDate`; `size_estimate` is
 * Gmail's estimate in bytes. The projections validate them again and drop
 * what fails.
 */

/** One attachment's metadata. Inbound attachments are metadata only (Q14). */
export interface GmailAttachmentRecord {
  filename: string | null;
  mime_type: string | null;
  size: number | null;
}

/** One message, as a thread read, a message read or a draft read returns it. */
export interface GmailMessageRecord {
  id: string;
  thread_id: string;
  label_ids: readonly string[];
  internal_date: string | null;
  size_estimate: number | null;
  /** Header values as written (unfolded; encoded words decoded by the codec). Untrusted. */
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string | null;
  /** Raw RFC threading headers for host composition; never added to projections. */
  message_id_header?: string | null;
  references_header?: string | null;
  /** The Date header as written. Untrusted: the sender chose it. */
  date: string | null;
  snippet: string | null;
  /** The text body; for an HTML-only message the codec's text conversion. Untrusted. */
  body_text: string | null;
  attachments: readonly GmailAttachmentRecord[];
}

export interface GmailThreadRecord {
  id: string;
  messages: readonly GmailMessageRecord[];
}

export interface GmailDraftRecord {
  id: string;
  /** The draft's message, or null when the read returned only the id. */
  message: GmailMessageRecord | null;
}

/** One label from the account's label list. */
export interface GmailLabelRecord {
  id: string;
  /** The owner's label name (ruling 5), or Gmail's name for a system label. */
  name: string | null;
  messages_total: number | null;
  messages_unread: number | null;
  threads_total: number | null;
  threads_unread: number | null;
}

/**
 * One search hit: a thread. `label_ids` is the union of the thread's message
 * labels, which `hidden_labels` filtering relies on (plan §5).
 */
export interface GmailSearchHitRecord {
  thread_id: string;
  message_count: number | null;
  label_ids: readonly string[];
  /** The newest message's internal date, RFC 3339. */
  latest_internal_date: string | null;
  size_estimate: number | null;
  has_attachment: boolean | null;
  /** The newest message's headers and snippet. Untrusted. */
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
}

export interface GmailSearchPageRecord {
  hits: readonly GmailSearchHitRecord[];
  /** Google's page token. The host keeps it and hands the model a host cursor instead; no projection carries it. */
  next_page_token: string | null;
  result_size_estimate: number | null;
}
