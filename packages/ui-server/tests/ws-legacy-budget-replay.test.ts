import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LocalExchange, SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { parseImportedTrack, summarizeTrack } from "@schlessera/brain-geo";
import { createHistory } from "../../ui-backend-claude/src/history.js";
import { getPiHistory } from "../../ui-backend-pi/src/history.js";
import { createUiDb } from "../src/db/client.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { WsHost } from "../src/ws/host.js";
import { withLocalContext } from "../src/ws/local-exchanges.js";
import { withTrackFiles } from "../src/tracks/read.js";

// Literal 0.43.1 prompt suffix; do not derive legacy evidence from its replacement.
const LEGACY = "\n\n[Host inference capabilities: Built-in inference only; provider and tool spend is not metered. These are list-price usage limits, not subscription invoices. turn: price unknown; warn $5; stop $10; unpriced token stop 10. session: $1.5542415250000001 known lower bound; warn $50; stop $100; unpriced token stop 100. day: $1.5542415250000001 known lower bound; warn $500; stop $1000; unpriced token stop 1000; resets 2026-07-13T00:00:00.000Z. Warnings are visual only in voice posture; do not speak them. Stops preserve partial work for review.]";
const exchange: LocalExchange = { id: "ithaca-stats", command: "stats", prompt: "Stats", answer: [{ kind: "receipt", title: "Corpus", rows: [{ k: "documents", v: "412" }] }], context: "Documents: 412" };

for (const adapter of ["claude", "pi"] as const) {
  test(`${adapter} legacy budget replay repairs local exchange order and source, effort and files without rewriting transcript`, async () => {
    const root = await mkdtemp(join(tmpdir(), "odysseus-legacy-budget-"));
    const brain = join(root, "brain");
    await mkdir(brain);
    const db = createUiDb(":memory:");
    const catalog = createSessionCatalog(() => db);
    const host = new WsHost({ catalog, registry: createStaticBackendRegistry([makeFakeBackend({ id: "claude" })], "claude") });
    try {
      const path = ".brain/scratch/ithaca.geojson";
      const imported = parseImportedTrack('{"type":"LineString","coordinates":[[20.7,38.3],[20.71,38.31]]}');
      const { geometry: _geometry, ...summary } = summarizeTrack(imported.track, { kind: "file", path });
      const files: SharedFileMeta[] = [{ name: "ithaca.geojson", path, bytes: 80, mediaType: "application/geo+json", detected: "geojson", summary: { ...summary, waypointCount: 0, waypointOmitted: 0 } }];
      const text = "Which route returns to Ithaca?";
      const prompt = withLocalContext(withTrackFiles(text, files), [exchange]) + LEGACY;
      let sessionId = "legacy-session", snapshot: string, load: () => Promise<import("@schlessera/brain-ui-sdk/protocol").SessionHistoryMessage[]>;
      let nativePath: string | undefined;
      const entries: SessionMessage[] = [
        { type: "user", uuid: "legacy-user", session_id: sessionId, message: { content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null },
        { type: "assistant", uuid: "legacy-answer", session_id: sessionId, message: { content: [{ type: "text", text: "Review the route." }] }, parent_tool_use_id: null },
      ] as SessionMessage[];
      if (adapter === "claude") {
        snapshot = JSON.stringify(entries);
        load = () => createHistory({ brainPath: brain, getSessionMessagesFn: async () => entries }).getHistory(sessionId);
      } else {
        const sessionDir = join(root, "sessions");
        const sm = SessionManager.create(brain, sessionDir);
        sessionId = sm.getSessionId();
        sm.appendMessage({ role: "user", content: prompt, timestamp: 1 });
        sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Review the route." }], api: "openai-completions", provider: "openai", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
        nativePath = sm.getSessionFile()!;
        snapshot = await readFile(nativePath, "utf8");
        load = () => getPiHistory(brain, sessionId, sessionDir);
      }
      expect(catalog.recordLocalExchange!(sessionId, exchange, true)).toBe(true);
      catalog.recordMessageSource!(sessionId, text, "voice-dictate", { thinkingLevel: "high", turnId: "legacy-turn", files });
      const backendHistory = await load();
      expect(backendHistory[0]!.content).toBe(prompt);
      const replay = host.prepareHistory(sessionId, backendHistory);
      expect(replay.map(message => message.content), "LEGACY_LOCAL_EXCHANGE_ORDER").toEqual(["Stats", "", text, "Review the route."]);
      expect(replay.find(message => message.content.startsWith(text)), "LEGACY_MESSAGE_METADATA").toMatchObject({ source: "voice-dictate", thinkingLevel: "high", files });
      expect(replay[1]!.localAnswer?.exchangeId).toBe(exchange.id);
      expect(backendHistory[0]!.content, "NORMALIZED_TRANSCRIPT_UNCHANGED").toBe(prompt);
      expect(nativePath ? await readFile(nativePath, "utf8") : JSON.stringify(entries), "PROVIDER_TRANSCRIPT_UNCHANGED").toBe(snapshot);
    } finally { host.close(); db.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("legacy strip is limited to the exact trailing user suffix and works without local exchanges", () => {
  const db = createUiDb(":memory:");
  const host = new WsHost({ catalog: createSessionCatalog(() => db), registry: createStaticBackendRegistry([makeFakeBackend({ id: "claude" })], "claude") });
  try {
    const contents = [
      "Odysseus" + LEGACY,
      "Odysseus" + LEGACY + "\nMore user text",
      "Odysseus" + LEGACY + "\n",
      "Odysseus" + LEGACY.replace("Stops preserve partial work for review.", "Different host prose."),
      "[Host inference capabilities: user-authored example]",
      "Odysseus" + LEGACY.replace("turn: price unknown", "turn: $1e-7 known lower bound").replace("warn $5", "warn $5; WARNING threshold reached"),
    ];
    expect(host.prepareHistory("legacy", contents.map(content => ({ role: "user" as const, content, toolCalls: [] }))).map(message => message.content)).toEqual(["Odysseus", ...contents.slice(1)]);
    expect(host.prepareHistory("legacy", [{ role: "assistant", content: contents[0]!, toolCalls: [] }])[0]!.content).toBe(contents[0]);
    const warning = "Odysseus" + LEGACY.replace("turn: price unknown", "turn: $1e-7 known lower bound").replace("stop 10. session", "stop 10; WARNING threshold reached. session");
    expect(host.prepareHistory("legacy", [{ role: "user", content: warning, toolCalls: [] }])[0]!.content).toBe("Odysseus");
  } finally { host.close(); db.close(); }
});
