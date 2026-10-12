import { expect, test } from "bun:test";
import { serverResultSchema, serverSessionHistorySchema } from "../src/schemas.js";
import { stateRoomCopy, stateRoomWarning } from "../src/protocol.js";

const observation = { usedBytes: 51 * 1024 * 1024, allowanceBytes: 64 * 1024 * 1024, observedAt: Date.UTC(2026, 6, 12, 9, 41) };
const result = { type: "result", sessionId: "odysseus-ithaca", durationMs: 1, numTurns: 1, isError: false };
const history = { type: "session_history", sessionId: "odysseus-ithaca", messages: [] };
test("result and history preserve the same optional measurement while retaining legacy frames", () => {
  for (const [schema, frame] of [[serverResultSchema, result], [serverSessionHistorySchema, history]] as const) {
    expect(schema.parse(frame).stateRoom).toBeUndefined();
    expect(schema.parse({ ...frame, stateRoom: observation }).stateRoom).toEqual(observation);
    expect(schema.parse({ ...frame, stateRoom: { ...observation, future: true } }).stateRoom).toMatchObject(observation);
    for (const malformed of [null, {}, { ...observation, allowanceBytes: 0 }, { ...observation, usedBytes: -1 },
      { ...observation, observedAt: Number.MAX_SAFE_INTEGER }, { ...observation, usedBytes: 0.5 }]) {
      expect(schema.parse({ ...frame, stateRoom: malformed }).stateRoom).toBeUndefined();
    }
  }
});
test("the one approved threshold and rounded copy use the same raw measurement", () => {
  expect(stateRoomWarning({ ...observation, usedBytes: 32 * 1024 * 1024 })).toBe(false);
  expect(stateRoomWarning({ ...observation, usedBytes: 48 * 1024 * 1024 - 1 })).toBe(false);
  expect(stateRoomWarning({ ...observation, usedBytes: 48 * 1024 * 1024 })).toBe(true);
  expect(stateRoomCopy(observation)).toBe("This conversation is nearing its saved-state limit: 51 MiB of 64 MiB (80%).");
});
