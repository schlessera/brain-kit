import { expect, test } from "bun:test";
import type { ClassificationRequest } from "@schlessera/brain-ui-sdk/server";
import {
  BREAKER_BASE_MS,
  BREAKER_FAILURES,
  createJevClient,
  type JevResult,
} from "../src/classification/jev-client";

const request: ClassificationRequest = {
  model: "jev-latest",
  state: { request: "Plan the next voyage to Ithaca." },
  questions: { needed: { type: "noul", instructions: "Is a voyage plan needed?" } },
};
const answers = { needed: { type: "noul" as const, noul: 0.99 } };
const answered = () => Response.json({ answers });

function fixture(options: { apiKey?: string | null; timeoutMs?: number; initialFailures?: number } = {}) {
  const clock = { t: 1_000_000 };
  const attempts: Array<{ request: ClassificationRequest; signal: AbortSignal }> = [];
  const pending: Array<{
    resolve: (response: Response) => void;
    reject: (error: unknown) => void;
    dispose: () => void;
  }> = [];
  const arrivals: Array<{ count: number; resolve: () => void }> = [];
  const running: Promise<JevResult>[] = [];
  const client = createJevClient({
    apiKey: options.apiKey === undefined ? "fixture" : options.apiKey,
    timeoutMs: options.timeoutMs ?? 1000,
    now: () => clock.t,
    fetch: (_url, init) => {
      const signal = init.signal!;
      attempts.push({ request: JSON.parse(String(init.body)), signal });
      if (attempts.length <= (options.initialFailures ?? BREAKER_FAILURES)) {
        return Promise.resolve(new Response("", { status: 503 }));
      }
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        // Keep the listener across retries: removing the last listener cancels
        // Bun 1.3.14's timeout signal even if a later attempt adds one again.
        pending.push({
          resolve, reject,
          dispose: () => signal.removeEventListener("abort", abort),
        });
        for (const arrival of arrivals) if (pending.length >= arrival.count) arrival.resolve();
      });
    },
  });
  const call = () => {
    const result = client.classify(request);
    running.push(result);
    return result;
  };
  return {
    client, clock, attempts, pending, call,
    async open() {
      expect(Object.keys(request.questions)).toEqual(["needed"]);
      for (let i = 0; i < BREAKER_FAILURES; i++) {
        expect((await call()).outcome).toBe("http_error");
      }
      expect(attempts).toHaveLength(BREAKER_FAILURES);
      expect(client.breaker()).toEqual({
        open: true, consecutiveFailures: BREAKER_FAILURES, retryAt: clock.t + BREAKER_BASE_MS,
      });
      clock.t = client.breaker().retryAt!;
    },
    waitForPending(count: number) {
      if (pending.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => arrivals.push({ count, resolve }));
    },
    async dispose() {
      for (const held of pending) held.reject(new Error("fixture cleanup"));
      await Promise.allSettled(running);
      for (const held of pending) held.dispose();
    },
  };
}

test("one half-open probe owns transport while concurrent callers skip", async () => {
  const f = fixture();
  try {
    await f.open();
    const before = f.client.breaker();
    const winner = f.call();
    const skipped = [f.call(), f.call(), f.call()];
    // This is the admission assertion: existing behavior dispatches all four.
    expect(f.attempts).toHaveLength(BREAKER_FAILURES + 1);
    expect(await Promise.all(skipped)).toEqual([
      { outcome: "circuit_open", answers: null, durationMs: 0 },
      { outcome: "circuit_open", answers: null, durationMs: 0 },
      { outcome: "circuit_open", answers: null, durationMs: 0 },
    ]);
    expect(f.client.breaker()).toEqual(before);
    expect(f.pending).toHaveLength(1);
    expect(f.attempts.at(-1)!.request).toEqual(request);
    expect(Object.keys(f.attempts.at(-1)!.request.questions)).toEqual(["needed"]);

    f.pending[0]!.resolve(answered());
    expect(await winner).toEqual({ outcome: "answered", answers, durationMs: 0 });
    expect(Object.keys((await winner).answers!)).toEqual(["needed"]);
    expect(f.client.breaker()).toEqual({ open: false, consecutiveFailures: 0, retryAt: null });
    const ordinary = [f.call(), f.call()];
    expect(f.attempts).toHaveLength(BREAKER_FAILURES + 3);
    for (const held of f.pending.slice(1)) held.resolve(answered());
    expect((await Promise.all(ordinary)).map((result) => result.outcome)).toEqual(["answered", "answered"]);
  } finally { await f.dispose(); }
});

for (const failure of ["http_error", "network_error", "bad_response", "timeout"] as const) {
  test(`a ${failure} probe advances backoff once and releases its reservation`, async () => {
    const f = fixture({ timeoutMs: failure === "timeout" ? 40 : 1000 });
    try {
      await f.open();
      const winner = f.call();
      const skipped = [f.call(), f.call()];
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 1);
      expect((await Promise.all(skipped)).map((result) => result.outcome)).toEqual(["circuit_open", "circuit_open"]);
      expect(f.client.breaker().consecutiveFailures).toBe(BREAKER_FAILURES);
      f.clock.t += 7;
      if (failure === "http_error") f.pending[0]!.resolve(new Response("", { status: 500 }));
      if (failure === "network_error") f.pending[0]!.reject(new TypeError("fixture connection failed"));
      if (failure === "bad_response") f.pending[0]!.resolve(new Response("not json"));
      const result = await winner;
      expect(result.outcome).toBe(failure);
      expect(result.answers).toBeNull();
      expect(result.durationMs).toBe(7);
      expect(f.client.breaker()).toEqual({
        open: true, consecutiveFailures: BREAKER_FAILURES + 1, retryAt: f.clock.t + 2 * BREAKER_BASE_MS,
      });
      const heldBackoff = f.client.breaker();
      expect((await f.call()).outcome).toBe("circuit_open");
      expect(f.client.breaker()).toEqual(heldBackoff);
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 1);

      f.clock.t = heldBackoff.retryAt!;
      const nextProbe = f.call();
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 2);
      f.pending[1]!.resolve(answered());
      expect((await nextProbe).answers).toEqual(answers);
      expect(f.client.breaker()).toEqual({ open: false, consecutiveFailures: 0, retryAt: null });
    } finally { await f.dispose(); }
  });
}

