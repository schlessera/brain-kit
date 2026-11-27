/**
 * The Gmail detail client (#4210 over #4207's route): one uncached GET per
 * call to the host's internal route, the parsed body for the message asked
 * about, or the host's typed error. Anything else is an `upstream_error`
 * with a `host_` reason, so no card reads the host's failure as Gmail's.
 */
import { describe, expect, test } from "bun:test";
import { fetchGmailMessageBody } from "../src/lib/gmail-details.js";
import { RAFT, raftBody } from "./gmail-fixtures.js";

function root(answer: () => Response) {
  const calls: { url: string; cache: RequestCache | undefined; method: string }[] = [];
  return {
    calls,
    root: { apiBase: () => "/api", request: async (url: string, init?: RequestInit) => { calls.push({ url, cache: init?.cache, method: init?.method ?? "GET" }); return answer(); } },
  };
}

describe("fetchGmailMessageBody", () => {
  test("asks the host's route for one message's body, uncached, and asks again on each call", async () => {
    const t = root(() => Response.json(raftBody()));
    const input = { sessionId: "sess ithaca", messageId: RAFT };
    expect(await fetchGmailMessageBody(t.root, input), "GMAIL_CLIENT_BODY").toEqual({ ok: true, body: raftBody() });
    await fetchGmailMessageBody(t.root, input);
    const once = { url: `/api/sessions/sess%20ithaca/google/gmail/messages/${RAFT}/body`, cache: "no-store" as const, method: "GET" };
    expect(t.calls, "GMAIL_CLIENT_NO_CACHE").toEqual([once, once]);
  });

  test("returns the host's typed error as it came", async () => {
    const limited = { code: "rate_limited" as const, reason: null, message: "Gmail's request limit is used up." };
    expect(await fetchGmailMessageBody(root(() => Response.json({ error: limited }, { status: 429 })).root, { sessionId: "s", messageId: RAFT })).toEqual({ ok: false, error: limited });
  });

  test.each([
    ["an unreadable 200", () => new Response("<html>", { status: 200 }), "host_malformed"],
    ["another message's body", () => Response.json(raftBody({ message_id: "19a1c0de0f2b4a01" })), "host_malformed"],
    ["an unreadable 504 from a proxy", () => new Response("<html>", { status: 504 }), "host_http_504"],
    ["a 401 with no typed error", () => Response.json({ error: "Authentication required", authRequired: true }, { status: 401 }), "host_http_401"],
  ] as const)("%s is the host's upstream_error, never Gmail's", async (_label, answer, reason) => {
    expect(await fetchGmailMessageBody(root(answer).root, { sessionId: "s", messageId: RAFT })).toMatchObject({ ok: false, error: { code: "upstream_error", reason } });
  });

  test("no answer at all is host_no_answer", async () => {
    const silent = { apiBase: () => "/api", request: async () => { throw new TypeError("offline"); } };
    expect(await fetchGmailMessageBody(silent, { sessionId: "s", messageId: RAFT })).toMatchObject({ ok: false, error: { code: "upstream_error", reason: "host_no_answer" } });
  });

  test("an id that is not a Gmail message id sends nothing", async () => {
    const t = root(() => Response.json(raftBody()));
    expect(await fetchGmailMessageBody(t.root, { sessionId: "s", messageId: "../labels" })).toMatchObject({ ok: false, error: { code: "invalid_input", reason: "message" } });
    expect(t.calls, "GMAIL_CLIENT_INVALID_SENDS_NOTHING").toEqual([]);
  });
});
