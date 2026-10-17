import { expect, test } from "bun:test";
import { buildSystemPromptAppend } from "../src/server/system-prompt.js";
test("an unfinished hardware probe never becomes a false camera or microphone absence", () => {
  const prompt = buildSystemPromptAppend({ client: { formFactor: "desktop", viewportWidth: 750 } });
  expect(prompt, "UNKNOWN_CAMERA_WITHHELD_FROM_ABSENCE").not.toContain("a camera");
  expect(prompt, "UNKNOWN_MICROPHONE_WITHHELD_FROM_ABSENCE").not.toContain("a microphone");
  const settled = buildSystemPromptAppend({ client: { formFactor: "desktop", camera: false, microphone: true } });
  expect(settled).toContain("Available: a microphone");
  expect(settled).toContain("NOT available: a camera");
});
