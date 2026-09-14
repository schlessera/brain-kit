import type { Principal } from "../../src/db/principals";
import type { AuthorizationContext } from "../../src/ws/clients";

export function testPrincipal(id = "test-principal"): Principal {
  return {
    id,
    kind: "owner",
    authMethod: "password",
    label: "Test device",
    credentialId: null,
    createdBy: null,
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    lastSeenAt: null,
    revokedAt: null,
  };
}

export function testAuthorization(principalId = "test-principal"): AuthorizationContext {
  return { principalId, expiresAt: Number.MAX_SAFE_INTEGER, valid: true };
}
