import { expect, test } from "bun:test";
import { softwareDetails } from "../src/lib/stats/software.js";

const client = { release: "1.2.3", sourceCommit: "a".repeat(40) };
test("matching metadata verifies only what both peers report", () => {
  expect(softwareDetails({ client, server: { ok: true, value: client } }).state).toBe("Release and build match");
});
test("missing and development metadata never verify a match", () => {
  for (const marker of [null, "", "dev", "unknown", "development"]) {
    const identity = { release: "1.2.3", sourceCommit: marker };
    expect(softwareDetails({ client: identity, server: { ok: true, value: identity } }).state).toBe("Build match unverified");
  }
});
test("different releases or application commits are visible independently", () => {
  for (const value of [{ ...client, release: "1.2.4" }, { ...client, sourceCommit: "b".repeat(40) }]) {
    expect(softwareDetails({ client, server: { ok: true, value } }).state).toBe("Client and server differ");
  }
});
