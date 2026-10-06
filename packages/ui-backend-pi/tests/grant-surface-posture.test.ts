/**
 * A turn that declares `noGrantSurface` without `enforceAllowedTools` is
 * refused (#173).
 *
 * pi has none of the runtime shortcuts that make the unpaired declaration
 * unreachable on the Claude backend — every tool call passes its tool_call
 * gate — so here the pairing is not what makes the refusal happen. It is
 * refused anyway, with the same error, so one rule describes the declaration
 * whichever backend a posture runs on and a posture proven on pi does not
 * break when moved to Claude.
 */

import { describe, expect, test } from "bun:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  BackendRequestError,
  type BackendBridge,
  type ServerMessage,
  type StartTurnRequest,
} from "@schlessera/brain-ui-sdk/server";

import { createPiBackend, type PiSessionLike } from "../src/backend";
import { makeEmptyBrain } from "./helpers";

function fakeSession(sessionId: string): PiSessionLike {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  return {
    sessionId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: () => Promise.resolve(),
    abort: async () => {},
    getSessionStats: () => ({ cost: 0 }),
    dispose() {},
  };
}

async function runTurn(
  posture: Pick<StartTurnRequest, "enforceAllowedTools" | "noGrantSurface" | "posture">
): Promise<{ outcome: Promise<void>; frames: ServerMessage[]; sessions: () => number }> {
  const brain = makeEmptyBrain();
  let opened = 0;
  const backend = createPiBackend({
    brainPath: brain.root,
    sessionFactory: {
      newSession: async () => fakeSession(`s${++opened}`),
      openSession: async () => fakeSession(`s${++opened}`),
    },
  });
  const frames: ServerMessage[] = [];
  const bridge: BackendBridge = {
    emit: (m) => frames.push(m),
    requestPermission: async () => ({ behavior: "deny", message: "No." }),
  };
  const outcome = backend
    .startTurn({ prompt: "hi", signal: new AbortController().signal, bridge, ...posture })
    .finally(() => brain.cleanup());
  // Settle either way before the caller inspects frames.
  await outcome.catch(() => {});
  return { outcome, frames, sessions: () => opened };
}

/** The turn ran and succeeded: not merely resolved (a failed turn resolves too). */
function expectSucceeded(frames: ServerMessage[]): void {
  expect(frames.some((f) => f.type === "error")).toBe(false);
  expect(frames.find((f) => f.type === "result")).toMatchObject({
    outcome: "success",
    isError: false,
  });
}

describe("pi: noGrantSurface without enforceAllowedTools", () => {
  test("declared alone, startTurn rejects with BackendRequestError before a session exists", async () => {
    const turn = await runTurn({ noGrantSurface: true });

    await expect(turn.outcome).rejects.toBeInstanceOf(BackendRequestError);
    await expect(turn.outcome).rejects.toThrow(/noGrantSurface.*enforceAllowedTools/);
    expect(turn.frames).toHaveLength(0);
    expect(turn.sessions()).toBe(0);
  });

  test("an explicit enforceAllowedTools: false is refused the same way", async () => {
    const turn = await runTurn({ noGrantSurface: true, enforceAllowedTools: false });

    await expect(turn.outcome).rejects.toBeInstanceOf(BackendRequestError);
    expect(turn.frames).toHaveLength(0);
  });

  test("declaring both runs the turn", async () => {
    const turn = await runTurn({ noGrantSurface: true, enforceAllowedTools: true });

    await expect(turn.outcome).resolves.toBeUndefined();
    expectSucceeded(turn.frames);
  });

  test("declaring neither runs the turn", async () => {
    const turn = await runTurn({});

    await expect(turn.outcome).resolves.toBeUndefined();
    expectSucceeded(turn.frames);
  });

  test("enforceAllowedTools alone runs the turn", async () => {
    const turn = await runTurn({ enforceAllowedTools: true });

    await expect(turn.outcome).resolves.toBeUndefined();
    expectSucceeded(turn.frames);
  });

  function resumable() {
    const brain = makeEmptyBrain();
    let opened = 0;
    const backend = createPiBackend({
      brainPath: brain.root,
      sessionFactory: {
        newSession: async () => fakeSession(`s${++opened}`),
        openSession: async (id: string) => (++opened, fakeSession(id)),
      } as never,
    });
    const frames: ServerMessage[] = [];
    const bridge: BackendBridge = {
      emit: (m) => frames.push(m),
      requestPermission: async () => ({ behavior: "deny", message: "No." }),
    };
    const turn = (
      sessionId: string,
      posture: Pick<StartTurnRequest, "enforceAllowedTools" | "noGrantSurface">
    ) =>
      backend.startTurn({ prompt: "hi", sessionId, signal: new AbortController().signal, bridge, ...posture });
    return { brain, frames, turn, opened: () => opened };
  }

  test("a cold resume is refused before anything is opened for it", async () => {
    const r = resumable();
    try {
      await expect(r.turn("cold", { noGrantSurface: true })).rejects.toBeInstanceOf(BackendRequestError);
      expect(r.opened()).toBe(0);
      expect(r.frames).toHaveLength(0);
    } finally {
      r.brain.cleanup();
    }
  });

  test("a resident session is refused, keeps its slot free, and is not reopened", async () => {
    const r = resumable();
    try {
      await r.turn("warm", {});
      expectSucceeded(r.frames);
      expect(r.opened()).toBe(1);

      r.frames.length = 0;
      await expect(r.turn("warm", { noGrantSurface: true })).rejects.toBeInstanceOf(BackendRequestError);
      expect(r.frames).toHaveLength(0);

      await expect(
        r.turn("warm", { noGrantSurface: true, enforceAllowedTools: true })
      ).resolves.toBeUndefined();
      expectSucceeded(r.frames);
      // The same resident session served both valid turns.
      expect(r.opened()).toBe(1);
    } finally {
      r.brain.cleanup();
    }
  });
});

describe("pi: the voice posture (#957)", () => {
  test("a voice-posture turn is refused before a session exists: pi declares no voice allowlist", async () => {
    const turn = await runTurn({ posture: "voice", enforceAllowedTools: true, noGrantSurface: true });

    await expect(turn.outcome).rejects.toBeInstanceOf(BackendRequestError);
    await expect(turn.outcome).rejects.toThrow(/no voice tool posture/);
    expect(turn.frames).toHaveLength(0);
    expect(turn.sessions()).toBe(0);
  });

  test("a voice posture without the enforced no-grant pair is refused by the shared rule", async () => {
    const turn = await runTurn({ posture: "voice", enforceAllowedTools: true });

    await expect(turn.outcome).rejects.toThrow(/voice-posture turn must declare enforceAllowedTools and noGrantSurface/);
    expect(turn.sessions()).toBe(0);
  });
});
