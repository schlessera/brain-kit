/**
 * A real operational database, brain root and schedule service on a fake
 * clock. Odysseus is the fixture world; the clock starts on its pinned date.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUiDb } from "../../src/db/client.js";
import { createPrincipal, type Principal } from "../../src/db/principals.js";
import { createScheduleService, type ExecutionPolicy, type ScheduleServiceOptions } from "../../src/schedules/service.js";

export const POLICY: ExecutionPolicy = { backendId: "fixture", profileId: null, inferenceOrigins: ["https://inference.example"] };

export const SCOPE = {
  operation: "Report outstanding Ithaca checks",
  tools: [{ name: "brain_read", inputs: { path: "notes/ithaca.md" } }],
  targets: ["notes/ithaca.md"],
  egress: [],
  variableInputs: [],
};
export const PROMPT = "Read notes/ithaca.md and report outstanding checks. Do not change files or use network tools.";

export interface ScheduleFixture {
  db: Database;
  dbPath: string;
  root: string;
  clock: { now: number };
  owner: Principal;
  agent: Principal;
  service(overrides?: Partial<ScheduleServiceOptions>): ReturnType<typeof createScheduleService>;
  close(): void;
}

export function scheduleFixture(start = Date.parse("2026-07-12T06:00:00Z")): ScheduleFixture {
  const dir = mkdtempSync(join(tmpdir(), "brain-schedule-"));
  const root = join(dir, "brain");
  mkdirSync(join(root, "notes"), { recursive: true });
  const dbPath = join(dir, "ui.db");
  const db = createUiDb(dbPath);
  const clock = { now: start };
  const owner = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 * 24 * 365 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Telemachus agent", createdBy: owner.id, ttlSeconds: 3600 * 24 * 365 });
  return {
    db, dbPath, root, clock, owner, agent,
    service: (overrides = {}) => createScheduleService(db, {
      brainRoot: root, now: () => clock.now, executionPolicy: () => POLICY, gitIgnored: () => false, ...overrides,
    }),
    close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export function cronDefinition(cron = "0 7 * * 1-5", extra: Record<string, unknown> = {}) {
  return { prompt: PROMPT, when: { kind: "cron", cron, timeZone: "Europe/Athens", ...extra }, scope: SCOPE };
}

export function atDefinition(when: string, extra: Record<string, unknown> = {}) {
  return { prompt: PROMPT, when: { kind: "at", at: when, timeZone: "Europe/Athens", ...extra }, scope: SCOPE };
}
