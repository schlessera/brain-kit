/**
 * `SAFETY_READ_CAPABILITIES` is a literal in a zod-free leaf (#4796), so the
 * protocol module re-exports it without loading the safety schemas. These pin
 * that the literal still parses unchanged through its schema and keeps the
 * value it had as a parse result.
 */
import { expect, test } from "bun:test";
import { SAFETY_READ_CAPABILITIES as fromProtocol, SESSION_SAFETY_CAPABILITY as protocolCapability } from "../src/protocol";
import { SAFETY_READ_CAPABILITIES, SESSION_SAFETY_CAPABILITY, safetyCapabilitiesSchema } from "../src/safety";

test("the read capabilities literal is what its schema parses it to", () => {
  expect(safetyCapabilitiesSchema.parse(SAFETY_READ_CAPABILITIES)).toEqual(SAFETY_READ_CAPABILITIES);
});

test("the read capabilities keep the value they had as a parse result", () => {
  expect(SAFETY_READ_CAPABILITIES).toEqual({
    version: 1, read: true, review: false, originRules: false, repositoryRules: false, recipientRules: false,
    readOnlyReason: "review_unavailable", detectorVersion: 1,
    limits: { pageRecords: 100, frameBytes: 262144, cursorBytes: 512, cursorLifetimeMs: 300000 },
  });
});

test("the protocol module exports the same constants as the safety module", () => {
  expect(fromProtocol).toBe(SAFETY_READ_CAPABILITIES);
  expect(protocolCapability).toBe(SESSION_SAFETY_CAPABILITY);
  expect(SESSION_SAFETY_CAPABILITY).toBe("sessionSafetyHistory");
});
