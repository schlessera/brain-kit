// Every streamed brain job ends on a `done` frame (#131). The panels leave
// their loading state only on one, so a handler that unwinds past its final
// `send` strands the client. The failure forced here is the real one: a
// configured exec wrapper that does not exist makes `Bun.spawn` itself throw.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainRoutes } from "../src/routes/brain";
import type { BrainClient } from "../src/brain/client";
import type { KeytermSettings } from "../src/voice/keyterm-builder";

const MISSING_WRAPPER = "/nonexistent/brain-ui-exec-wrapper";

/** The `data:` frames of an SSE body, parsed; pings and comments dropped. */
function frames(body: string): Array<{ type: string; text?: string; success?: boolean }> {
  return body
    .split("\n\n")
    .map((event) => event.split("\n").find((l) => l.startsWith("data: ")))
    .filter((line): line is string => line !== undefined && line.length > 6)
    .map((line) => JSON.parse(line.slice(6)));
}

describe("SSE brain jobs end on a done frame when the spawn throws", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "brain-sse-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const app = () =>
    createBrainRoutes({
      brainPath: root,
      brain: { cliCommand: () => [process.execPath, "brain"] } as unknown as BrainClient,
      keyterms: { brainPath: root } as KeytermSettings,
      exec: { wrapper: MISSING_WRAPPER },
    });

  for (const [route, setup] of [
    ["/brain/sync", () => {}],
  ] as const) {
    test(`${route}: a failed done frame carrying the error`, async () => {
      setup();
      const response = await app().request(route, { method: "POST" });
      expect(response.status).toBe(200);
      const sent = frames(await response.text());
      const last = sent.at(-1);
      expect(last?.type).toBe("done");
      expect(last?.success).toBe(false);
      expect(last?.text).toContain(MISSING_WRAPPER);
      expect(sent.filter((f) => f.type === "done")).toHaveLength(1);
    });
  }
});
