/** #3071: real socket admission, backend application policy and parent effects.
 * Speech and worker inference are scripted; application/permission/index paths
 * execute production code against an isolated fictional corpus. */
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrainApplicationResult, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend.js";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import { boundaryPlanner } from "../src/brain/application.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createUiDb } from "../src/db/client.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { WsHost } from "../src/ws/host.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { installNativeHostFixtures } from "./helpers/native-host-fixture.js";
import { fakeLiveProvider, SILENCE } from "./helpers/live-conversation.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testPrincipal } from "./helpers/principal.js";

const { createFixtureHostBoundary } = installNativeHostFixtures();

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Expected host policy milestone was not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const backendId of ["claude", "pi"] as const) {
  for (const modality of ["typed", "live", "contextual"] as const) {
    for (const action of ["permitted", "confirm", "deny", "protected"] as const) {
      test(`${backendId} ${modality}: ${action} uses ordinary policy and exact parent effects`, async () => {
        const root = mkdtempSync(join(tmpdir(), "odysseus-live-policy-"));
        cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
        const config = join(root, "brain.config.ts");
        writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
        const db = createUiDb(":memory:");
        const live = fakeLiveProvider({ contextualTasks: "supported" });
        const sent: any[] = [];
        const frames = (type: string) => sent.filter(frame => frame.type === type);
        const ws = { send: (data: string) => sent.push(JSON.parse(data)) } as WSContext;
        let request: StartTurnRequest | undefined;
        let applied: BrainApplicationResult | undefined;
        let captured: BrainApplicationResult | undefined;
        let baseText: string | undefined;
        let calls = 0;
        // Both real backend policies are used; only inference is replaced.
        const allowedTools = backendId === "claude"
          ? ["Read", "mcp__brain-ui__brain_add", ...(action === "permitted" || action === "protected" ? ["mcp__brain-ui__write_file"] : [])]
          : ["read", "brain_add", ...(action === "permitted" || action === "protected" ? ["write_file"] : [])];
        const production = backendId === "claude" ? createClaudeBackend({ brainPath: root, allowedTools })
          : createPiBackend({ brainPath: root, allowedTools });
        const backend = makeFakeBackend({ id: backendId, capabilities: { permissions: true }, startTurn: async req => {
          calls++;
          request = req;
          req.bridge.emit({ type: "session_info", sessionId: "ithaca-policy", isNew: true });
          baseText = (await req.bridge.readBrainBase!("notes/quick-note-water.md")).content;
          captured = await req.bridge.applyBrain!({ operation: "add", title: "Departure watch", content: "Eumaeus takes the first watch.", type: "note" });
          applied = await req.bridge.applyBrain!({ operation: "write", path: action === "protected" ? "brain.config.ts" : "notes/policy-raft.md", content: "Odysseus repairs the raft.\n", expectedBaseHash: null });
          req.bridge.emit({ type: "text_delta", text: applied.message });
          req.bridge.emit({ type: "result", sessionId: "ithaca-policy", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
        } });
        backend.brainApplicationPolicy = production.brainApplicationPolicy;
        const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db),
          applicationPlanner: boundaryPlanner(createFixtureHostBoundary({ brainPath: root })), conversationProvider: live.provider, isPrincipalAuthorized: () => true });
        const handlers = createWsHandlers(host, testPrincipal());
        const send = (frame: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
        try {
          await handlers.onOpen(undefined as never, ws);
          // Both modalities use the same principal, profile, payload and policy.
          const text = "Read the mast decision, capture the watch and repair the raft.";
          let opened: any;
          if (modality === "typed") send({ type: "chat_message", text });
          else {
            send({ type: "conversation_start", contextualTasks: modality === "contextual" });
            await until(() => frames("conversation_opened").length === 1);
            opened = frames("conversation_opened")[0];
            const scope = { conversationId: opened.conversationId, epoch: opened.epoch };
            send({ type: "conversation_audio", ...scope, utteranceId: "watch", sequence: 0, rate: 16000, pcm: SILENCE });
            await until(() => live.sessions[0]!.audio.length === 1);
            live.sessions[0]!.emit({ kind: "input_fragment", utteranceId: "watch", sequence: 0, text, finalization: "unknown", certainty: "unknown", origin: "unknown" });
            await until(() => frames("conversation_event").length === 1);
            if (modality === "contextual") live.sessions[0]!.emit({ kind: "work_requested", handle: "watch-native" });
            else send({ type: "conversation_commit", ...scope, utteranceId: "watch", requestId: "watch-request", text });
          }
          await until(() => request !== undefined || frames("result").length > 0);
          expect(request, "LIVE_POLICY_BACKEND_ADMITTED").toBeDefined();
          expect(request!.posture, "LIVE_POLICY_NO_NARROWER_POSTURE").toBeUndefined();
          expect(request!.noGrantSurface, "LIVE_POLICY_SCREEN_SURFACE").toBeUndefined();
          if (action === "confirm" || action === "deny") {
            await until(() => frames("tool_approval_request").length === 1 || applied !== undefined);
            expect(applied, "LIVE_POLICY_NO_AUTO_GRANT").toBeUndefined();
            expect(frames("tool_approval_request"), "LIVE_POLICY_REAL_CARD").toHaveLength(1);
            expect(existsSync(join(root, "notes/policy-raft.md"))).toBe(false);
            const card = frames("tool_approval_request")[0];
            // Neither an explicit voice-channel grant nor uncertain recognition
            // is a screen decision. Keep waiting with no fixture effect.
            send({ type: "tool_approval", toolUseId: card.toolUseId, turnId: card.turnId, channel: "voice" });
            if (opened) live.sessions[0]!.emit({ kind: "input_fragment", utteranceId: "watch", sequence: 1, text: "yes, always allow", finalization: "unknown", certainty: "unknown", origin: "unknown" });
            await new Promise(resolve => setTimeout(resolve, 25));
            expect(applied, "LIVE_POLICY_SPEECH_NEVER_GRANTS").toBeUndefined();
            expect(host.coordinator.pendingApprovals.has(card.toolUseId)).toBe(true);
            send(action === "confirm" ? { type: "tool_approval", toolUseId: card.toolUseId, turnId: card.turnId, channel: "card" }
              : { type: "tool_denial", toolUseId: card.toolUseId, turnId: card.turnId, channel: "card", message: "Keep the raft unchanged." });
          }
          if (action === "permitted" || action === "protected") {
            await until(() => applied !== undefined || frames("tool_approval_request").length > 0);
            expect(frames("tool_approval_request"), "LIVE_POLICY_NO_FALSE_PROMPT").toHaveLength(0);
          }
          await until(() => applied !== undefined);
          expect(baseText, "LIVE_POLICY_READ_EXECUTED").toContain("cask");
          expect(captured!.ok, "LIVE_POLICY_CURATED_WRITE_EXECUTED").toBe(true);
          expect(captured!.changes).toHaveLength(1);
          expect(readFileSync(join(root, captured!.changes[0]!.path), "utf8")).toContain("Eumaeus takes the first watch.");
          const permitted = action === "permitted" || action === "confirm";
          expect(applied!.ok, "LIVE_POLICY_EFFECT_MATCHES_DECISION").toBe(permitted);
          expect(existsSync(join(root, "notes/policy-raft.md"))).toBe(permitted);
          if (permitted) expect(readFileSync(join(root, "notes/policy-raft.md"), "utf8")).toBe("Odysseus repairs the raft.\n");
          else expect(applied!.changes).toEqual([]);
          expect(readFileSync(config, "utf8")).toContain("defineConfig");
          if (action === "permitted" || action === "protected") expect(frames("tool_approval_request"), "LIVE_POLICY_NO_FALSE_PROMPT").toHaveLength(0);
          await until(() => frames("result").length === 1);
          if (opened) {
            await until(() => frames("conversation_work").some(frame => frame.state === "completed"));
            send({ type: "conversation_start", conversationId: opened.conversationId, contextualTasks: modality === "contextual" });
            await until(() => frames("conversation_opened").length === 2);
            expect(calls, "LIVE_POLICY_NO_EFFECT_REPLAY").toBe(1);
          }
        } finally {
          host.coordinator.reset(); await host.close(); db.close(); rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}
