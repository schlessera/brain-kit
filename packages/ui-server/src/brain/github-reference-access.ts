/** Live host authority for one bounded GitHub acquisition. No data here grants source trust. */
import type { Database } from "bun:sqlite";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { coveringReferenceGrant, REFERENCE_METADATA_CREDENTIAL_RECIPIENT, referenceRepository, type ReferenceGrant } from "../db/reference-grants.js";
import { parseGitHubOwnerMetadata, parseGitHubReferenceMetadata, sameGitHubReferenceIdentity, githubReferenceOwner, githubReferenceRepository, type GitHubReferenceIdentity, type GitHubReferenceOwner } from "./github-reference-identity.js";
import { createGitHubReferenceWire } from "./github-reference-wire.js";
import { referenceRevision, ReferenceTransportError, type ReferenceCheck, type ReferenceTransport } from "./reference-transport.js";

type WireOptions = Parameters<typeof createGitHubReferenceWire>[0];
type RequestBounds = Pick<WireOptions, "egress" | "maxBytes" | "timeoutMs" | "signal"> & { current?: () => boolean };

/** A failed final identity observation makes existing cache authority uncertain too. */
export class GitHubReferenceMetadataError extends ReferenceTransportError {
  constructor(error: unknown) {
    super(error instanceof ReferenceTransportError ? error.reason : "unavailable", error instanceof Error ? error.message : "GitHub repository identity is unavailable");
  }
}

