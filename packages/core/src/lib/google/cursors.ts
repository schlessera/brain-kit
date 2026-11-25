/**
 * Search cursors for the standalone `brain google gmail search` (#4208).
 *
 * A search result never carries Google's page token: it carries a host
 * cursor (`gc_…`, plan §4 and §6), and the host keeps the token. A terminal
 * has no session to keep it in, so the standalone CLI keeps its cursors in
 * the Google home it already checked (owner-only, outside every brain), in
 * two small files, each mode 0600, written whole and renamed into place:
 *
 * - `brain-search-cursors.json`, the cursors;
 * - `brain-search-generation`, the connection generation: a random value only
 *   a successful `brain google connect` writes.
 *
 * Each is read only as a regular 0600 file of this user's, opened without
 * following a link or waiting on a FIFO, and only up to its bound; anything
 * else reads as no cursors, or as no generation. A search that finds no
 * generation writes a fresh one before it starts, so a generation is never a
 * value an earlier one could have had.
 *
 * A cursor names one account alias, one query (by its SHA-256, never its
 * text) and the generation its search began under, and lives for an hour, or
 * until more than {@link GOOGLE_CURSOR_LIMIT} newer ones exist; it can be used
 * again until then, so a failed page can be retried. A cursor that is
 * unknown, expired, for another alias or query, or from another generation
 * refuses as `invalid_input`. A connect starts a new generation, so an alias
 * pointed at another account inherits no cursor, a search running across it
 * returns no page (`connection_changed`: the search takes the generation
 * before it resolves its cursor and checks it again when Google has
 * answered), and no write of the cursor file can bring an old generation's
 * cursor back: every use checks the generation the cursor was minted under. The files hold no message data;
 * losing them only ends paging. Two searches writing the cursor file at once
 * can lose each other's newest cursor, which also only ends paging.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isGoogleHostCursor } from "@schlessera/brain-common/internal/google-operations";

export const GOOGLE_CURSOR_FILE = "brain-search-cursors.json";
export const GOOGLE_GENERATION_FILE = "brain-search-generation";
export const GOOGLE_CURSOR_LIMIT = 64;
export const GOOGLE_CURSOR_TTL_MS = 60 * 60 * 1000;
/** A cursor file larger than this is not ours: it is read as empty. */
const MAX_BYTES = 256 * 1024;
const PAGE_TOKEN = /^[A-Za-z0-9_+/=.-]{1,512}$/;
const GENERATION = /^[A-Za-z0-9_-]{1,64}$/;

interface CursorEntry {
  account: string;
  query: string;
  generation: string;
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
  /** The current connection generation, or null when there is none or it cannot be read. */
  generation(): string | null;
  /** The generation a search runs under: the current one, else a fresh one written now. Throws when it cannot be written. */
  begin(): string;
  /** Mints a cursor for the next page of `query`. Throws {@link GoogleCursorStale} when `generation` no longer stands, or when the file cannot be written. */
  mint(account: string, query: string, pageToken: string, generation: string): string;
  /** The page token a cursor minted under `generation` stands for, or null when it stands for none for this alias and query. */
  resolve(account: string, query: string, cursor: string, generation: string): string | null;
  /** Starts a new generation, voiding every cursor: a connect may have pointed an alias at another account. Throws when the file cannot be written. */
  clear(): void;
}

const queryKey = (query: string) => createHash("sha256").update(query, "utf8").digest("hex");

function isEntry(value: unknown): value is CursorEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.account === "string" && typeof entry.query === "string" && /^[0-9a-f]{64}$/.test(entry.query)
    && typeof entry.generation === "string" && GENERATION.test(entry.generation)
    && typeof entry.page_token === "string" && PAGE_TOKEN.test(entry.page_token)
    && typeof entry.created_at === "number" && Number.isSafeInteger(entry.created_at);
}

/** A file's text, or null unless it is a regular 0600 file of this user's of at most `max` bytes. */
function privateText(path: string, max: number): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stats = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || (uid !== undefined && stats.uid !== uid) || stats.size > max) return null;
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    for (let read; length <= max && (read = readSync(fd, bytes, length, max + 1 - length, null)) > 0;) length += read;
    return length > max ? null : bytes.subarray(0, length).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Writes `text` beside `path` and renames it into place, mode 0600. */
function replace(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function googleCursorStore(home: string, now: () => number = Date.now): GoogleCursorStore {
  const path = join(home, GOOGLE_CURSOR_FILE);
  const generationPath = join(home, GOOGLE_GENERATION_FILE);

  function generation(): string | null {
    const text = privateText(generationPath, 64)?.trim();
    return text && GENERATION.test(text) ? text : null;
  }

  const fresh = () => {
    const value = randomBytes(18).toString("base64url");
    replace(generationPath, `${value}\n`);
    return value;
  };

  /** The live cursors of `current`, oldest first. */
  function read(current: string): Map<string, CursorEntry> {
    const text = privateText(path, MAX_BYTES);
    if (text === null) return new Map();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return new Map(); }
    const cursors = typeof parsed === "object" && parsed !== null ? (parsed as { cursors?: unknown }).cursors : undefined;
    if (typeof cursors !== "object" || cursors === null) return new Map();
    const at = now();
    const live = Object.entries(cursors).filter((entry): entry is [string, CursorEntry] =>
      isGoogleHostCursor(entry[0]) && isEntry(entry[1]) && entry[1].generation === current
      && at - entry[1].created_at < GOOGLE_CURSOR_TTL_MS && entry[1].created_at <= at);
    return new Map(live.sort((a, b) => a[1].created_at - b[1].created_at));
  }

  return {
    generation,
    begin: () => generation() ?? fresh(),
    mint(account, query, pageToken, began) {
      if (!PAGE_TOKEN.test(pageToken)) throw new TypeError("not a page token");
      if (generation() !== began) throw new GoogleCursorStale();
      const entries = read(began);
      const cursor = `gc_${randomBytes(24).toString("base64url")}`;
      entries.set(cursor, { account, query: queryKey(query), generation: began, page_token: pageToken, created_at: now() });
      replace(path, JSON.stringify({ version: 1, cursors: Object.fromEntries([...entries].slice(-GOOGLE_CURSOR_LIMIT)) }));
      return cursor;
    },
    resolve(account, query, cursor, began) {
      if (!isGoogleHostCursor(cursor) || generation() !== began) return null;
      // Checked on every use: a cursor file written by a search that began before a connect brings nothing back.
      const entry = read(began).get(cursor);
      if (!entry || entry.account !== account || entry.query !== queryKey(query)) return null;
      return entry.page_token;
    },
    clear() {
      fresh();
    },
  };
}
