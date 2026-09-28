/**
 * `holdOpenLink`: the tail of a streaming answer that is still becoming a
 * link is held back (#551, design §7 and criterion 18).
 */
import { describe, expect, test } from "bun:test";

import { HOLD_MAX, holdOpenLink } from "../src/lib/stream-link-hold.js";

const shown = (buffer: string) => holdOpenLink(buffer).shown;

describe("holdOpenLink", () => {
  test("an unclosed link destination is held from its [", () => {
    expect(holdOpenLink("a [b](https://x")).toEqual({ shown: "a ", held: "[b](https://x" });
    expect(shown("a [b](https://x.example/(tides)")).toBe("a ");
    expect(shown("a [b](https://x.example/(tides))")).toBe("a [b](https://x.example/(tides))");
  });

  test("an unclosed [ is held, and so is a closed [text] that ends the buffer", () => {
    expect(shown("a [your ba")).toBe("a ");
    expect(shown("a [your bank]")).toBe("a ");
    expect(shown("a [your bank] and more")).toBe("a [your bank] and more");
    expect(shown("a [outer [inner](https://x")).toBe("a ");
  });

  test("an image's ! goes with its [", () => {
    expect(shown("see ![chart](https://x")).toBe("see ");
  });

  test("a bare address touching the end is held until something ends it", () => {
    expect(shown("see https://x.exa")).toBe("see ");
    expect(shown("see www.x.exa")).toBe("see ");
    expect(shown("write to mailto:pene")).toBe("write to ");
    expect(shown("write to penelope@ithaca.exa")).toBe("write to ");
    expect(shown("see https://x.example ")).toBe("see https://x.example ");
    expect(shown("(see https://x.example)")).toBe("(see https://x.example)");
    expect(shown("see https://x.example, then")).toBe("see https://x.example, then");
  });

  test("code spans and fences never hold", () => {
    expect(shown("run `a[0](x")).toBe("run `a[0](x");
    expect(shown("run `a[0](x)` and `https://x.example`")).toBe("run `a[0](x)` and `https://x.example`");
    expect(shown("run `code` then [b](https://x")).toBe("run `code` then ");
    expect(shown("```ts\nconst a = [b](https://x")).toBe("```ts\nconst a = [b](https://x");
    expect(shown("```ts\nx\n```\nthen [b](https://x")).toBe("```ts\nx\n```\nthen ");
  });

  test("a newline ends the hold", () => {
    expect(shown("a [b\n")).toBe("a [b\n");
    expect(shown("see https://x.example\nand [b](https://y")).toBe("see https://x.example\nand ");
  });

  test("an escaped [ is text", () => {
    expect(shown("a \\[b")).toBe("a \\[b");
    // Not a link, but its address is still a bare one the autolinker takes.
    expect(shown("a \\[b](https://x")).toBe("a \\[b](");
  });

  test(`a tail longer than ${HOLD_MAX} characters is released as literal text`, () => {
    const at = "a [b](https://x.example/";
    const fits = at + "p".repeat(HOLD_MAX - at.length + 2);
    expect(holdOpenLink(fits).held).toHaveLength(HOLD_MAX);
    expect(shown(fits)).toBe("a ");
    expect(shown(fits + "p")).toBe(fits + "p");
  });

  test("a buffer with nothing open is shown whole", () => {
    expect(holdOpenLink("Tides are high before dawn.")).toEqual({ shown: "Tides are high before dawn.", held: "" });
    expect(shown("")).toBe("");
  });
});
