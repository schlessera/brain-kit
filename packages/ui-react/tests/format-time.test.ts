import { describe, expect, test } from "bun:test";
import { clockTime } from "../src/lib/format-time.js";

// #4736: one clock time, 24-hour `HH:MM` in the reader's zone. The inputs are
// built from local components, so the result does not depend on the
// machine's time zone.
describe("clockTime", () => {
  test("pads the hour at midnight", () => {
    expect(clockTime(new Date(2026, 6, 12, 0, 5).getTime())).toBe("00:05");
  });
  test("prints the evening on a 24-hour clock", () => {
    expect(clockTime(new Date(2026, 6, 12, 21, 41).getTime())).toBe("21:41");
  });
});
