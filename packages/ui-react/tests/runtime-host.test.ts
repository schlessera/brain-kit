import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { CHROME_PATHS, CHROME_REQUIRED, chromePath } from "./fixtures/runtime-host";

// The Chrome rule every ui-react runtime file shares (#4841): which Chrome is
// found first, and what a run without one does.
const none = () => false;
const only = (...present: string[]) => (path: string) => present.includes(path);

describe("chromePath", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());
  afterAll(() => warn.mockRestore());

  test("no Chrome and no flag skips with one warning naming the file", () => {
    expect(chromePath("odysseus-skip-runtime.test.ts", {}, none)).toBeUndefined();
    expect(chromePath("odysseus-skip-runtime.test.ts", { BRAIN_REQUIRE_CHROME: "0" }, none)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("odysseus-skip-runtime.test.ts");
  });

  test("no Chrome with BRAIN_REQUIRE_CHROME=1 throws the fixed message", () => {
    expect(() => chromePath("odysseus-required-runtime.test.ts", { BRAIN_REQUIRE_CHROME: "1" }, none)).toThrow(CHROME_REQUIRED);
    expect(warn).not.toHaveBeenCalled();
  });

  test("PUPPETEER_EXECUTABLE_PATH wins over BRAIN_UI_CHROME_PATH, which wins over the fallbacks", () => {
    const env = { PUPPETEER_EXECUTABLE_PATH: "/opt/ithaca/chrome", BRAIN_UI_CHROME_PATH: "/opt/troy/chrome", BRAIN_REQUIRE_CHROME: "1" };
    expect(chromePath("odysseus-order-runtime.test.ts", env, only(env.PUPPETEER_EXECUTABLE_PATH, env.BRAIN_UI_CHROME_PATH, ...CHROME_PATHS))).toBe("/opt/ithaca/chrome");
    expect(chromePath("odysseus-order-runtime.test.ts", env, only(env.BRAIN_UI_CHROME_PATH, ...CHROME_PATHS))).toBe("/opt/troy/chrome");
    expect(chromePath("odysseus-order-runtime.test.ts", env, only(...CHROME_PATHS))).toBe(CHROME_PATHS[0]);
    expect(chromePath("odysseus-order-runtime.test.ts", env, only(CHROME_PATHS[3]))).toBe(CHROME_PATHS[3]);
    expect(warn).not.toHaveBeenCalled();
  });
});
