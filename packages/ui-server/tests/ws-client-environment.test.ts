import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientEnvironment } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { WSContext } from "../src/ws/clients";
import { makeFakeBackend } from "./helpers/fake-backend";
import {
  closeDb,
  getDb,
  handleClientMessage,
  removeDbFile,
  resetForTests,
  setBackendsForTests,
  useTestDb,
} from "./helpers/test-host";

/**
 * The device snapshot is only useful if it survives the whole path — frame →
 * dispatch → session runner → StartTurnRequest — including the queued
 * follow-up branch, where each queued message must keep ITS OWN snapshot
 * rather than the one that started the session.
 */

const TEST_DB = `/tmp/brain-ui-ws-client-env-${process.pid}.db`;

beforeEach(() => {
  closeDb();
  removeDbFile(TEST_DB);
  useTestDb(TEST_DB);
  resetForTests();
});

afterEach(() => {
  resetForTests();
  closeDb();
  removeDbFile(TEST_DB);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

const phone: ClientEnvironment = {
  formFactor: "phone",
  touch: true,
  camera: true,
  geolocation: true,
  share: true,
  shareFiles: true,
  viewportWidth: 400,
  timeZone: "Europe/Berlin",
};

const desktop: ClientEnvironment = { formFactor: "desktop", viewportWidth: 750 };

function backendCapturing(
  seen: Array<ClientEnvironment | undefined>,
  opts: { sessionId: string; hold?: { until: Promise<void> } } = { sessionId: "s1" }
) {
  return makeFakeBackend({
    id: "claude",
    async startTurn(request: StartTurnRequest) {
      seen.push(request.client);
      request.bridge.emit({
        type: "session_info",
        sessionId: opts.sessionId,
        isNew: seen.length === 1,
        providerId: "claude",
      });
      if (opts.hold) await opts.hold.until;
      request.bridge.emit({
        type: "result",
        sessionId: opts.sessionId,
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
    },
  });
}

describe("client environment over the websocket", () => {
  test("reaches startTurn on a new session", async () => {
    const seen: Array<ClientEnvironment | undefined> = [];
    setBackendsForTests([backendCapturing(seen)], "claude");
    const ws: WSContext = { send() {} };

    await handleClientMessage(ws, { type: "chat_message", text: "hi", client: phone });
    await waitFor(() => seen.length === 1);

    expect(seen[0]).toEqual(phone);
  });

  test("is absent, not invented, when the client does not report one", async () => {
    const seen: Array<ClientEnvironment | undefined> = [];
    setBackendsForTests([backendCapturing(seen)], "claude");
    const ws: WSContext = { send() {} };

    await handleClientMessage(ws, { type: "chat_message", text: "hi" });
    await waitFor(() => seen.length === 1);

    expect(seen[0]).toBeUndefined();
  });

  test("a queued follow-up carries its own snapshot, not the first one", async () => {
    // The reader starts on a phone and continues from a desktop while the
    // first turn is still running: turn two must be told "desktop".
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: Array<ClientEnvironment | undefined> = [];
    setBackendsForTests(
      [backendCapturing(seen, { sessionId: "s1", hold: { until: held } })],
      "claude"
    );
    const ws: WSContext = { send() {} };

    await handleClientMessage(ws, { type: "chat_message", text: "first", client: phone });
    await waitFor(() => seen.length === 1);
    // Same session, still running → queued as the next turn.
    await handleClientMessage(ws, {
      type: "chat_message",
      text: "second",
      sessionId: "s1",
      client: desktop,
    });
    release();
    await waitFor(() => seen.length === 2);

    expect(seen[0]).toEqual(phone);
    expect(seen[1]).toEqual(desktop);
  });

  test("the db and session flow are unaffected by the extra field", async () => {
    const seen: Array<ClientEnvironment | undefined> = [];
    setBackendsForTests([backendCapturing(seen, { sessionId: "s-db" })], "claude");
    const ws: WSContext = { send() {} };

    await handleClientMessage(ws, { type: "chat_message", text: "hi", client: phone });
    await waitFor(
      () => getDb().query("SELECT id FROM sessions WHERE id = ?").get("s-db") !== null
    );

    expect(seen).toHaveLength(1);
  });
});