for (const status of [429, 529]) {
  test(`the probe's ${status} retry keeps ownership and the original deadline`, async () => {
    const f = fixture();
    try {
      await f.open();
      const winner = f.call();
      expect((await f.call()).outcome).toBe("circuit_open");
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 1);
      f.pending[0]!.resolve(new Response("", { status }));
      await f.waitForPending(2);
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 2);
      expect(f.attempts[3]!.signal).toBe(f.attempts[4]!.signal);
      expect(f.attempts[4]!.signal.aborted).toBe(false);
      expect((await f.call()).outcome).toBe("circuit_open");
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 2);
      expect(f.client.breaker().consecutiveFailures).toBe(BREAKER_FAILURES);
      f.pending[1]!.resolve(answered());
      expect((await winner).answers).toEqual(answers);
      expect(f.client.breaker()).toEqual({ open: false, consecutiveFailures: 0, retryAt: null });
    } finally { await f.dispose(); }
  });

  test(`an exhausted ${status} probe retry counts one failure`, async () => {
    const f = fixture();
    try {
      await f.open();
      const winner = f.call();
      expect((await f.call()).outcome).toBe("circuit_open");
      f.pending[0]!.resolve(new Response("", { status }));
      await f.waitForPending(2);
      expect((await f.call()).outcome).toBe("circuit_open");
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 2);
      f.pending[1]!.resolve(new Response("", { status }));
      expect(await winner).toEqual({ outcome: "rate_limited", answers: null, status, durationMs: 0 });
      expect(f.client.breaker()).toEqual({
        open: true, consecutiveFailures: BREAKER_FAILURES + 1, retryAt: f.clock.t + 2 * BREAKER_BASE_MS,
      });
      f.clock.t = f.client.breaker().retryAt!;
      const nextProbe = f.call();
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 3);
      f.pending[2]!.resolve(answered());
      expect((await nextProbe).outcome).toBe("answered");
    } finally { await f.dispose(); }
  });

  test(`a held ${status} retry expires with the probe's original abort signal`, async () => {
    const f = fixture({ timeoutMs: 40 });
    try {
      await f.open();
      const winner = f.call();
      f.pending[0]!.resolve(new Response("", { status }));
      await f.waitForPending(2);
      expect(f.attempts[3]!.signal).toBe(f.attempts[4]!.signal);
      expect((await f.call()).outcome).toBe("circuit_open");
      expect(f.attempts).toHaveLength(BREAKER_FAILURES + 2);
      expect((await winner).outcome).toBe("timeout");
      expect(f.attempts[3]!.signal.aborted).toBe(true);
      expect(f.client.breaker()).toEqual({
        open: true, consecutiveFailures: BREAKER_FAILURES + 1, retryAt: f.clock.t + 2 * BREAKER_BASE_MS,
      });
    } finally { await f.dispose(); }
  });
}

test("ordinary closed-breaker requests can run concurrently", async () => {
  const f = fixture({ initialFailures: 0 });
  try {
    const calls = [f.call(), f.call()];
    expect(f.attempts).toHaveLength(2);
    expect(f.pending).toHaveLength(2);
    for (const held of f.pending) held.resolve(answered());
    expect((await Promise.all(calls)).map((result) => result.answers)).toEqual([answers, answers]);
    expect(f.client.breaker()).toEqual({ open: false, consecutiveFailures: 0, retryAt: null });
  } finally { await f.dispose(); }
});

test("an earlier ordinary completion cannot release a pending probe", async () => {
  const f = fixture({ initialFailures: 0 });
  try {
    const earlier = f.call();
    for (let i = 0; i < BREAKER_FAILURES; i++) {
      const failed = f.call();
      f.pending[i + 1]!.resolve(new Response("", { status: 503 }));
      expect((await failed).outcome).toBe("http_error");
    }
    expect(f.client.breaker().open).toBe(true);
    f.clock.t = f.client.breaker().retryAt!;
    const probe = f.call();
    f.pending[0]!.resolve(answered());
    expect((await earlier).outcome).toBe("answered");
    expect(f.client.breaker().retryAt).toBeNull();
    const skipped = f.call();
    expect(f.attempts).toHaveLength(BREAKER_FAILURES + 2);
    expect((await skipped).outcome).toBe("circuit_open");
    f.pending[4]!.resolve(answered());
    expect((await probe).answers).toEqual(answers);
    const ordinary = f.call();
    expect(f.attempts).toHaveLength(BREAKER_FAILURES + 3);
    f.pending[5]!.resolve(answered());
    expect((await ordinary).outcome).toBe("answered");
  } finally { await f.dispose(); }
});

test("missing keys skip without reserving a probe or counting a failure", async () => {
  const f = fixture({ apiKey: null });
  try {
    expect(f.client.enabled).toBe(false);
    expect((await Promise.all([f.call(), f.call()])).map((result) => result.outcome)).toEqual(["no_key", "no_key"]);
    expect(f.attempts).toHaveLength(0);
    expect(f.client.breaker()).toEqual({ open: false, consecutiveFailures: 0, retryAt: null });
  } finally { await f.dispose(); }
});
