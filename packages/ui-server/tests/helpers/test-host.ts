/**
 * Per-test-file WsHost wiring. The production composition root is
 * `createApp()`; tests that drive the WebSocket dispatch directly build the
 * same pieces here — an isolated SQLite db, a static backend registry, one
 * WsHost — and vary configuration by ordinary arguments instead of env or
 * module mutation.
 */
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import {
  createStaticBackendRegistry,
  type BackendRegistry,
} from "../../src/agent/backend";
import { createUiDb } from "../../src/db/client";
import { WsHost, type ToolPermissions } from "../../src/ws/host";
import { createSessionCatalog } from "../../src/ws/session-catalog";
import { handleClientMessage as dispatch } from "../../src/ws/dispatch";
import type { WSContext } from "../../src/ws/clients";
import { testAuthorization, testPrincipal } from "./principal";

let db: Database | null = null;
let dbPath: string | null = null;
let registry: BackendRegistry | null = null;
let host: WsHost | null = null;
let maxConcurrent = 3;
let toolPermissions: ToolPermissions | null = null;

/** Open (or reuse) the test database at `path`; ":memory:" works too. */
export function useTestDb(path = ":memory:"): Database {
  if (!db || dbPath !== path) {
    db?.close();
    db = createUiDb(path);
    dbPath = path;
  }
  return db;
}

export function getDb(): Database {
  return useTestDb(dbPath ?? ":memory:");
}

export function closeDb(): void {
  db?.close();
  db = null;
  dbPath = null;
}

export function removeDbFile(path: string): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = path + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

/** Install one fake backend as the complete registry (rebuilds the host). */
export function setBackendForTests(backend: AgentBackend): void {
  setBackendsForTests([backend], backend.id);
}

/** Install a complete fake registry with an explicit default (rebuilds the host). */
export function setBackendsForTests(
  backends: AgentBackend[],
  defaultBackendId = backends[0]?.id ?? ""
): void {
  registry = createStaticBackendRegistry(backends, defaultBackendId);
  host = null;
}

/** Cap on concurrently running sessions for hosts built after the call. */
export function setMaxConcurrentSessions(cap: number): void {
  maxConcurrent = cap;
}

/** Install a remembered-tool-grants store for hosts built after the call. */
export function setToolPermissionsForTests(tp: ToolPermissions | null): void {
  toolPermissions = tp;
  host = null;
}

/** Drop host, registry and cap back to pristine (db handled separately). */
export function resetForTests(): void {
  host?.coordinator.reset();
  host = null;
  registry = null;
  maxConcurrent = 3;
  toolPermissions = null;
}

export function testHost(): WsHost {
  if (!host) {
    if (!registry) {
      throw new Error("test-host: call setBackendForTests/setBackendsForTests first");
    }
    host = new WsHost({
      registry,
      catalog: createSessionCatalog(() => getDb()),
      maxConcurrentSessions: () => maxConcurrent,
      ...(toolPermissions ? { toolPermissions } : {}),
    });
  }
  return host;
}

export function testRegistry(): BackendRegistry {
  if (!registry) {
    throw new Error("test-host: call setBackendForTests/setBackendsForTests first");
  }
  return registry;
}

export function addClient(ws: WSContext): void {
  testHost().clients.add(ws, "test-principal");
}

export function isTurnActive(): boolean {
  return testHost().coordinator.isTurnActive();
}

export async function handleClientMessage(
  ws: WSContext,
  msg: ClientMessage
): Promise<void> {
  return dispatch(testHost(), ws, msg, {
    principal: testPrincipal(),
    authorization: testAuthorization(),
  });
}
