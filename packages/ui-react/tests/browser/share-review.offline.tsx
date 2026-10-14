/// <reference types="@vitest/browser-playwright" />
import { commands } from "vitest/browser";
import { expect, test } from "vitest";
import type {} from "./share-review/commands.js";
for (const scenario of ["reload", "auth", "race", "dismiss", "confirmed", "lost-response", "signout", "transfer", "transfer-signout", "partial", "ttl"] as const) test(`durable share review ${scenario}`, async () => {
  expect(await commands.shareReview(scenario)).toBe("passed");
}, 30_000);
