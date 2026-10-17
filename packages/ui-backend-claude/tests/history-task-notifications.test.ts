import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { getSessionMessages, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHistory } from "../src/history";
import { transcriptPaths } from "../src/transcript-archive";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const notification = '<task-notification>\n<task-id>ithaca</task-id>\n<status>stopped</status>\n<summary>Background shell command didn\'t finish before the previous session ended</summary>\n</task-notification>';

function fixture(runtime: boolean, text = notification, attachments = false) {
  const root = mkdtempSync("/tmp/odysseus-history-notice-"); roots.push(root);
  const brainPath = join(root, "brain"), config = join(root, "config"); mkdirSync(brainPath); mkdirSync(config);
  const env = { CLAUDE_CONFIG_DIR: config }, session = crypto.randomUUID();
  const entries = [{ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: text }, ...(runtime ? { origin: { kind: "task-notification" } } : {}) },
    { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: [{ type: "text", text: "  Keep Penelope's exact words.\n" }, ...(attachments ? [{ type: "image", source: {} }] : [])] } }];
  const { live } = transcriptPaths(brainPath, env); mkdirSync(live, { recursive: true });
  writeFileSync(join(live, `${session}.jsonl`), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  // The installed SDK removes origin: the normalization input intentionally
  // matches that API rather than smuggling provenance into its return type.
  const sdkEntries = entries.map(entry => ({ type: entry.type, uuid: entry.uuid, message: entry.message, session_id: session, parent_tool_use_id: null, parent_agent_id: null })) as SessionMessage[];
  const history = createHistory({ brainPath, env, getSessionMessagesFn: (async () => sdkEntries) as typeof getSessionMessages });
  return { history, session, sdkEntries };
}

test("runtime task notices never merge into the next user's words or images", async () => {
  const { history, session } = fixture(true, notification, true);
  expect(await history.getHistory(session), "RUNTIME_TASK_NOTICE_IS_NOT_USER_TEXT").toEqual([{ role: "user", content: "  Keep Penelope's exact words.\n", toolCalls: [], attachmentCount: 1 }]);
});

test("genuine standalone task XML stays verbatim without runtime provenance", async () => {
  const { history, session } = fixture(false);
  expect((await history.getHistory(session))[0]!.content).toBe(notification + "\n\n  Keep Penelope's exact words.\n");
});

for (const text of ["a task-notification example", "```xml\n" + notification + "\n```", "<system-reminder>\n" + notification + "\n</system-reminder>"]) test(`ordinary notification-like text stays verbatim: ${text.slice(0, 25)}`, async () => {
  const { history, session } = fixture(false, text);
  expect((await history.getHistory(session))[0]!.content).toBe(text + "\n\n  Keep Penelope's exact words.\n");
});


test("a changed SDK message cannot borrow stale runtime provenance", async () => {
  const { history, session, sdkEntries } = fixture(true);
  sdkEntries[0]!.message = { role: "user", content: "Athena changed this entry." };
  expect((await history.getHistory(session))[0]!.content).toBe("Athena changed this entry.\n\n  Keep Penelope's exact words.\n");
});
