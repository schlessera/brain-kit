/**
 * The measurement harness's live-credential selection for the `show_block`
 * schema-forms A/B (`scripts/show-block-schema-forms.ts`). Split from
 * tests/show-block-schema-forms.test.ts (#1386), which keeps the shipped-schema
 * guarantees; this file covers only how the harness would authenticate a live
 * run, which nothing shipped does.
 */

import { describe, expect, test } from "bun:test";

import { liveCredential, OAUTH_BETA } from "../scripts/show-block-schema-forms.ts";

describe("the live credential", () => {
  test("an API key wins, and goes out as x-api-key", () => {
    const credential = liveCredential({ ANTHROPIC_API_KEY: "key", CLAUDE_CODE_OAUTH_TOKEN: "token" });
    expect(credential?.source).toBe("ANTHROPIC_API_KEY");
    expect(credential?.headers["x-api-key"]).toBe("key");
    expect(credential?.headers.authorization).toBeUndefined();
  });

  test("with no key, the subscription token goes out as a bearer with the OAuth beta", () => {
    const credential = liveCredential({ ANTHROPIC_API_KEY: " ", CLAUDE_CODE_OAUTH_TOKEN: "token" });
    expect(credential?.source).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(credential?.headers.authorization).toBe("Bearer token");
    expect(credential?.headers["anthropic-beta"]).toBe(OAUTH_BETA);
    expect(credential?.headers["x-api-key"]).toBeUndefined();
  });

  test("with neither, there is no live run", () => {
    expect(liveCredential({})).toBeNull();
  });
});

