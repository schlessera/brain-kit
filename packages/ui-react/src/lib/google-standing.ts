/**
 * Standing Gmail permissions (#4212): the owner-only HTTP rows mapped to the
 * kit's `GoogleApprovalList` and `GoogleAllowanceList` props, the times the
 * kit asks its host to format, and how a failed request reads on screen.
 *
 * The rows are the internal routes' (`docs/http-api.md`, "Google approval
 * management"). They carry no label names, so a label action always shows its
 * id. A row this module cannot name is never dropped silently: it is counted,
 * and the kit's list says how many could not be shown.
 */
import type { GoogleAllowanceListProps, GoogleApprovalListProps, GoogleHostTime, GoogleStandingAction } from "@schlessera/brain-ui-kit";
import type { ChatMessage } from "../stores/chat-state.js";
import type { BrainUiServices } from "../root.js";
import { ApiRequestError } from "./api-client.js";

/**
 * A successful answer that is not the route's envelope: not JSON, not an
 * object, or without the list or the revoke flag. It is a failed read, never
 * the route's absence: this server mounts the routes unconditionally
 * (`createGoogleApprovalRoutes`, `packages/ui-server/src/app.ts:1312-1316`),
 * and an unmounted `/api` GET is answered 200 with the client shell when a
 * static root is served (`conditional SPA fallback serves deep links`,
 * `packages/ui-server/tests/http-inventory.test.ts:70-84`) and 404
 * otherwise, so only a 404 says a route is not there.
 */
