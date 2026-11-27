/**
 * The shared test doubles for a scripted turn (#4836): the terminal frame a
 * fake backend emits, and the socket a test client listens on.
 */
import { describe, expect, test } from "bun:test";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { resultFrame } from "./helpers/fake-backend";
import { fakeClient } from "./helpers/fake-socket";

describe("resultFrame", () => {
  test("is a valid server result message and carries its outcome", () => {
    const frame = resultFrame("sess-ithaca");
    const parsed = parseServerMessage(JSON.stringify(frame));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.message).toEqual(frame);
    expect(frame).toEqual({ type: "result", sessionId: "sess-ithaca", outcome: "success", costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
  });

  test("an override wins, and the legacy option has no outcome key at all", () => {
    expect(resultFrame("s", { outcome: "cancelled", numTurns: 0 })).toMatchObject({ outcome: "cancelled", numTurns: 0 });
    const legacy = resultFrame("s", { outcome: undefined });
    expect("outcome" in legacy).toBe(false);
    expect(parseServerMessage(JSON.stringify(legacy)).ok).toBe(true);
  });
});

describe("fakeClient", () => {
  test("records every frame sent, and frames(type) returns exactly the frames of that type", () => {
    const { ws, sent, frames } = fakeClient();
    const status = { type: "status", status: "running" };
    ws.send(JSON.stringify(status));
    ws.send(JSON.stringify(resultFrame("first")));
    ws.send(JSON.stringify({ type: "text_delta", text: "Sing, Muse" }));
    ws.send(JSON.stringify(resultFrame("second", { outcome: undefined })));
    expect(sent.map((frame) => frame.type)).toEqual(["status", "result", "text_delta", "result"]);
    expect(frames("result")).toEqual([resultFrame("first"), resultFrame("second", { outcome: undefined })]);
    expect(frames("status")).toEqual([status as never]);
    expect(frames("error")).toEqual([]);
  });
});
