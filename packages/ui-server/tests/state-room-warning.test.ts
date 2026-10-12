import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerMessage, StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "../src/ws/clients";
import { queryGovernanceEvents } from "../src/governance/events";
import { makeFakeBackend } from "./helpers/fake-backend";
import { addClient, closeDb, getDb, handleClientMessage, removeDbFile, resetForTests, setBackendsForTests, testHost, useTestDb } from "./helpers/test-host";
import { sendSessionHistory } from "../src/ws/history";

const TEST_DB = `/tmp/brain-ui-state-room-${process.pid}.db`;
const SESSION = "odysseus-ithaca";
const MIB = 1024 * 1024;
const T0 = Date.UTC(2026, 6, 12, 9, 41);
beforeEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); useTestDb(TEST_DB); });
afterEach(() => { resetForTests(); closeDb(); removeDbFile(TEST_DB); });

test("one actual observation reaches result, latest history and one quiet warning across repeated turns", async () => {
  let observation: StateRoomObservation | undefined;
  let failure: string | undefined;
  setBackendsForTests([makeFakeBackend({ id: "claude", async startTurn(req) {
    req.bridge.emit({ type: "session_info", sessionId: SESSION, isNew: !req.sessionId });
    req.bridge.emit({ type: "result", sessionId: SESSION, numTurns: 1, durationMs: 1, isError: Boolean(failure),
      ...(failure ? { failure: { errorClass: failure, message: "Fixture refusal" } } : {}),
      ...(observation ? { stateRoom: observation } : {}) });
  } })], "claude");
  const frames: ServerMessage[] = [];
  const ws: WSContext = { send: raw => { frames.push(JSON.parse(raw)); } }; addClient(ws);
  async function turn(usedBytes: number | undefined, allowanceBytes = 64 * MIB) {
    observation = usedBytes === undefined ? undefined : { usedBytes, allowanceBytes, observedAt: T0 + frames.length };
    const before = frames.filter(frame => frame.type === "result").length;
    await handleClientMessage(ws, { type: "chat_message", text: "Plan the next leg to Ithaca", attachments: [],
      ...(before ? { sessionId: SESSION } : {}) });
    for (let i = 0; i < 400 && (frames.filter(frame => frame.type === "result").length === before || testHost().coordinator.isTurnActive()); i++) await Bun.sleep(5);
    expect(frames.filter(frame => frame.type === "result")).toHaveLength(before + 1);
  }
  await turn(32 * MIB);
  expect(queryGovernanceEvents(getDb(), { sessionId: SESSION, kinds: ["state_room_warning"], limit: 100 })).toEqual([]);
  for (let i = 0; i < 5; i++) await turn(51 * MIB);
  const events = queryGovernanceEvents(getDb(), { sessionId: SESSION, kinds: ["state_room_warning"], limit: 100 });
  expect(events, "STATE_ROOM_ONE_QUIET_WARNING").toHaveLength(1);
  expect(events[0]!.payload).toMatchObject({ usedBytes: 51 * MIB, allowanceBytes: 64 * MIB });
  expect(testHost().catalog.readStateRoom!(SESSION)).toEqual(observation);
  expect(frames.filter(frame => frame.type === "result").at(-1)).toHaveProperty("stateRoom", observation);
  const history: string[] = [];
  sendSessionHistory({ send: raw => { history.push(raw); } }, SESSION, [], testHost().catalog.readStateRoom!(SESSION));
  expect(JSON.parse(history[0]!).stateRoom).toEqual(observation);
  // Busy is not a new measurement, nor an intrinsic-size warning.
  const last = observation; failure = "worker_state_busy"; await turn(undefined);
  expect(testHost().catalog.readStateRoom!(SESSION)).toEqual(last);
  expect(queryGovernanceEvents(getDb(), { sessionId: SESSION, kinds: ["state_room_warning"], limit: 100 })).toHaveLength(1);
  await turn(103 * MIB, 128 * MIB);
  expect(testHost().catalog.readStateRoom!(SESSION), "busy never replaces a measured observation even when a backend attaches one").toEqual(last);
  expect(queryGovernanceEvents(getDb(), { sessionId: SESSION, kinds: ["state_room_warning"], limit: 100 })).toHaveLength(1);
  failure = "session_too_large"; await turn(129 * MIB, 128 * MIB);
  expect(testHost().catalog.readStateRoom!(SESSION)).toEqual(last);
  failure = undefined; await turn(102 * MIB, 128 * MIB);
  expect(queryGovernanceEvents(getDb(), { sessionId: SESSION, kinds: ["state_room_warning"], limit: 100 })).toHaveLength(2);
  closeDb(); useTestDb(TEST_DB);
  expect(testHost().catalog.readStateRoom!(SESSION)).toEqual(observation);
});
