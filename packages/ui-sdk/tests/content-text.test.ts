/** The text parts of a runtime content array (#4720). */
import { describe, expect, test } from "bun:test";
import { textOfParts, textParts } from "../src/server/index";

describe("textOfParts", () => {
  const mixed = [{ type: "text", text: "Ithaca" }, { type: "image", data: "aXRoYWNh" }, { type: "text", text: "lies west" }, { type: "tool_use", text: "not text" }];

  test("keeps only text parts, in order, and joins them with the separator given", () => {
    expect(textParts(mixed)).toEqual(["Ithaca", "lies west"]);
    expect(textOfParts(mixed, "")).toBe("Ithacalies west");
    expect(textOfParts(mixed, "\n")).toBe("Ithaca\nlies west");
  });

  test("skips a text part whose text is not a string, and a part that is not an object", () => {
    const content = [{ type: "text", text: 7 }, { type: "text" }, null, "text", { type: "text", text: "Penelope" }];
    expect(textParts(content)).toEqual(["Penelope"]);
    expect(textOfParts(content, "\n")).toBe("Penelope");
  });

  test("a non-array yields no parts", () => {
    for (const content of [undefined, null, "Telemachus", { type: "text", text: "Telemachus" }, 3]) {
      expect(textParts(content)).toEqual([]);
      expect(textOfParts(content, "\n")).toBe("");
    }
  });
});
