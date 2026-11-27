import { Hono } from "hono";
import { readJsonBody } from "../middleware/body-limit.js";
import type { AppEnv } from "../app-env.js";
import { isHumanOwner } from "../db/principals.js";
import type { CodeChangeHistory } from "../brain/code-change-history.js";
import type { TurnJournal } from "../brain/turn-journal.js";

const INLINE_BYTES = 256 * 1024;
const INLINE_LINES = 5_000;

/** Mounted behind the same authenticated owner boundary as session history. */
export function createJournalRoutes({ journal, codeHistory }: { journal: TurnJournal; codeHistory?: CodeChangeHistory }): Hono<AppEnv> {
  return new Hono<AppEnv>()
    // Brain-wide, not per turn: what the latest complete turn could not trace (#3257).
    .get("/journal/configuration-coverage", c => {
      c.header("Cache-Control", "private, no-store");
      return c.json(journal.configurationCoverage());
    })
    .get("/sessions/:sessionId/turns/:turnId/journal", c => {
      const details = journal.details(c.req.param("sessionId"), c.req.param("turnId"));
      return details ? c.json(details) : c.json({ error: "No retained journal is available for this turn." }, 404);
    })
    .get("/sessions/:sessionId/turns/:turnId/journal/code/preview", async c => {
      c.header("Cache-Control", "private, no-store");
      const principal = c.get("principal");
      if (!principal || !isHumanOwner(principal)) return c.json({ error: "Owner authorization required." }, 403);
      const checkout = c.req.query("checkout");
      if (!checkout) return c.json({ error: "Choose a checkout receipt." }, 400);
      try { return c.json(await journal.codePreview(c.req.param("sessionId"), c.req.param("turnId"), checkout)); }
      catch { return c.json({ error: "Code change evidence is unavailable." }, 409); }
    })
    .get("/sessions/:sessionId/turns/:turnId/journal/code/revert/:id", c => {
      c.header("Cache-Control", "private, no-store");
      const principal = c.get("principal");
      if (!principal || !isHumanOwner(principal)) return c.json({ error: "Owner authorization required." }, 403);
      const result = codeHistory?.read(c.req.param("id"), principal.id, c.req.param("sessionId"), c.req.param("turnId"));
      return result ? c.json(result) : c.json({ error: "No such code history operation." }, 404);
    })
    .post("/sessions/:sessionId/turns/:turnId/journal/code/revert", async c => {
      c.header("Cache-Control", "private, no-store");
      const principal = c.get("principal");
      if (!principal || !isHumanOwner(principal)) return c.json({ error: "Owner authorization required." }, 403);
      let request: unknown;
      try { request = await readJsonBody(c); } catch { return c.json({ error: "Invalid code history selection." }, 400); }
      if (request instanceof Response) return request;
      if (!request || typeof request !== "object" || Array.isArray(request)) return c.json({ error: "Invalid code history selection." }, 400);
      const { id, checkout } = request as { id?: unknown; checkout?: unknown };
      if (Object.keys(request).some(key => !["id", "checkout"].includes(key)) || typeof id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
        || typeof checkout !== "string" || checkout.length > 1024) return c.json({ error: "Invalid code history selection." }, 400);
      if (!codeHistory) return c.json({ error: "Code history actions are unavailable." }, 503);
      try { return c.json(await codeHistory.revert(id, principal.id, c.req.param("sessionId"), c.req.param("turnId"), checkout)); }
      catch { return c.json({ error: "Code history is unavailable or no longer eligible; no effect was retried." }, 409); }
    })
    .get("/sessions/:sessionId/turns/:turnId/journal/:sequence/preview", c => {
      const session = c.req.param("sessionId"), turn = c.req.param("turnId"), sequence = Number(c.req.param("sequence"));
      if (!Number.isSafeInteger(sequence) || sequence < 1) return c.json({ error: "Invalid observation." }, 400);
      const details = journal.details(session, turn), change = details?.changes.find(item => item.sequence === sequence);
      if (!change || details?.summary.state === "expired") return c.json({ error: "Journal detail expired or unavailable." }, 404);
      if (change.before?.metadataOnly || change.after?.metadataOnly) return c.json({ inline: false, reason: "metadata_only" });
      const size = (change.before?.bytes ?? 0) + (change.after?.bytes ?? 0);
      if (size > INLINE_BYTES) return c.json({ inline: false, reason: "size", beforeBytes: change.before?.bytes ?? 0, afterBytes: change.after?.bytes ?? 0 });
      try {
        const text = (side: "before" | "after") => {
          const version = change[side]; if (!version) return "";
          if (version.kind === "symlink") return version.target ?? "";
          const retained = journal.version(session, turn, sequence, side); if (!retained) return null;
          const bytes = retained.bytes(INLINE_BYTES);
          if (bytes.some(byte => byte === 0 || byte < 32 && ![9, 10, 13].includes(byte))) return null;
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        };
        const before = text("before"), after = text("after");
        if (before === null || after === null) return c.json({ inline: false, reason: "binary_or_unavailable" });
        const lines = (text: string) => text ? text.split("\n").length : 0;
        if (lines(before) + lines(after) > INLINE_LINES) return c.json({ inline: false, reason: "lines" });
        return c.json({ inline: true, before, after });
      } catch { return c.json({ inline: false, reason: "binary_or_unavailable" }); }
    })
    .get("/sessions/:sessionId/turns/:turnId/journal/:sequence/:side", async c => {
      const sequence = Number(c.req.param("sequence")), side = c.req.param("side");
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !["before", "after"].includes(side)) return c.json({ error: "Invalid retained version." }, 400);
      const version = journal.version(c.req.param("sessionId"), c.req.param("turnId"), sequence, side as "before" | "after");
      if (!version) return c.json({ error: "Journal detail expired or unavailable." }, 404);
      try {
        const stream = await version.stream();
        return new Response(stream.body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(stream.bytes), "Content-Disposition": `attachment; filename="journal-${sequence}-${side}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      } catch { return c.json({ error: "Retained version is temporarily unavailable." }, 503); }
    });
}
