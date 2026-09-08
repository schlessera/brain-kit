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
