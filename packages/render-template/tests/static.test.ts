import { expect, test } from "bun:test";
import { prepareStaticDocument } from "../src/static";
const opts = { content: "```relay\nRaft ready\n```", contentType: "markdown" as const };
test("registered fences become SVG with print white ground", async () => {
  const result = await prepareStaticDocument(opts, { rendererFor: () => ({ needsBrowser: false, async toStatic(source, { theme }) { expect(theme).toBe("print"); return `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ffffff"/><text>${source}</text></svg>`; } }) });
  expect(result.html).toContain('<rect fill="#ffffff"/>');
  expect(result.html).not.toContain("language-relay");
  expect(result.warnings).toEqual([]);
});
test("throwing and unsafe entries retain source with named diagnostics", async () => {
  for (const toStatic of [async () => { throw new Error("bad graph"); }, async () => '<script>alert(1)</script>', async () => '<img src="https://ithaca.example/raft.svg">', async () => '<svg><image href="https://ithaca.example/a"/></svg>']) {
    const result = await prepareStaticDocument(opts, { rendererFor: () => ({ needsBrowser: false, toStatic }) });
    expect(result.html).toContain("language-relay");
    expect(result.html).toContain("Raft ready");
    expect(result.html).not.toContain("<script>");
    expect(result.warnings[0].message).toContain("Fence 1 (relay)");
  }
});
test("unknown and browser-only entries stay code without executing", async () => {
  const result = await prepareStaticDocument(opts, { rendererFor: () => ({ needsBrowser: true, async toStatic() { throw new Error("must not execute"); } }) });
  expect(result.html).toContain("language-relay"); expect(result.warnings).toEqual([]);
});
test("nested fences and inline code preserve markdown semantics", async () => {
  const result = await prepareStaticDocument({ ...opts, content: "> ```relay\n> Raft ready\n> ```\n\n`relay`" }, { rendererFor: () => ({ needsBrowser: false, async toStatic() { return "<svg><text>Ready</text></svg>"; } }) });
  expect(result.html).toContain("<blockquote>"); expect(result.html).toContain("<svg>"); expect(result.html).toContain("<code>relay</code>");
});
test("local SVG resolver embeds image data before template placeholders", async () => {
  const result = await prepareStaticDocument({ ...opts, content: "![Raft](raft.svg)" }, { localSvg: async () => "data:image/svg+xml;base64,PHN2Zy8+" });
  expect(result.html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
});
