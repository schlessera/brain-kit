import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { httpContractApp } from "./helpers/http-contract-app";

test("mounted capture rejects incorrect JSON media, oversized bytes and missing content without invoking add", async () => {
  const t = await httpContractApp();
  try {
    const valid = JSON.stringify({ content: "Odysseus reaches the harbor." });
    expect(JSON.parse(valid).content.length).toBeGreaterThan(0);
    const media = await t.fetch("/api/brain/add", { method: "POST", headers: { "content-type": "text/plain" }, body: valid });
    expect(media.status).toBe(415);
    expect(await media.json()).toEqual({ error: "unsupported_media_type" });
    const oversized = JSON.stringify({ content: "x".repeat(262_144) });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(262_144);
    const limit = await t.fetch("/api/brain/add", { method: "POST", headers: { "content-type": "application/json" }, body: oversized });
    expect(limit.status).toBe(413);
    expect(await limit.json()).toEqual({ error: "Request body too large" });
    const empty = await t.fetch("/api/brain/add", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(empty.status).toBe(400);
    const calls = readFileSync(join(t.root, "cli.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((a: string[]) => a[0] === "add")).toBe(false);
    const admitted = await t.fetch("/api/brain/add", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: valid });
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({ success: true, indexed: false });
  } finally { await t.close(); }
});

test("mounted input validation returns route-specific errors for corpus, files, geometry and hidden models", async () => {
  const t = await httpContractApp();
  try {
    const search = await t.fetch("/api/brain/search");
    expect(search.status).toBe(400);
    expect((await search.json()).error).toBeString();
    for (const [path, error] of [["/api/files/content", "missing_path"], ["/api/files/content?path=../outside.md", "invalid_path"], ["/api/geo/coastline?bbox=0,0,90,90", "invalid_bbox"]]) {
      const response = await t.fetch(path!);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    const hidden = await t.fetch("/api/models/hidden", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ hidden: "fixture" }) });
    expect(hidden.status).toBe(400);
    expect(await hidden.json()).toEqual({ error: "hidden must be an array of profile ids" });
    expect((await (await t.fetch("/api/models")).json()).models).toHaveLength(1);
  } finally { await t.close(); }
});

test("mounted renderer validates input and returns configured PNG/PDF bytes with protected headers", async () => {
  const calls: Array<{ format: string; html: string }> = [];
  let fail = false;
  const t = await httpContractApp({ renderer: {
    renderPng: async (options) => { if (fail) throw new Error("Fixture renderer unavailable"); calls.push({ format: "png", html: options.html }); return Buffer.from("fixture-png"); },
    renderPdf: async (options) => { calls.push({ format: "pdf", html: options.html }); return Buffer.from("fixture-pdf"); },
  } });
  try {
    const invalid = await t.fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "", contentType: "markdown", format: "png" }) });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("invalid_request");
    expect(calls).toHaveLength(0);
    for (const format of ["png", "pdf"] as const) {
      const response = await t.fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# Arrival\n\nOdysseus reaches the harbor.", contentType: "markdown", format, title: "Arrival" }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(format === "png" ? "image/png" : "application/pdf");
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(`fixture-${format}`)));
      expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
      expect(response.headers.get("content-disposition")).toContain(`Arrival.${format}`);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(await response.text()).toBe(`fixture-${format}`);
    }
    expect(calls.map((c) => c.format)).toEqual(["png", "pdf"]);
    expect(calls.every((c) => c.html.includes("Odysseus reaches the harbor."))).toBe(true);
    fail = true;
    const failed = await t.fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# Arrival", contentType: "markdown", format: "png" }) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "render_failed", detail: "Fixture renderer unavailable" });
  } finally { await t.close(); }
});
