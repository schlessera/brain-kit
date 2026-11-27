import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { startFixtureTurn } from "./fixtures/worker-input-fixture.js";

test("the fixture marks its copied startup view ready before the backend starts, so probes time backend startup apart from it (#4286)", async () => {
  const brain = join(mkdtempSync(join(tmpdir(), "ithaca-fixture-")), "brain");
  try {
    mkdirSync(join(brain, "notes"), { recursive: true });
    writeFileSync(join(brain, "notes", "harbour.md"), "Odysseus reaches Ithaca on 2026-07-12.\n");
    const order: string[] = [];
    const backend = { async startTurn(request: StartTurnRequest) { order.push(request.workerStartupView ? "backend_start_with_view" : "backend_start"); } } as unknown as AgentBackend;
    await startFixtureTurn(backend, brain, {} as StartTurnRequest, { viewReady: () => order.push("view_ready") });
    expect(order, "PI_STARTUP_PROBE_CLOCK_STARTS_AFTER_THE_COPIED_VIEW").toEqual(["view_ready", "backend_start_with_view"]);
  } finally { rmSync(join(brain, ".."), { recursive: true, force: true }); }
});
