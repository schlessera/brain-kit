/// <reference types="@vitest/browser-playwright" />
import { commands } from "vitest/browser";

/**
 * Stop a hygiene fixture from a test's teardown. `stop` waits for every
 * request the page route forwarded, and a held plan, check, resolve, details
 * read or next selection never answers until it is released. So a test that
 * fails while one is held would turn its assertion into a hook timeout with no
 * failure detail (#3657). Release every hold first, then stop (#3665).
 */
export async function stopHygieneFixture(id: string): Promise<void> {
  try { await commands.hygieneServer({ op: "set", id, patch: { releaseAll: true } }); }
  finally { await commands.hygieneServer({ op: "stop", id }); }
}
