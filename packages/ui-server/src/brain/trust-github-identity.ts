/** Fixed host metadata for one human Settings operation, independent of an agent turn. */
import type { TrustSelector } from "@schlessera/brain-common/internal/governance-policy";
import { startEgressProxy } from "@schlessera/brain-ui-sdk/internal";
import type { createGitHubReferenceAccess } from "./github-reference-access.js";
import { createGovernancePolicyReader } from "./governance-policy.js";
import { ReferenceTransportError } from "./reference-transport.js";

type GitHubSelector = Extract<TrustSelector, { kind: "github_repository" | "github_owner" }>;
export interface TrustGitHubIdentity {
  selector: GitHubSelector;
  ownerId: string;
  private: boolean | null;
}

/** Identity data is retained with the reviewed bytes; the callback is host-only and ephemeral. */
export function createTrustGitHubIdentity(options: {
  root: string;
  access: Pick<ReturnType<typeof createGitHubReferenceAccess>, "owner" | "repository">;
}) {
  const reader = createGovernancePolicyReader(options.root);
  return {
    async resolve(input: { principalId: string; selector: GitHubSelector; policyHash: string | null;
      current(): boolean; signal?: AbortSignal }) {
      const { principalId, current, signal, policyHash } = input, selector = structuredClone(input.selector);
      const check = () => {
        signal?.throwIfAborted();
        if (!current()) throw new ReferenceTransportError("denied", "The Settings owner operation ended.");
      };
      check();
      const loaded = reader.load();
      if (loaded.errors.length || loaded.hash !== policyHash) throw new ReferenceTransportError("denied", "The reviewed policy base changed.");
      // Metadata is a fixed read initiated by the human, outside any model
      // conversation. Ordinary host allow/deny and byte controls still apply.
      const maxBytes = Math.min(1048576, loaded.policy.egress.max_bytes_per_turn ?? 1048576);
      const egress = await startEgressProxy({ mode: loaded.policy.egress.mode, allow: loaded.policy.egress.allow,
        deny: loaded.policy.egress.deny, maxBytes, outwardHosts: [], signal, observe() {} });
      try {
        check();
        const bounds = { principalId, egress, maxBytes, timeoutMs: 30000, current, signal };
        let identity: TrustGitHubIdentity, assertAuthority: () => void;
        if (selector.kind === "github_owner") {
          const observed = await options.access.owner({ ...bounds, owner: selector.owner });
          if (observed.ownerId !== selector.ownerId) throw new ReferenceTransportError("denied", "The requested owner identity differs from current metadata.");
          identity = { selector, ownerId: observed.ownerId, private: null };
          assertAuthority = check;
        } else {
          // A selector already contains a canonical name: add the clone suffix
          // exactly once so a literal repository suffix remains literal.
          const observed = await options.access.repository({ ...bounds, repository: `https://github.com/${selector.owner}/${selector.repository}.git` });
          if (observed.repositoryId !== selector.repositoryId) throw new ReferenceTransportError("denied", "The requested repository identity differs from current metadata.");
          identity = { selector, ownerId: observed.ownerId, private: observed.private };
          assertAuthority = () => { check(); observed.assertAuthority(); };
        }
        assertAuthority();
        return { identity, networkBytes: maxBytes - egress.remainingBytes(), assertAuthority };
      } finally { egress.stop(); }
    },
  };
}
