import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  ClientMessage,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type {
  AgentBackend,
  BackendBridge,
} from "@schlessera/brain-ui-sdk/server";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import {
  closeDb,
  resetForTests,
  setBackendForTests,
  testHost,
} from "./helpers/test-host";
import { testPrincipal } from "./helpers/principal";

const ASK_KINDS = ["ordinary", "list", "rank", "form"] as const;
type AskKind = (typeof ASK_KINDS)[number];

function ask(bridge: BackendBridge, kind: AskKind): Promise<unknown> {
  switch (kind) {
    case "ordinary":
      return bridge.askUser!("same", [
        {
          question: "Which?",
          header: "Choice",
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
          multiSelect: false,
        },
      ]);
    case "list":
      return bridge.askUserList!("same", {
        prompt: "Rate",
        allowSkip: true,
        notes: false,
        scale: [{ label: "A" }, { label: "B" }],
        items: [{ id: "a", label: "Film A" }],
      });
    case "rank":
      return bridge.askUserRank!("same", {
        prompt: "Rank",
        items: [
          { id: "a", label: "Film A" },
          { id: "b", label: "Film B" },
        ],
      });
    case "form":
      return bridge.askUserForm!("same", {
        prompt: "Choose",
        nodes: [
          {
            id: "choice",
            kind: "single",
            prompt: "Which?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      });
  }
}

type AskAnswer = Extract<
  ClientMessage,
  {
    type:
      | "ask_user_response"
      | "ask_user_list_response"
      | "ask_user_rank_response"
      | "ask_user_form_response";
  }
>;
const ANSWERS: Record<AskKind, { frame: AskAnswer; result: unknown }> = {
  ordinary: {
    frame: {
      type: "ask_user_response",
      requestId: "same",
      answers: { "Which?": "A" },
    },
    result: { answers: { "Which?": "A" }, annotations: undefined },
  },
  list: {
    frame: {
      type: "ask_user_list_response",
      requestId: "same",
      answers: { a: "A" },
    },
    result: { answers: { a: "A" } },
  },
  rank: {
    frame: {
      type: "ask_user_rank_response",
      requestId: "same",
      order: ["b", "a"],
      unchanged: false,
    },
    result: { order: ["b", "a"], unchanged: false },
  },
  form: {
    frame: {
      type: "ask_user_form_response",
      requestId: "same",
      answers: { choice: { value: "A" } },
    },
    result: { answers: { choice: { value: "A" } } },
  },
};

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("host did not start the scripted turn");
}

/** Real host/connection/dispatch, with an inert backend held until teardown. */
async function setup(twoTurns = false) {
  const bridges: BackendBridge[] = [];
  const backend: AgentBackend = {
    id: "fake",
    capabilities: {
      resume: true,
      permissions: true,
      thinking: true,
      attachments: true,
      askUser: true,
      costReporting: true,
      concurrentSessions: true,
      followUp: false,
    },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn({ bridge, signal }) {
      bridge.emit({
        type: "session_info",
        sessionId: `s${bridges.length + 1}`,
        isNew: true,
      });
      bridges.push(bridge);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    },
    async listSessions() {
      return [];
    },
    async getHistory() {
      return [];
    },
  };
  setBackendForTests(backend);
  const host = testHost();
  const sent: ServerMessage[] = [];
  let onFrame: ((frame: ServerMessage) => void) | undefined;
  const ws: WSContext = {
    send(data) {
      const frame = JSON.parse(data) as ServerMessage;
      sent.push(frame);
      onFrame?.(frame);
    },
  };
  const handlers = createWsHandlers(host, testPrincipal());
  await handlers.onOpen({} as Event, ws);
  async function send(frame: ClientMessage): Promise<void> {
    const data = JSON.stringify(frame);
    expect(parseClientMessage(data).ok).toBe(true);
    handlers.onMessage({ data } as MessageEvent, ws);
    await Bun.sleep(0);
  }
  await send({ type: "chat_message", text: "First" });
  await until(() => bridges.length === 1);
  if (twoTurns) {
    await send({ type: "chat_message", text: "Second" });
    await until(() => bridges.length === 2);
  }
  return {
    host,
    send,
    sent,
    bridges,
    onFrame: (fn: (frame: ServerMessage) => void) => {
      onFrame = fn;
    },
  };
}

function askMap(host: ReturnType<typeof testHost>, kind: AskKind) {
  const c = host.coordinator;
  switch (kind) {
    case "ordinary":
      return c.pendingAskUser;
    case "list":
      return c.pendingAskUserList;
    case "rank":
      return c.pendingAskUserRank;
    case "form":
      return c.pendingAskUserForm;
  }
}

describe("interactive admission before emission", () => {
  beforeEach(() => {
    resetForTests();
    closeDb();
  });
  afterEach(() => {
    resetForTests();
    closeDb();
  });

  for (const originalKind of ASK_KINDS) {
    for (const duplicateKind of ASK_KINDS) {
      // Same-kind ordinary/list admission intentionally only rejects another
      // turn. Cross-kind admission rejects even in the same turn (#724).
      const twoTurns = originalKind === duplicateKind;
      for (const settlement of ["answer", "cancel"] as const) {
        test(`${duplicateKind} refuses a pending ${originalKind} id without frames; original can ${settlement}`, async () => {
          const { host, send, sent, bridges } = await setup(twoTurns);
          let settled = false;
          const original = ask(bridges[0], originalKind);
          void original.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            }
          );
          const pending = askMap(host, originalKind).get("same")!;
          expect(pending).toBeDefined();
          const visible = sent.filter(
            (frame) =>
              frame.type ===
              `ask_user${
                originalKind === "ordinary" ? "" : `_${originalKind}`
              }_request`
          );
          expect(visible).toHaveLength(1);
          const before = sent.length;

          await expect(
            ask(bridges[twoTurns ? 1 : 0], duplicateKind)
          ).rejects.toThrow("Duplicate ask-user request id");
          expect(sent.slice(before)).toEqual([]);
          expect(askMap(host, originalKind).get("same")).toBe(pending);
          expect(settled).toBe(false);
          expect(
            ASK_KINDS.reduce((n, kind) => n + askMap(host, kind).size, 0)
          ).toBe(1);

          if (settlement === "answer") {
            await send({
              ...ANSWERS[originalKind].frame,
              turnId: pending.turnId,
            });
            expect(await original).toEqual(ANSWERS[originalKind].result);
          } else {
            await send({
              type: "ask_user_cancel",
              requestId: "same",
              reason: "Dismissed original",
              turnId: pending.turnId,
            });
            await expect(original).rejects.toThrow("Dismissed original");
          }
          expect(
            ASK_KINDS.reduce((n, kind) => n + askMap(host, kind).size, 0)
          ).toBe(0);
        });
      }
    }
  }

  for (const kind of ["permission", "location", "mask"] as const) {
    for (const settlement of ["answer", "cancel"] as const) {
      test(`${kind} refuses another turn's id without frames; original can ${settlement}`, async () => {
        const { host, send, sent, bridges } = await setup(true);
        const c = host.coordinator;
        // The production generators do not repeat. Force that exceptional
        // path without bypassing the real bridge admission or dispatch.
        const generator =
          kind === "location"
            ? spyOn(c, "nextLocationRequestId").mockReturnValue("same")
            : kind === "mask"
            ? spyOn(c, "nextMaskRequestId").mockReturnValue("same")
            : null;
        try {
          const request = (bridge: BackendBridge) =>
            kind === "permission"
              ? bridge.requestPermission({
                  toolUseId: "same",
                  toolName: "Write",
                  input: { file_path: "note.md" },
                })
              : kind === "location"
              ? bridge.getLocation!({})
              : bridge.requestMask!("image.png", "Mark the area");
          let settled = false;
          const original = request(bridges[0]);
          void original.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            }
          );
          const map =
            kind === "permission"
              ? c.pendingApprovals
              : kind === "location"
              ? c.pendingLocation
              : c.pendingMask;
          const pending = map.get("same")!;
          expect(pending).toBeDefined();
          expect(map.size).toBe(1);
          const before = sent.length;
          const duplicate = request(bridges[1]);
          if (kind === "permission")
            expect(await duplicate).toEqual({
              behavior: "deny",
              message: "Duplicate tool-approval id",
            });
          else
            await expect(duplicate).rejects.toThrow(
              `Duplicate ${kind} request id`
            );
          expect(sent.slice(before)).toEqual([]);
          expect(map.get("same")).toBe(pending);
          expect(settled).toBe(false);

          if (settlement === "cancel") {
            if (kind === "permission") {
              await send({
                type: "tool_denial",
                toolUseId: "same",
                message: "Dismissed original",
                turnId: pending.turnId,
              });
              expect(await original).toEqual({
                behavior: "deny",
                message: "Dismissed original",
              });
            } else {
              await send(
                kind === "location"
                  ? {
                      type: "location_error",
                      requestId: "same",
                      code: 0,
                      message: "Dismissed original",
                      turnId: pending.turnId,
                    }
                  : {
                      type: "mask_error",
                      requestId: "same",
                      code: "cancelled",
                      message: "Dismissed original",
                      turnId: pending.turnId,
                    }
              );
              await expect(original).rejects.toThrow("Dismissed original");
            }
          } else if (kind === "permission") {
            await send({
              type: "tool_approval",
              toolUseId: "same",
              turnId: pending.turnId,
            });
            expect(await original).toEqual({ behavior: "allow" });
          } else if (kind === "location") {
            const coords = { latitude: 1, longitude: 2, accuracy: 3 };
            await send({
              type: "location_response",
              requestId: "same",
              coords,
              timestamp: 123,
              turnId: pending.turnId,
            });
            expect(await original).toEqual({ coords, timestamp: 123 });
          } else {
            await send({
              type: "mask_response",
              requestId: "same",
              maskPng: Buffer.from([1, 2, 3]).toString("base64"),
              turnId: pending.turnId,
            });
            expect(await original).toEqual(new Uint8Array([1, 2, 3]));
          }
          expect(map.size).toBe(0);
        } finally {
          generator?.mockRestore();
        }
      });
    }
  }

  test("valid requests are registered when their first frame reaches the socket", async () => {
    const { host, bridges, onFrame } = await setup();
    const admitted: boolean[] = [];
    onFrame((frame) => {
      const c = host.coordinator;
      if (frame.type === "tool_approval_request")
        admitted.push(c.pendingApprovals.has(frame.toolUseId));
      if (frame.type === "location_request")
        admitted.push(c.pendingLocation.has(frame.requestId));
      if (frame.type === "mask_request")
        admitted.push(c.pendingMask.has(frame.requestId));
      for (const kind of ASK_KINDS) {
        if (
          frame.type ===
          `ask_user${kind === "ordinary" ? "" : `_${kind}`}_request`
        )
          admitted.push(askMap(host, kind).has("same"));
      }
    });
    for (const kind of ASK_KINDS) {
      const original = ask(bridges[0], kind);
      void original.catch(() => {});
      host.coordinator.drainPendingForTurn(
        [...host.coordinator.running][0],
        "Test cleanup"
      );
    }
    void bridges[0].requestPermission({
      toolUseId: "approval",
      toolName: "Write",
      input: {},
    });
    void bridges[0].getLocation!({}).catch(() => {});
    void bridges[0].requestMask!("image.png", "Mark").catch(() => {});
    expect(admitted).toHaveLength(7);
    expect(admitted).toEqual(Array(7).fill(true));
  });
});
