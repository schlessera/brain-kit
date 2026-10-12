import { Hono } from "hono";
import type { TurnJournal } from "../brain/turn-journal.js";

const INLINE_BYTES = 256 * 1024;
const INLINE_LINES = 5_000;

/** Mounted behind the same authenticated owner boundary as session history. */
export function createJournalRoutes({ journal }: { journal: TurnJournal }): Hono {
  return new Hono()
    .get("/sessions/:sessionId/turns/:turnId/journal", c => {
      const details = journal.details(c.req.param("sessionId"), c.req.param("turnId"));
      return details ? c.json(details) : c.json({ error: "No retained journal is available for this turn." }, 404);
    })
    .get("/sessions/:sessionId/turns/:turnId/journal/:sequence/preview", c => {
      const session = c.req.param("sessionId"), turn = c.req.param("turnId"), sequence = Number(c.req.param("sequence"));
      if (!Number.isSafeInteger(sequence) || sequence < 1) return c.json({ error: "Invalid observation." }, 400);
      const details = journal.details(session, turn), change = details?.changes.find(item => item.sequence === sequence);
      if (!change || details?.summary.state === "expired") return c.json({ error: "Journal detail expired or unavailable." }, 404);
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
    .get("/sessions/:sessionId/turns/:turnId/journal/:sequence/:side", c => {
      const sequence = Number(c.req.param("sequence")), side = c.req.param("side");
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !["before", "after"].includes(side)) return c.json({ error: "Invalid retained version." }, 400);
      const version = journal.version(c.req.param("sessionId"), c.req.param("turnId"), sequence, side as "before" | "after");
      if (!version) return c.json({ error: "Journal detail expired or unavailable." }, 404);
      try {
        const stream = version.stream();
        return new Response(stream.body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(stream.bytes), "Content-Disposition": `attachment; filename="journal-${sequence}-${side}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      } catch { return c.json({ error: "Retained version is temporarily unavailable." }, 503); }
    });
}
