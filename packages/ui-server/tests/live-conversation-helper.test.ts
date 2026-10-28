import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { fakeLiveProvider } from "./helpers/live-conversation";

async function setup() {
  const controller = new AbortController();
  const { provider, sessions } = fakeLiveProvider();
  const session = await provider.open(
    { conversationId: "conversation-ithaca", epoch: 1 },
    { signal: controller.signal, resync: { work: [] } },
  );
  const iterator = session.events[Symbol.asyncIterator]();
  const record = sessions[0]!;
  const listeners = () => getEventListeners(controller.signal, "abort").length;
  const emit = (sequence: number) => record.emit({ kind: "output_transcript", outputId: "output-ithaca", sequence, text: `Ithaca ${sequence}` });
  const cleanup = async () => {
    record.end();
    controller.abort();
    await iterator.return?.();
    await session.close();
  };
  return { controller, session, iterator, record, listeners, emit, cleanup };
}

test("completed fake-provider stream must release abort listeners", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 20; i++) {
      const next = f.iterator.next();
      f.emit(i);
      expect((await next).done).toBe(false);
    }
    const next = f.iterator.next();
    f.record.end();
    expect((await next).done).toBe(true);
    expect(f.listeners(), "completed fake-provider stream must release abort listeners").toBe(0);
  } finally {
    await f.cleanup();
  }
});

for (const terminal of ["end", "close", "return", "abort"] as const) {
  test(`fake provider owns only its current wait listener through ${terminal}`, async () => {
    const f = await setup();
    // An unrelated listener belongs to the caller and must survive cleanup.
    const unrelated = () => {};
    f.controller.signal.addEventListener("abort", unrelated);
    try {
      for (let i = 0; i < 20; i++) {
        const next = f.iterator.next();
        expect(f.listeners()).toBe(2);
        f.emit(i);
        expect((await next).value).toMatchObject({ sequence: i, conversationId: "conversation-ithaca", epoch: 1 });
        expect(f.listeners(), "ordinary wake releases the owned listener").toBe(1);
      }
      if (terminal === "return") {
        expect((await f.iterator.return!()).done).toBe(true);
      } else {
        const next = f.iterator.next();
        expect(f.listeners()).toBe(2);
        if (terminal === "end") f.record.end();
        if (terminal === "close") await f.session.close();
        if (terminal === "abort") f.controller.abort();
        expect((await next).done).toBe(true);
      }
      expect(f.listeners()).toBe(1);
      expect(getEventListeners(f.controller.signal, "abort")).toEqual([unrelated]);
      expect((await f.iterator.next()).done).toBe(true);
    } finally {
      f.controller.signal.removeEventListener("abort", unrelated);
      await f.cleanup();
    }
  });
}

test("fake provider drains queued events in order before cancellation", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 20; i++) f.emit(i);
    f.controller.abort();
    f.record.end();
    for (let i = 0; i < 20; i++) {
      expect((await f.iterator.next()).value).toMatchObject({ sequence: i });
      expect(f.listeners()).toBe(0);
    }
    expect((await f.iterator.next()).done).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("fake provider return queued behind a pending next completes after end wakes it", async () => {
  const f = await setup();
  try {
    let returned = false;
    const next = f.iterator.next();
    const finish = f.iterator.return!().then((result) => { returned = true; return result; });
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(f.listeners()).toBe(1);
    f.record.end();
    expect((await next).done).toBe(true);
    expect((await finish).done).toBe(true);
    expect(f.listeners()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("fake provider already aborted before iteration never installs a wait listener", async () => {
  const f = await setup();
  try {
    f.controller.abort();
    expect((await f.iterator.next()).done).toBe(true);
    expect(f.listeners()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
