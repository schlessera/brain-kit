import type { Database } from "bun:sqlite";
import { retireChat, type RetireChatInput } from "../../src/ws/chat-lifecycle";
export const url = import.meta.url;
export function setup(db: Database) {
  return {
    expire(id: string, at: number) { db.query("UPDATE principals SET expires_at=? WHERE id=?").run(at, id); },
    retire(input: RetireChatInput) { return retireChat(db,input); },
  };
}