export function createGitHubReferenceAccess(options: {
  db: Database;
  /** Actual served brain identity, never a tool argument. */
  brain: string;
  credentials: Readonly<Record<string, string | undefined>>;
  transport: ReferenceTransport;
  now?: () => number;
  /** Offline fixtures replace only DNS/TCP and their test CA. No caller-selected URL or HTTP implementation. */
  wireTransport?: Pick<WireOptions, "lookup" | "connect" | "ca">;
}) {
  const now = options.now ?? Date.now;
  const principal = (id: string, ownerOnly = false) => {
    const value = resolvePrincipal(options.db, id);
    if (!value || !isUsablePrincipal(value, now()) || (ownerOnly && value.kind !== "owner"))
      throw new ReferenceTransportError("denied", "reference principal is no longer available");
  };

  return {
    /** Settings still supplies its independent password-mode human publication authority. */
    async owner(input: RequestBounds & { principalId: string; owner: unknown }): Promise<GitHubReferenceOwner & { ownerId: string }> {
      const owner = githubReferenceOwner(input.owner);
      principal(input.principalId, true);
      const wire = await createGitHubReferenceWire({ ...input, owner: owner.owner, ...options.wireTransport,
        authorize: () => principal(input.principalId, true) });
      try {
        const result = await wire.metadata(null);
        principal(input.principalId, true);
        if (result.status !== 200) throw new ReferenceTransportError("unavailable", "GitHub owner identity is unavailable");
        return parseGitHubOwnerMetadata(owner.owner, result.value);
      } finally { await wire.close(); }
    },

    /** Open one host-only budget; anonymous metadata always precedes any permitted private retry. */
    async open(input: RequestBounds & { principalId: string; repository: unknown; revision: unknown }) {
      const location = githubReferenceRepository(input.repository), repository = referenceRepository(location.cloneUrl);
      const revision = referenceRevision(input.revision);
      principal(input.principalId);
      let grant: ReferenceGrant | null = null, credential: string | null = null;
      const authorize = (recipient: "git" | "metadata", credentialed: boolean) => {
        if (input.current && !input.current()) throw new ReferenceTransportError("denied", "the acquiring turn is no longer available");
        principal(input.principalId);
        if (grant) {
          const current = coveringReferenceGrant(options.db, { brain: options.brain, principalId: input.principalId, repository, now: now() });
          // Recreated grants and a newly selected narrower grant cannot inherit this operation.
          if (!current || current.id !== grant.id || current.credential !== grant.credential)
            throw new ReferenceTransportError("denied", "the selected reference grant changed");
          if (recipient === "metadata" && credentialed && current.metadataCredentialRecipient !== REFERENCE_METADATA_CREDENTIAL_RECIPIENT)
            throw new ReferenceTransportError("denied", "the selected grant does not permit the API credential recipient");
          if (credentialed && (!current.credential || options.credentials[current.credential] !== credential))
            throw new ReferenceTransportError("denied", "the selected host credential changed");
        } else if (credentialed) throw new ReferenceTransportError("denied", "anonymous acquisition cannot dispatch a credential");
      };
      const wire = await createGitHubReferenceWire({ ...input, repository: location.canonical, ...options.wireTransport, authorize });
      try {
        let result = await wire.metadata(null);
        principal(input.principalId);
        if (result.status === 401 || result.status === 404) {
          grant = coveringReferenceGrant(options.db, { brain: options.brain, principalId: input.principalId, repository, now: now() });
          if (!grant?.credential || grant.metadataCredentialRecipient !== REFERENCE_METADATA_CREDENTIAL_RECIPIENT)
            throw new ReferenceTransportError("denied", "private identity needs a live reference grant and explicit API credential permission");
          credential = options.credentials[grant.credential] ?? null;
          if (!credential) throw new ReferenceTransportError("unavailable", "the granted host credential is not configured");
          authorize("metadata", true);
          result = await wire.metadata(credential);
        }
        authorize("metadata", credential !== null);
        if (result.status !== 200) throw new ReferenceTransportError([401, 403, 404].includes(result.status) ? "denied" : "unavailable", "GitHub repository identity is unavailable");
        const identity: GitHubReferenceIdentity = parseGitHubReferenceMetadata(location.canonical, result.value);
        if (!grant && identity.private) throw new ReferenceTransportError("denied", "anonymous metadata cannot establish public source access");
        const assertCurrent = () => {
          wire.signal.throwIfAborted();
          authorize("git", credential !== null); authorize("metadata", credential !== null);
        };
        let resolved: Extract<ReferenceCheck, { ok: true }> | undefined;
        assertCurrent();
        return Object.freeze({
          identity: Object.freeze(identity),
          domain: grant ? "private" as const : "public" as const,
          grantId: grant?.id ?? null,
          revision,
          signal: wire.signal,
          bytes: wire.bytes,
          assertCurrent,
          async resolve() {
            assertCurrent();
            const result = await options.transport.resolve({ repository, revision, token: credential, wire, signal: wire.signal });
            assertCurrent();
            if (resolved && (!result.ok || result.ref !== resolved.ref || result.commit !== resolved.commit)) {
              await wire.close(); throw new ReferenceTransportError("invalid", "the selected Git reference changed during acquisition");
            }
            if (result.ok) resolved = { ...result };
            return result;
          },
          async fetch(root: string) {
            assertCurrent();
            if (!resolved) throw new ReferenceTransportError("invalid", "reference fetch needs its resolved branch or tag");
            const result = await options.transport.fetch({ repository, ref: resolved.ref, root, token: credential, wire, signal: wire.signal });
            assertCurrent();
            if (result.commit !== resolved.commit) {
              await wire.close(); throw new ReferenceTransportError("invalid", "the fetched commit differs from the selected reference");
            }
            return result;
          },
          /** A final fixed metadata observation must still describe this exact acquisition. */
          async revalidate() {
            try {
              assertCurrent();
              const result = await wire.metadata(credential);
              assertCurrent();
              if (result.status !== 200 || !sameGitHubReferenceIdentity(identity, parseGitHubReferenceMetadata(location.canonical, result.value)))
                throw new ReferenceTransportError("denied", "GitHub repository identity changed during acquisition");
            } catch (error) {
              const interrupted = input.signal?.aborted || (input.current && !input.current());
              await wire.close();
              if (interrupted) throw error;
              throw new GitHubReferenceMetadataError(error);
            }
          },
          close: () => wire.close(),
        });
      } catch (error) { await wire.close(); throw error; }
    },
  };
}
