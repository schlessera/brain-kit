import { expect, test } from "bun:test";
import { createConversationRecovery } from "../src/voice/conversation-recovery.js";

test("output gap: speaking cannot recover; endpoint starts a fresh 300 ms check", () => {
  const r = createConversationRecovery();
  r.suppress(true, 0);
  expect(r.poll(5000)).toBe("speaking");
  r.endpoint(5000);
  expect(r.poll(5299)).toBe("checking");
  expect(r.poll(5300)).toBe("audible");
});
test("late nonzero output resets quiet evidence but never extends the fixed deadline", () => {
  const r = createConversationRecovery(); r.suppress(false, 0);
  for (let time = 200; time < 3000; time += 200) {
    r.observe(new Uint8Array([1, 0]), time);
    expect(r.poll(time)).toBe("checking");
  }
  expect(r.poll(3000)).toBe("muted");
  r.observe(new Uint8Array(4800), 3100);
  expect(r.poll(3300)).toBe("muted");
});
test("digital zero and absent packets can segment output; a late timer cannot reopen it", () => {
  const r = createConversationRecovery(); r.suppress(false, 0);
  r.observe(new Uint8Array(4800), 200);
  expect(r.poll(300)).toBe("audible");
  r.suppress(false, 400);
  expect(r.poll(3400)).toBe("muted");
  r.reset(); expect(r.poll(5000)).toBe("audible");
});
test("new speech resets earlier evidence and manual recovery is explicit", () => {
  const r = createConversationRecovery(); r.suppress(false, 0);
  r.suppress(true, 299); expect(r.poll(600)).toBe("speaking");
  r.endpoint(1000); expect(r.poll(1299)).toBe("checking");
  r.observe(new Uint8Array([1, 0]), 1299);
  expect(r.poll(1598)).toBe("checking");
  expect(r.poll(1599)).toBe("audible");
});
