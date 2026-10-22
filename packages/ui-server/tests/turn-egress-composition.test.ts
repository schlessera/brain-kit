import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeOutwardPlan, prepareOutwardPlan } from "@schlessera/brain-ui-sdk/internal";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createUiDb } from "../src/db/client";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";

test.each(["claude", "pi"] as const)("a governed %s turn's network composition and durable egress record", async kind => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-turn-egress-")), brain = join(root, "brain");
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  // The fixture origin is an outward host: only the classified read may reach it without a card.
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\noutward:\n  hosts: [127.0.0.1]\n---\nAthena reviews outward calls.\n");
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const store = createActivityStore(db), stream = createActivityStream(store);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  let proxyDir: string | undefined, output: string | undefined, workerExit: number | undefined, workerErrors = "";
  const backend = makeFakeBackend({ id: kind, startTurn: async request => {
    request.bridge.emit({ type: "session_info", sessionId: `voyage-${kind}`, isNew: true });
    proxyDir = request.workerSandbox?.egress?.dir;
    if (proxyDir) {
      const command = "gh issue view 7 --repo odysseus/voyage";
      observeOutwardPlan(prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input: { command } }),
        { bridge: request.bridge, toolName: "Bash", toolUseId: "view-voyage", input: { command }, decision: { behavior: "allow" } });
      // Asynchronous: the proxy serves from this process while the worker runs.
      const child = Bun.spawn(workerCommand({ brainPath: brain, startupView: request.workerStartupView, sandbox: request.workerSandbox, env: { PATH: "/usr/bin:/bin" },
        egress: { proxyDir }, command: ["/usr/bin/curl", "--silent", "--fail", "--max-time", "5", `${origin.url.href}voyage?private=odysseus-query`] }),
      { env: {}, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      workerExit = code; workerErrors = stderr; output = stdout;
      request.bridge.emit({ type: "tool_result", sessionId: `voyage-${kind}`, toolUseId: "view-voyage", output: "", isError: false });
    }
    request.bridge.emit({ type: "result", sessionId: `voyage-${kind}`, durationMs: 1, numTurns: 1, isError: false });
  } });
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], kind), catalog: createSessionCatalog(() => db),
    activity: { store, stream, governance: input => { recordGovernanceEvent(db, input); } },
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); } });
  try {
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Odysseus checks the harbour.", attachments: [] });
    const records = queryGovernanceEvents(db, { kinds: ["egress_connection"], limit: 10 });
    if (kind === "pi") {
      expect(proxyDir, "TURN_EGRESS_PI_UNCHANGED_UNTIL_ITS_RELAY").toBeUndefined();
      expect(records).toEqual([]);
      return;
    }
    expect(proxyDir, "TURN_EGRESS_GOVERNED_CLAUDE_COMPOSED").toBeDefined();
    expect(workerExit, `TURN_EGRESS_BACKEND_BRIDGE_TRACKS_CLASSIFICATION ${workerErrors}`).toBe(0);
    expect(output).toBe("Ithaca");
    expect(records, "TURN_EGRESS_COMPOSED_DURABLE_RECORD").toHaveLength(1);
    expect(records[0]).toMatchObject({ actor: "interactive", profile: "governed", sessionId: "voyage-claude",
      payload: { method: "GET", host: "127.0.0.1", port: origin.port, path: "/voyage", outcome: "completed" } });
    expect(JSON.stringify(records)).not.toContain("odysseus-query");
    expect(existsSync(proxyDir!), "TURN_EGRESS_PROXY_REMOVED_AT_TURN_END").toBe(false);
  } finally { host.close(); origin.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); }
});