class GoogleStandingAnswerError extends Error {
  constructor(message = "The server's answer was not understood.") {
    super(message);
    this.name = "GoogleStandingAnswerError";
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The four owner-only routes, through the root's account-lifetime guarded
 * request, as `storageApi` reaches Storage's: internal routes stay out of the
 * public `BrainApi`. A failure carries the route's own `error` text and its
 * status; a malformed success is a `GoogleStandingAnswerError`.
 */
export function googleStandingApi(root: Pick<BrainUiServices, "request" | "apiBase">) {
  async function call(path: string, body?: { id: string }): Promise<Record<string, unknown>> {
    const response = await root.request(`${root.apiBase()}${path}`, {
      cache: "no-store",
      credentials: "include",
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    const read = record(parsed);
    if (!response.ok) throw new ApiRequestError(typeof read?.error === "string" ? read.error : `HTTP ${response.status}`, response.status);
    if (!read) throw new GoogleStandingAnswerError();
    return read;
  }
  const list = async (path: string, key: "approvals" | "allowances") => {
    const rows = (await call(path))[key];
    if (!Array.isArray(rows)) throw new GoogleStandingAnswerError();
    return rows as unknown[];
  };
  const revoke = async (path: string, id: string) => {
    const revoked = (await call(path, { id })).revoked;
    if (typeof revoked !== "boolean") throw new GoogleStandingAnswerError("The revoke answer was not understood.");
    return revoked;
  };
  const session = (id: string) => `/sessions/${encodeURIComponent(id)}/google/allowances`;
  return {
    approvals: () => list("/google/approvals", "approvals"),
    revokeApproval: (id: string) => revoke("/google/approvals/revoke", id),
    allowances: (sessionId: string) => list(session(sessionId), "allowances"),
    /** `cardId` is the granting card's: it revokes every change that card allowed in this chat. */
    revokeAllowance: (sessionId: string, cardId: string) => revoke(`${session(sessionId)}/revoke`, cardId),
  };
}

/**
 * The changes one card's allowance admits in all: the backend's
 * `GOOGLE_SESSION_ALLOWANCE_LIMITS.items` (`GOOGLE_SESSION_ALLOWANCE_LIMITS`,
 * `packages/common/src/google/decision.ts:67`), which every row of a card
 * starts from. The rows carry only what is left, and this package does not
 * depend on common, so it is restated here; a unit test holds it to the source.
 */
export const GOOGLE_ALLOWANCE_ITEMS = 100;

const MODIFY = new Set(["archive", "unarchive", "mark_read", "mark_unread", "star", "unstar"]);

/** The kit's action for one stored (operation, entity), or `null` for one it has no words for. */
export function standingAction(operation: unknown, entity: unknown): GoogleStandingAction | null {
  if (typeof operation !== "string" || typeof entity !== "string") return null;
  if (operation === "gmail.draft.save") return entity === "drafts" ? { kind: "drafts" } : null;
  if (operation !== "gmail.modify") return null;
  if (MODIFY.has(entity)) return { kind: entity as "archive" };
  const label = /^(label|unlabel):(.+)$/.exec(entity);
  return label ? { kind: label[1] as "label" | "unlabel", labelId: label[2]!, labelName: null } : null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const clock = (at: Date) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
const full = (at: Date) => `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()} at ${clock(at)}`;

/** "since Sat 11 Jul" (with the year when it is not this year), in this device's time. */
export function sinceTime(ms: number, now: number): GoogleHostTime {
  const at = new Date(ms), year = at.getFullYear() === new Date(now).getFullYear() ? "" : ` ${at.getFullYear()}`;
  return { short: `${WEEKDAYS[at.getDay()]!.slice(0, 3)} ${at.getDate()} ${MONTHS[at.getMonth()]!.slice(0, 3)}${year}`, full: full(at) };
}

/**
 * "until 18:02" today; an allowance lasts at most a day, so a later day adds
 * only its weekday ("Mon 18:02"). An end on an earlier day, which the host
 * still lists while this device's clock runs ahead of it, adds its date
 * ("Sat 11 Jul 23:59"): a bare weekday would read as the coming one.
 */
export function untilTime(ms: number, now: number): GoogleHostTime {
  const at = new Date(ms);
  if (new Date(now).toDateString() === at.toDateString()) return { short: clock(at), full: full(at) };
  if (ms < now) return { short: `${sinceTime(ms, now).short} ${clock(at)}`, full: full(at) };
  return { short: `${WEEKDAYS[at.getDay()]!.slice(0, 3)} ${clock(at)}`, full: full(at) };
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Remembered approvals grouped under each account address, newest first, the
 * accounts in address order. `unshown` counts rows the kit has no words for.
 */
export function approvalAccounts(rows: readonly unknown[], now: number): { accounts: GoogleApprovalListProps["accounts"]; unshown: number } {
  const groups = new Map<string, Array<{ id: string; action: GoogleStandingAction; at: number }>>();
  let unshown = 0;
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const action = standingAction(row.operation, row.entity);
    if (!action || !text(row.id) || !text(row.account_identity) || !time(row.approved_at)) { unshown++; continue; }
    const list = groups.get(row.account_identity) ?? [];
    list.push({ id: row.id, action, at: row.approved_at });
    groups.set(row.account_identity, list);
  }
  const accounts = [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([address, list]) => ({
    address,
    approvals: list.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).map(({ id, action, at }) => ({ id, action, since: sinceTime(at, now) })),
  }));
  return { accounts, unshown };
}

/**
 * A chat's allowance rows as one grant per granting card, in the host's order.
 * The rows of a card share its budget and its end, so the card shows the
 * least left and the earliest end any of them reports. A card with a row the
 * kit cannot name is not shown at all: its Revoke would revoke more than it says.
 *
 * The host decides which cards are live, so a card it lists is shown even when
 * its end has passed by this device's clock. `nextEnd` is the earliest shown
 * end still after `now`; `pastEnds` are the shown ends at or before `now`,
 * each once, earliest first.
 */
export function allowanceGrants(rows: readonly unknown[], now: number): { grants: GoogleAllowanceListProps["grants"]; unshown: number; nextEnd: number | null; pastEnds: number[] } {
  const cards = new Map<string, { address: string; actions: GoogleStandingAction[]; remaining: number; until: number; broken: boolean }>();
  let unshown = 0;
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    if (!text(row.granted_card_id)) { unshown++; continue; }
    const action = standingAction(row.operation, row.entity);
    const card = cards.get(row.granted_card_id) ?? { address: text(row.account_identity) ? row.account_identity : "", actions: [], remaining: Infinity, until: Infinity, broken: false };
    cards.set(row.granted_card_id, card);
    if (!action || !text(row.account_identity) || !time(row.expires_at) || !time(row.remaining_items)) { card.broken = true; continue; }
    if (!card.actions.some(known => JSON.stringify(known) === JSON.stringify(action))) card.actions.push(action);
    card.remaining = Math.min(card.remaining, Math.max(0, row.remaining_items));
    card.until = Math.min(card.until, row.expires_at);
  }
  const grants: GoogleAllowanceListProps["grants"] = [];
  let nextEnd: number | null = null;
  const past = new Set<number>();
  for (const [id, card] of cards) {
    if (card.broken || card.actions.length === 0) { unshown++; continue; }
    grants.push({ id, address: card.address, actions: card.actions, remaining: card.remaining, limit: GOOGLE_ALLOWANCE_ITEMS, until: untilTime(card.until, now) });
    if (card.until <= now) past.add(card.until);
    else nextEnd = nextEnd === null ? card.until : Math.min(nextEnd, card.until);
  }
  return { grants, unshown, nextEnd, pastEnds: [...past].sort((a, b) => a - b) };
}

/**
 * What a failed request means for a list. The routes answer every storage
 * failure with 503: the kit's unavailable state. A missing or non-owner
 * principal, a route this server does not have (404), or (for a chat) a chat
 * this owner cannot reach (404) hides the list: it is the owner's private
 * data. Anything else, a malformed success included, is the kit's failed
 * state.
 */
export function standingFailure(error: unknown, hide: readonly number[]): "hidden" | "unavailable" | "failed" {
  if (!(error instanceof ApiRequestError)) return "failed";
  if (error.status === 503) return "unavailable";
  return hide.includes(error.status) ? "hidden" : "failed";
}

/**
 * The Gmail write tools that spend or grant a chat allowance: the reversible
 * ones, `modify` and `draft` (`GMAIL_TOOL_NAMES`,
 * `packages/common/src/google/catalog.ts:54-61`). Trash and send are
 * irreversible and never standing. Restated, as the limit is, because this
 * package does not depend on common; a unit test holds them to the source.
 */
export const GOOGLE_ALLOWANCE_WRITE_TOOLS: readonly string[] = ["brain_google_gmail_modify", "brain_google_gmail_draft"];

/**
 * How many of those calls in a chat's transcript have their result: the
 * signal that an allowance may have been spent or granted. A call's result is
 * its `output` (`setToolResult`); `status: "complete"` alone also marks a call
 * whose input only finished streaming. The name may carry an MCP prefix.
 */
export function completedAllowanceWrites(messages: readonly ChatMessage[] | undefined): number {
  let count = 0;
  for (const message of messages ?? []) {
    for (const tool of message.toolCalls) {
      const bare = tool.name.startsWith("mcp__") ? tool.name.split("__").at(-1)! : tool.name;
      if (tool.output !== undefined && GOOGLE_ALLOWANCE_WRITE_TOOLS.includes(bare)) count++;
    }
  }
  return count;
}
