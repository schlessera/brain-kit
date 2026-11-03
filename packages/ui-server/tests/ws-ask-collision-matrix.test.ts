/**
 * Characterization of today's ask-user id collision rules (#2515). Every cell
 * of four kinds × same/other turn × same/other kind records whether a second
 * request with a pending id is accepted or refused, and whether the host logs
 * an ERROR for it. Unifying these rules is a separate ruling (#2773); this
 * test pins the current behaviour so the coordinator refactor cannot move it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend, BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import { closeDb, resetForTests, setBackendForTests, testHost } from "./helpers/test-host";
import { testPrincipal } from "./helpers/principal";

const KINDS = ["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"] as const;
type Kind = (typeof KINDS)[number];

function ask(bridge: BackendBridge, kind: Kind): Promise<unknown> {
  switch (kind) {
    case "ask_user":
      return bridge.askUser!("ithaca", [
        { question: "Which road?", header: "Road", multiSelect: false,
          options: [{ label: "Sea", description: "By ship" }, { label: "Land", description: "On foot" }] },
      ]);
    case "ask_user_list":
      return bridge.askUserList!("ithaca", {
        prompt: "Rate the crew", allowSkip: true, notes: false,
        scale: [{ label: "Loyal" }, { label: "Wavering" }], items: [{ id: "eurylochus", label: "Eurylochus" }],
      });
    case "ask_user_rank":
      return bridge.askUserRank!("ithaca", {
        prompt: "Rank the perils", items: [{ id: "scylla", label: "Scylla" }, { id: "charybdis", label: "Charybdis" }],
      });
    case "ask_user_form":
      return bridge.askUserForm!("ithaca", {
        prompt: "Choose a course",
        nodes: [{ id: "course", kind: "single", prompt: "Which?", options: [{ label: "Sea" }, { label: "Land" }] }],
      });
  }
}

/**
 * Today's rule, per cell. `ask_user` and `ask_user_list` accept a repeat of
 * their own id from the same turn and refuse (with an ERROR log) one from
 * another turn; any other combination is refused without a log.
 */
function expected(original: Kind, duplicate: Kind, sameTurn: boolean): { accepted: boolean; logged: boolean } {
  const lenient = duplicate === "ask_user" || duplicate === "ask_user_list";
  if (original !== duplicate || !lenient) return { accepted: false, logged: false };
  return sameTurn ? { accepted: true, logged: false } : { accepted: false, logged: true };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("host did not start the scripted turns");
}

/** Two concurrent turns on the real host/connection/dispatch, each held until teardown. */
async function setup() {
  const bridges: BackendBridge[] = [];
  const backend: AgentBackend = {
    id: "fake",
    capabilities: { resume: true, permissions: true, thinking: true, attachments: true, askUser: true,
      costReporting: true, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "default", label: "Default" }],
    async startTurn({ bridge, signal }) {
      bridge.emit({ type: "session_info", sessionId: `aeaea-${bridges.length + 1}`, isNew: true });
      bridges.push(bridge);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    async listSessions() { return []; },
    async getHistory() { return []; },
  };
  setBackendForTests(backend);
  const host = testHost();
  const sent: ServerMessage[] = [];
  const ws: WSContext = { send(data) { sent.push(JSON.parse(data) as ServerMessage); } };
  const handlers = createWsHandlers(host, testPrincipal());
  await handlers.onOpen({} as Event, ws);
  for (const text of ["Sail for Ithaca", "Consult Tiresias"]) {
    const data = JSON.stringify({ type: "chat_message", text });
    expect(parseClientMessage(data).ok).toBe(true);
    handlers.onMessage({ data } as MessageEvent, ws);
    await Bun.sleep(0);
  }
  await until(() => bridges.length === 2);
  return { host, sent, bridges };
}

describe("ask-user id collisions (today's per-kind rules)", () => {
  beforeEach(() => { resetForTests(); closeDb(); });
  afterEach(() => { resetForTests(); closeDb(); });

  for (const original of KINDS) {
    for (const duplicate of KINDS) {
      for (const sameTurn of [true, false]) {
        const want = expected(original, duplicate, sameTurn);
        const cell = `${duplicate} after a pending ${original} from ${sameTurn ? "the same" : "another"} turn`;
        test(`${cell}: ${want.accepted ? "accepted" : "refused"}${want.logged ? ", logged" : ""}`, async () => {
          const { host, sent, bridges } = await setup();
          const first = ask(bridges[0]!, original);
          first.catch(() => {});
          await Bun.sleep(0);
          const frames = sent.length;
          const emit = spyOn(host.log, "emit");
          try {
            let refused: unknown;
            const second = ask(bridges[sameTurn ? 0 : 1]!, duplicate);
            second.catch((error: unknown) => { refused = error; });
            await Bun.sleep(0);
            const collisions = emit.mock.calls.filter(([record]) => record.body === "interactive id collision: already pending for another turn");
            expect(collisions.length, "ERROR collision log").toBe(want.logged ? 1 : 0);
            if (want.logged) expect(collisions[0]![0]).toMatchObject({ severityText: "ERROR", attributes: { "request.id": "ithaca" } });
            if (want.accepted) {
              expect(refused).toBeUndefined();
              expect(sent.slice(frames).map(frame => frame.type)).toContain(`${duplicate}_request` as never);
            } else {
              expect(refused).toBeInstanceOf(Error);
              expect((refused as Error).message).toBe("Duplicate ask-user request id");
              expect(sent.slice(frames), "a refused request sends nothing").toEqual([]);
            }
          } finally {
            emit.mockRestore();
          }
        });
      }
    }
  }
});
