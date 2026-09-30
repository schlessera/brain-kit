import { describe, expect, test } from "bun:test";
import { createRenderRoutes } from "../src/routes/render";

const RENDER_MAX_REQUEST_BYTES = 5_000_000;

describe("POST /render", () => {
  test("rejects a multibyte body over 5 MB even when its UTF-16 length is under the cap", async () => {
    const emptyBody = JSON.stringify({
      content: "",
      contentType: "markdown",
      format: "png",
    });
    const content = "\u00e9".repeat(
      Math.floor(
        (RENDER_MAX_REQUEST_BYTES - Buffer.byteLength(emptyBody)) / 2
      ) + 1
    );
    const body = JSON.stringify({
      content,
      contentType: "markdown",
      format: "png",
    });

    expect(content.length).toBeLessThan(RENDER_MAX_REQUEST_BYTES);
    expect(Buffer.byteLength(body)).toBeGreaterThan(RENDER_MAX_REQUEST_BYTES);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      RENDER_MAX_REQUEST_BYTES + 2
    );

    const routes = createRenderRoutes({
      renderPng: async () => Buffer.from("png"),
      renderPdf: async () => Buffer.from("pdf"),
    });
    const response = await routes.request("/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(413);
  });
});

const exportCases = [
  ["html", '<!doctype html><html><head><title>Links</title></head><body><a href="https://odysseus:secret@unsafe.example/">Words</a><a href="https://ithaca-harbour.example/tides">Tides</a></body></html>'],
  ["markdown", "[Words](https://odysseus:secret@unsafe.example/)\n\n[Tides](https://ithaca-harbour.example/tides)"],
  ["html", '<a href="https://odysseus:secret@unsafe.example/">Words</a><a href="https://ithaca-harbour.example/tides">Tides</a>'],
  ["html", '<!doctype html><html><head><meta name="brain-render" content="bare"></head><body><a href="https://odysseus:secret@unsafe.example/">Words</a><a href="https://ithaca-harbour.example/tides">Tides</a></body></html>'],
] as const;
for (const format of ["png", "pdf"] as const) {
  test.each(exportCases)(`${format}: server enables the policy for %s despite a request opt-out`, async (contentType, content) => {
    const received: { html: string; linkPolicy?: string }[] = [];
    const render = async (options: { html: string; linkPolicy?: string }) => { received.push(options); return Buffer.from(format); };
    const routes = createRenderRoutes({ renderPng: render, renderPdf: render });
    const response = await routes.request("/render", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, contentType, format, linkPolicy: false }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(format);
    expect(received).toHaveLength(1);
    expect(received[0].linkPolicy).toBe("visible-destinations");
    expect(received[0].html).toContain("link withheld");
    expect(received[0].html).not.toContain("secret@unsafe.example");
    expect(received[0].html).toContain("ithaca-harbour.example");
    expect(received[0].html).toContain("data-brain-link-destination");
  });
}
