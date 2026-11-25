/**
 * Search cursors for the standalone `brain google gmail search` (#4208).
 *
 * A search result never carries Google's page token: it carries a host
 * cursor (`gc_…`, plan §4 and §6), and the host keeps the token. A terminal
 * has no session to keep it in, so the standalone CLI keeps its cursors in
 * one small file in the Google home it already checked (owner-only, outside
 * every brain): `brain-search-cursors.json`, mode 0600, written whole and
 * renamed into place. It is read only as a regular 0600 file of this user's,
 * opened without following a link or waiting on a FIFO, and only up to its
 * bound; anything else reads as no cursors.
 *
 * A cursor names one account and one query (by its SHA-256, never its text),
 * and lives for an hour, or until more than {@link GOOGLE_CURSOR_LIMIT} newer
 * ones exist; it can be used again until then, so a failed page can be
 * retried. A cursor that is unknown,
 * expired, for another account or for another query refuses as
 * `invalid_input`. The file holds no message data; losing it only ends
 * paging. Two processes writing at once can lose each other's newest cursor,
 * which also only ends paging. A successful `brain google connect` forgets
 * every cursor and starts a new connection generation, so an alias pointed at
 * another account inherits none: a search takes the generation before it
 * asks Google, and its next page's cursor is kept only while that generation
 * still stands. (A connect landing in the few milliseconds between a
 * search's read and rename of the file can still lose to it; that cursor
 * expires within the hour.)
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isGoogleHostCursor } from "@schlessera/brain-common/internal/google-operations";

export const GOOGLE_CURSOR_FILE = "brain-search-cursors.json";
export const GOOGLE_CURSOR_LIMIT = 64;
export const GOOGLE_CURSOR_TTL_MS = 60 * 60 * 1000;
/** A file larger than this is not ours: it is read as empty. */
const MAX_BYTES = 256 * 1024;
const PAGE_TOKEN = /^[A-Za-z0-9_+/=.-]{1,512}$/;

interface CursorEntry {
  account: string;
  query: string;
  page_token: string;
  created_at: number;
}

/** A connect has started a new generation since the search began: its page token is not kept. */
export class GoogleCursorStale extends Error {
  constructor() {
    super("the Google connection changed during the search");
    this.name = "GoogleCursorStale";
  }
}

export interface GoogleCursorStore {
  /** The current connection generation: take it before the search reaches Google. */
  generation(): string;
  /** Mints a cursor for the next page of `query`. Throws {@link GoogleCursorStale} when `generation` no longer stands, or when the file cannot be written. */
  mint(account: string, query: string, pageToken: string, generation: string): string;
  /** The page token a cursor stands for, or null when it stands for none for this account and query. */
  resolve(account: string, query: string, cursor: string): string | null;
  /** Forgets every cursor and starts a new generation: a connect may have pointed an alias at another account. Throws when the file cannot be written. */
  clear(): void;
}

const queryKey = (query: string) => createHash("sha256").update(query, "utf8").digest("hex");

function isEntry(value: unknown): value is CursorEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.account === "string" && typeof entry.query === "string" && /^[0-9a-f]{64}$/.test(entry.query)
    && typeof entry.page_token === "string" && PAGE_TOKEN.test(entry.page_token)
    && typeof entry.created_at === "number" && Number.isSafeInteger(entry.created_at);
}

export function googleCursorStore(home: string, now: () => number = Date.now): GoogleCursorStore {
  const path = join(home, GOOGLE_CURSOR_FILE);

  /** The file's text, or null unless it is a small regular 0600 file of this user's. */
  function contents(): string | null {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return null; }
    try {
      const stats = fstatSync(fd);
      const uid = process.getuid?.();
      if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || (uid !== undefined && stats.uid !== uid) || stats.size > MAX_BYTES) return null;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      for (let read; length <= MAX_BYTES && (read = readSync(fd, bytes, length, MAX_BYTES + 1 - length, null)) > 0;) length += read;
      return length > MAX_BYTES ? null : bytes.subarray(0, length).toString("utf8");
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** The generation a missing or unreadable file stands for. */
  const NONE = "none";

  function read(): { generation: string; entries: Map<string, CursorEntry> } {
    const empty = (generation = NONE) => ({ generation, entries: new Map<string, CursorEntry>() });
    const text = contents();
    if (text === null) return empty();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return empty(); }
    if (typeof parsed !== "object" || parsed === null) return empty();
    const { generation, cursors } = parsed as { generation?: unknown; cursors?: unknown };
    if (typeof generation !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(generation)) return empty();
    if (typeof cursors !== "object" || cursors === null) return empty(generation);
    const at = now();
    const live = Object.entries(cursors).filter((entry): entry is [string, CursorEntry] =>
      isGoogleHostCursor(entry[0]) && isEntry(entry[1]) && at - entry[1].created_at < GOOGLE_CURSOR_TTL_MS && entry[1].created_at <= at);
    return { generation, entries: new Map(live.sort((a, b) => a[1].created_at - b[1].created_at)) };
  }

  function write(generation: string, entries: Map<string, CursorEntry>): void {
    const kept = [...entries].slice(-GOOGLE_CURSOR_LIMIT);
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, generation, cursors: Object.fromEntries(kept) }), { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  return {
    generation: () => read().generation,
    mint(account, query, pageToken, generation) {
      if (!PAGE_TOKEN.test(pageToken)) throw new TypeError("not a page token");
      const current = read();
      if (current.generation !== generation) throw new GoogleCursorStale();
      const cursor = `gc_${randomBytes(24).toString("base64url")}`;
      current.entries.set(cursor, { account, query: queryKey(query), page_token: pageToken, created_at: now() });
      write(current.generation, current.entries);
      return cursor;
    },
    resolve(account, query, cursor) {
      if (!isGoogleHostCursor(cursor)) return null;
      const entry = read().entries.get(cursor);
      if (!entry || entry.account !== account || entry.query !== queryKey(query)) return null;
      return entry.page_token;
    },
    clear() {
      write(randomBytes(18).toString("base64url"), new Map());
    },
  };
}
