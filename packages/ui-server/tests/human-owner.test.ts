import { describe, expect, test } from "bun:test";

import { isHumanOwner, type Principal, type PrincipalAuthMethod, type PrincipalKind } from "../src/db/principals";

const NOW = 1_783_814_400_000;

function principal(kind: PrincipalKind, authMethod: PrincipalAuthMethod): Principal {
  return {
    id: `${kind}-${authMethod}`,
    kind,
    authMethod,
    label: "Odysseus",
    credentialId: null,
    createdBy: null,
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    lastSeenAt: null,
    revokedAt: null,
  };
}

describe("isHumanOwner", () => {
  test.each([
    ["owner by password", principal("owner", "password"), true],
    ["owner by passkey", principal("owner", "passkey"), true],
    ["ambient", principal("ambient", "ambient"), true],
    ["delegated agent", principal("agent", "delegated"), false],
    ["system", principal("system", "ambient"), false],
    ["owner kind with a delegated auth method", principal("owner", "delegated"), false],
    ["no principal", undefined, false],
    ["null principal", null, false],
  ] as const)("%s", (_name, candidate, expected) => {
    expect(isHumanOwner(candidate)).toBe(expected);
  });
});
