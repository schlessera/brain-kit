// The root's session list (#4754): overlapping refreshes share one follow-up
// chain instead of each sending a request, the follow-up is sent only after
// the chain in flight settled, and the retained conversations of one walk
// are merged by id. A fake API answers when the test says so.
import { describe, expect, test } from "bun:test";
import type { BrainApi } from "../src/lib/api-client.js";
import { createSessionListStore, type ListedSession } from "../src/stores/session-list-state.js";

type Answer = Awaited<ReturnType<BrainApi["sessions"]>>;

/** A fake `GET /api/sessions`: every request waits until the test settles it. */
function fakeApi() {
  const requests: { cursor: string | undefined; resolve: (answer: Answer) => void; reject: (error: Error) => void }[] = [];
  const api = {
    sessions: (cursor?: string) => new Promise<Answer>((resolve, reject) => { requests.push({ cursor, resolve, reject }); }),
  } as unknown as BrainApi;
  return { api, requests };
}

const session = (id: string, title: string) => ({ id, title, createdAt: 0, lastActiveAt: 0, totalCostUsd: 0, numTurns: 1 }) as ListedSession;
const answer = (sessions: ListedSession[], retained: { id: string; created_at: number }[] = [], retainedAfter?: string) =>
  ({ sessions, retainedConversations: retained, ...(retainedAfter ? { retainedAfter } : {}) }) as unknown as Answer;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const RETRY = "Could not refresh sessions. Please retry.";

describe("session-list refresh", () => {
  test("three calls during one request send one follow-up, after the first answer", async () => {
    const { api, requests } = fakeApi();
    const lists: (string | null)[][] = [];
    const store = createSessionListStore({ api }, (sessions) => lists.push(sessions.map((s) => s.title)));
    const first = store.getState().refresh();
    const second = store.getState().refresh();
    const third = store.getState().refresh();
    await settle();
    expect(requests).toHaveLength(1);
    expect(store.getState().loading).toBe(true);
    requests[0]!.resolve(answer([session("s1", "Ithaca, before the label")]));
    await first;
    await settle();
    // The first answer is applied; the follow-up was sent only once it settled.
    expect(store.getState().sessions.map((s) => s.title)).toEqual(["Ithaca, before the label"]);
    expect(requests).toHaveLength(2);
    expect(store.getState().loading).toBe(true);
    requests[1]!.resolve(answer([session("s1", "The bag of winds")]));
    await Promise.all([second, third]);
    expect(store.getState().sessions.map((s) => s.title)).toEqual(["The bag of winds"]);
    expect(store.getState().loading).toBe(false);
    expect(lists).toEqual([["Ithaca, before the label"], ["The bag of winds"]]);
    expect(requests).toHaveLength(2);
  });

  test("a call after every chain settled sends a new request, and one call sends one request per page", async () => {
    const { api, requests } = fakeApi();
    const store = createSessionListStore({ api });
    const one = store.getState().refresh();
    await settle();
    requests[0]!.resolve(answer([session("s1", "Aeolia")]));
    await one;
    expect(requests).toHaveLength(1);
    const two = store.getState().refresh();
    await settle();
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(answer([session("s1", "Aeolia")], [{ id: "v1", created_at: 1 }], "c1"));
    await settle();
    expect(requests.map((r) => r.cursor)).toEqual([undefined, undefined, "c1"]);
    requests[2]!.resolve(answer([], [{ id: "v2", created_at: 2 }]));
    await two;
    expect(requests).toHaveLength(3);
    expect(store.getState().sessions.map((s) => s.id)).toEqual(["s1", "dialogue:v1", "dialogue:v2"]);
  });

  test("every chain walks all three retained pages: none is carried over from an earlier load", async () => {
    const { api, requests } = fakeApi();
    const store = createSessionListStore({ api });
    for (let load = 0; load < 2; load++) {
      const from = requests.length;
      const done = store.getState().refresh();
      await settle();
      requests[from]!.resolve(answer([], [{ id: "v1", created_at: 1 }], "c1"));
      await settle();
      requests[from + 1]!.resolve(answer([], [{ id: "v2", created_at: 2 }], "c2"));
      await settle();
      requests[from + 2]!.resolve(answer([], [{ id: "v3", created_at: 3 }]));
      await done;
      expect(requests.slice(from).map((r) => r.cursor)).toEqual([undefined, "c1", "c2"]);
      expect(store.getState().sessions.map((s) => s.id)).toEqual(["dialogue:v1", "dialogue:v2", "dialogue:v3"]);
    }
  });

  test("a failed chain still runs the marked follow-up, whose success clears the warning", async () => {
    const { api, requests } = fakeApi();
    const store = createSessionListStore({ api });
    const first = store.getState().refresh();
    const second = store.getState().refresh();
    await settle();
    requests[0]!.reject(new Error("host away"));
    await first;
    expect(store.getState().warning).toBe(RETRY);
    expect(store.getState().loading).toBe(true);
    await settle();
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(answer([session("s1", "Back on course")]));
    await second;
    expect(store.getState().warning).toBeNull();
    expect(store.getState().loading).toBe(false);
    expect(store.getState().sessions.map((s) => s.title)).toEqual(["Back on course"]);
  });

  test("a repeated cursor and a failed request with no follow-up still end in the warning", async () => {
    const { api, requests } = fakeApi();
    const store = createSessionListStore({ api });
    const repeated = store.getState().refresh();
    await settle();
    requests[0]!.resolve(answer([], [{ id: "v1", created_at: 1 }], "c1"));
    await settle();
    requests[1]!.resolve(answer([], [{ id: "v2", created_at: 2 }], "c1"));
    await repeated;
    expect(store.getState().warning).toBe(RETRY);
    expect(store.getState().loading).toBe(false);
    const failed = store.getState().refresh();
    await settle();
    requests[2]!.reject(new Error("host away"));
    await failed;
    expect(store.getState().warning).toBe(RETRY);
    expect(store.getState().loading).toBe(false);
    expect(requests).toHaveLength(3);
  });

  test("a retained page that repeats a conversation draws it once", async () => {
    const { api, requests } = fakeApi();
    const store = createSessionListStore({ api });
    const done = store.getState().refresh();
    await settle();
    requests[0]!.resolve(answer([], [{ id: "v1", created_at: 1 }, { id: "v2", created_at: 2 }], "c1"));
    await settle();
    requests[1]!.resolve(answer([], [{ id: "v2", created_at: 2 }, { id: "v3", created_at: 3 }]));
    await done;
    expect(store.getState().sessions.map((s) => s.id)).toEqual(["dialogue:v1", "dialogue:v2", "dialogue:v3"]);
  });
});
