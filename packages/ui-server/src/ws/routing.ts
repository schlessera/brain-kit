import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { BackendRegistry } from "../agent/backend.js";
import type { SessionCatalog } from "./session-catalog.js";

/**
 * Resolve one turn slot's pinned backend and profile. Resumed sessions route by
 * their stored backend id; new sessions route by the requested profile owner.
 */
export async function resolveTurnTarget(
  registry: BackendRegistry,
  catalog: SessionCatalog,
  sessionId: string | undefined,
  requested: string | undefined
): Promise<{ profileId?: string; backend: AgentBackend; droppedPin?: string }> {
  if (sessionId) {
    const backend = await registry.getBackendForSession(catalog.getStoredBackendId(sessionId));
    const stored = catalog.getStoredProviderId(sessionId);
    const available = await backend.listProfiles();
    if (stored && available.some((profile) => profile.id === stored)) {
      return { backend, profileId: stored };
    }
    // A stored pin that no longer resolves: fall back to the default profile
    // but report it (droppedPin) so the caller can surface the switch instead
    // of silently changing model/endpoint/billing with nothing in the logs.
    return { backend, ...(stored ? { droppedPin: stored } : {}) };
  }

  if (requested) {
    const available = await registry.listAllProviders();
    if (available.some((profile) => profile.id === requested)) {
      const backend = await registry.getBackendForProfile(requested);
      if (backend) return { backend, profileId: requested };
    }
  }

  const backend = await registry.getDefaultBackend();
  const profileId = (await backend.listProfiles())[0]?.id;
  return { backend, ...(profileId ? { profileId } : {}) };
}
