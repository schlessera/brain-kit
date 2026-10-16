import type { Logger } from "@opentelemetry/api-logs";
import { Hono } from "hono";
import { z } from "zod";
import type { RenderRequest } from "@schlessera/brain-ui-sdk/protocol";
import { prepareStaticDocument } from "@schlessera/brain-render-template/internal";
import { staticRendererFor } from "@schlessera/brain-ui-sdk/render";
import type { BrainClient } from "../brain/client.js";
import {
  readJsonBody,
  RENDER_BODY_LIMIT_BYTES,
} from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";

/**
 * A shared document may carry inlined images and pre-rendered mermaid SVGs.
 * The route's streaming reader owns its 5 MB request cap before JSON parsing;
 * the schema validates shape only so it cannot disagree by counting UTF-16
 * code units instead.
 */
/**
 * Rendering seam. The deployment owns the actual renderer process (e.g. the
 * network-denied headless Chrome in @schlessera/brain-render-puppeteer) and
 * injects these two functions via `createApp({ renderer })` — the package
 * itself never spawns a browser.
 */
export interface AppRenderer {
  renderPng(options: { html: string; linkPolicy?: "visible-destinations" }): Promise<Buffer | Uint8Array>;
  renderPdf(options: { html: string; linkPolicy?: "visible-destinations" }): Promise<Buffer | Uint8Array>;
}

const bodySchema = z.object({
  content: z.string().min(1),
  contentType: z.enum(["markdown", "html"]),
  format: z.enum(["png", "pdf"]),
  title: z.string().max(200).optional(),
}) satisfies z.ZodType<RenderRequest>;

export function createRenderRoutes(renderer?: AppRenderer, log?: Logger, brain?: BrainClient) {
  return new Hono().post("/render", requireJson(), async (c) => {
    if (!renderer) {
      return c.json(
        { error: "render_unavailable", detail: "This deployment has no renderer configured" },
        501
      );
    }

    let parsed;
    try {
      const result = await readJsonBody(c, RENDER_BODY_LIMIT_BYTES);
      if (result instanceof Response) return result;
      parsed = bodySchema.parse(result);
    } catch (err) {
      return c.json({ error: "invalid_request", detail: err instanceof Error ? err.message : "bad body" }, 400);
    }

    try {
      const linkPolicy = "visible-destinations" as const;
      // Metadata crosses the worker boundary; executable imports never do.
      const configured = parsed.contentType === "markdown" ? await brain?.modules?.() : undefined;
      const active = configured?.enabled.filter((mod) => mod.state === undefined || mod.state === "active") ?? [];
      const prepared = await prepareStaticDocument({ ...parsed, linkPolicy }, {
        rendererFor: (language) => active.some((mod) => Object.values(mod.renderers ?? {}).some((entry) => entry.static && entry.fences?.includes(language))) ? staticRendererFor(language) : null,
      });
      const { html } = prepared;
      if (prepared.warnings.length) {
        const warnings: Array<{ code: string; message: string }> = [];
        for (const warning of prepared.warnings) {
          const candidate = [...warnings, { code: warning.code, message: warning.message.slice(0, 200) }];
          if (encodeURIComponent(JSON.stringify(candidate)).length > 3500) break;
          warnings.push(candidate[candidate.length - 1]);
        }
        c.header("X-Brain-Render-Warnings", encodeURIComponent(JSON.stringify(warnings)));
        if (warnings.length < prepared.warnings.length) c.header("X-Brain-Render-Warnings-Truncated", "true");
      }
      const buf =
        parsed.format === "png"
          ? await renderer.renderPng({ html, linkPolicy })
          : await renderer.renderPdf({ html, linkPolicy });
      const filename = (parsed.title ?? "share")
        .replace(/[^a-z0-9_.-]+/gi, "_")
        .slice(0, 60) || "share";
      return c.newResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": parsed.format === "png" ? "image/png" : "application/pdf",
          "Content-Length": String(buf.byteLength),
          "Content-Disposition": `inline; filename="${filename}.${parsed.format}"`,
          "Cache-Control": "private, max-age=0, must-revalidate",
        },
      });
    } catch (err) {
      log?.emit({ severityText: "ERROR", body: "render failed", attributes: { error: err instanceof Error ? err.message : String(err) } });
      return c.json(
        { error: "render_failed", detail: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });
}
