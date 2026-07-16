/**
 * JSON-per-session persistence for the Gemini backend.
 *
 * Each file keeps both the raw @google/genai Content[] required for exact
 * model resume (including thoughtSignature metadata) and the incrementally
 * normalized wire history used by brain-ui. Files are written atomically via a
 * sibling .tmp file and rename; malformed/unknown sessions are ignored by list
 * and history reads.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";

import type { Content } from "@google/genai";
import type { ChatSession, SessionHistoryMessage } from "@brainform/ui-sdk/server";

export interface StoredSession {
  id: string;
  model: string;
  providerId?: string;
  createdAt: number;
  lastActiveAt: number;
  title: string | null;
  contents: Content[];
  messages: SessionHistoryMessage[];
}

export interface CreateStoredSessionOptions {
  id: string;
  model: string;
  providerId?: string;
  now?: number;
}

export interface GeminiSessionStore {
  readonly directory: string;
  create(options: CreateStoredSessionOptions): StoredSession;
  load(sessionId: string): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  listSessions(): Promise<ChatSession[]>;
  getHistory(sessionId: string): Promise<SessionHistoryMessage[]>;
}

/** Create one in-memory session; persistence stays lazy until save(). */
export function createStoredSession(options: CreateStoredSessionOptions): StoredSession {
  const now = options.now ?? Date.now();
  return {
    id: options.id,
    model: options.model,
    ...(options.providerId ? { providerId: options.providerId } : {}),
    createdAt: now,
    lastActiveAt: now,
    title: null,
    contents: [],
    messages: [],
  };
}

export function createGeminiSessionStore(directory: string): GeminiSessionStore {
  return {
    directory,

    create(options: CreateStoredSessionOptions): StoredSession {
      return createStoredSession(options);
    },

    async load(sessionId: string): Promise<StoredSession | null> {
      const path = sessionPath(directory, sessionId);
      if (!path) return null;
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
        return isStoredSession(parsed) && parsed.id === sessionId ? parsed : null;
      } catch {
        return null;
      }
    },

    async save(session: StoredSession): Promise<void> {
      const path = sessionPath(directory, session.id);
      if (!path) throw new Error(`Invalid Gemini session id: ${session.id}`);
      await mkdir(directory, { recursive: true });
      const tmpPath = `${path}.tmp`;
      await writeFile(tmpPath, JSON.stringify(session, null, 2) + "\n", "utf-8");
      await rename(tmpPath, path);
    },

    async listSessions(): Promise<ChatSession[]> {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return [];
      }

      const sessions = await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name): Promise<ChatSession | null> => {
            try {
              const parsed: unknown = JSON.parse(
                await readFile(join(directory, name), "utf-8")
              );
              if (!isStoredSession(parsed)) return null;
              return {
                id: parsed.id,
                title: parsed.title,
                createdAt: parsed.createdAt,
                lastActiveAt: parsed.lastActiveAt,
                totalCostUsd: 0,
                numTurns: parsed.messages.filter((message) => message.role === "user").length,
              };
            } catch {
              return null;
            }
          })
      );

      return sessions
        .filter((session): session is ChatSession => session !== null)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    },

    async getHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
      const session = await this.load(sessionId);
      return session?.messages ?? [];
    },
  };
}

function sessionPath(directory: string, sessionId: string): string | null {
  // New session ids are UUIDs. Keep resume/history reads from turning an
  // arbitrary caller-provided id into a path traversal.
  if (
    sessionId.length === 0 ||
    sessionId.length > 200 ||
    !/^[A-Za-z0-9._-]+$/.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".."
  ) {
    return null;
  }
  return join(directory, `${sessionId}.json`);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StoredSession>;
  return (
    typeof session.id === "string" &&
    typeof session.model === "string" &&
    (session.providerId === undefined || typeof session.providerId === "string") &&
    typeof session.createdAt === "number" &&
    typeof session.lastActiveAt === "number" &&
    (session.title === null || typeof session.title === "string") &&
    Array.isArray(session.contents) &&
    Array.isArray(session.messages)
  );
}
