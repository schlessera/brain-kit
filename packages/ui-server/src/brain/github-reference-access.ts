/** Live host authority for one bounded GitHub acquisition. No data here grants source trust. */
import type { Database } from "bun:sqlite";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { coveringReferenceGrant, REFERENCE_METADATA_CREDENTIAL_RECIPIENT, referenceRepository, type ReferenceGrant } from "../db/reference-grants.js";
import { parseGitHubOwnerMetadata, parseGitHubReferenceMetadata, sameGitHubReferenceIdentity, githubReferenceOwner, githubReferenceRepository, type GitHubReferenceIdentity, type GitHubReferenceOwner } from "./github-reference-identity.js";
import { createGitHubReferenceWire } from "./github-reference-wire.js";
import { referenceRevision, ReferenceTransportError, type ReferenceCheck, type ReferenceTransport } from "./reference-transport.js";

type WireOptions = Parameters<typeof createGitHubReferenceWire>[0];
type RequestBounds = Pick<WireOptions, "egress" | "maxBytes" | "timeoutMs" | "signal"> & { current?: () => boolean };

/** A failed identity observation makes existing cache authority uncertain too. */
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

  /** Shared metadata authority, without selecting a Git revision or starting a turn. */
  async function repositoryMetadata(input: RequestBounds & { principalId: string; repository: unknown;
    withdrawPublic?: () => Promise<void> }, ownerOnly: boolean) {
    // Retain the operation's identity across waits; caller-owned objects cannot
    // switch the principal, target, cancellation or authority callback mid-read.
    const { principalId, repository: repositoryInput, current: currentOperation, signal, withdrawPublic, ...bounds } = input;
    const assertOperation = () => {
      signal?.throwIfAborted();
      if (currentOperation && !currentOperation()) throw new ReferenceTransportError("denied", "the reference operation is no longer available");
      principal(principalId, ownerOnly);
    };
    const location = githubReferenceRepository(repositoryInput), repository = referenceRepository(location.cloneUrl);
    assertOperation();
    let grant: ReferenceGrant | null = null, credential: string | null = null;
    const authorize = (recipient: "git" | "metadata", credentialed: boolean) => {
      assertOperation();
      if (grant) {
        const current = coveringReferenceGrant(options.db, { brain: options.brain, principalId, repository, now: now() });
        // Recreated grants and a newly selected narrower grant cannot inherit this operation.
        if (!current || current.id !== grant.id || current.credential !== grant.credential)
          throw new ReferenceTransportError("denied", "the selected reference grant changed");
        if (recipient === "metadata" && credentialed && current.metadataCredentialRecipient !== REFERENCE_METADATA_CREDENTIAL_RECIPIENT)
          throw new ReferenceTransportError("denied", "the selected grant does not permit the API credential recipient");
        if (credentialed && (!current.credential || options.credentials[current.credential] !== credential))
          throw new ReferenceTransportError("denied", "the selected host credential changed");
      } else if (credentialed) throw new ReferenceTransportError("denied", "anonymous acquisition cannot dispatch a credential");
    };
    const wire = await createGitHubReferenceWire({ ...bounds, signal, repository: location.cloneUrl, ...options.wireTransport, authorize });
    let openingMetadata = true;
    try {
      let result = await wire.metadata(null);
      if (result.status === 401 || result.status === 404) {
        await withdrawPublic?.();
        // That observation is already contained. A missing private grant
        // is not a second metadata observation after the withdrawal waits.
        openingMetadata = false;
        assertOperation();
        grant = coveringReferenceGrant(options.db, { brain: options.brain, principalId, repository, now: now() });
        if (!grant?.credential || grant.metadataCredentialRecipient !== REFERENCE_METADATA_CREDENTIAL_RECIPIENT)
          throw new ReferenceTransportError("denied", "private identity needs a live reference grant and explicit API credential permission");
        credential = options.credentials[grant.credential] ?? null;
        if (!credential) throw new ReferenceTransportError("unavailable", "the granted host credential is not configured");
        authorize("metadata", true);
        openingMetadata = true;
        result = await wire.metadata(credential);
      }
      authorize("metadata", credential !== null);
      if (result.status !== 200) throw new ReferenceTransportError([401, 403, 404].includes(result.status) ? "denied" : "unavailable", "GitHub repository identity is unavailable");
      const identity: GitHubReferenceIdentity = parseGitHubReferenceMetadata(location.cloneUrl, result.value);
      if (!grant && identity.private) throw new ReferenceTransportError("denied", "anonymous metadata cannot establish public source access");
      let identityObservedAt = now();
      openingMetadata = false;
      // Source/worktree effects outlive wire shutdown, but not this authority.
      const assertAuthority = () => {
        authorize("git", credential !== null); authorize("metadata", credential !== null);
      };
      const assertCurrent = () => { wire.signal.throwIfAborted(); assertAuthority(); };
      assertCurrent();
      return Object.freeze({ identity: Object.freeze(identity), get identityObservedAt() { return identityObservedAt; }, repository, credential, wire,
        domain: grant ? "private" as const : "public" as const, grantId: grant?.id ?? null, assertCurrent, assertAuthority,
        /** A final fixed metadata observation must still describe this exact acquisition. */
        async revalidate() {
          try {
            assertCurrent();
            const result = await wire.metadata(credential);
            assertCurrent();
            if (result.status !== 200 || !sameGitHubReferenceIdentity(identity, parseGitHubReferenceMetadata(location.cloneUrl, result.value)))
              throw new ReferenceTransportError("denied", "GitHub repository identity changed during acquisition");
            identityObservedAt = now();
          } catch (error) {
            const interrupted = signal?.aborted || (currentOperation && !currentOperation());
            await wire.close();
            if (interrupted) throw error;
            throw new GitHubReferenceMetadataError(error);
          }
        },
        close: () => wire.close(),
      });
    } catch (error) {
      // Retain an observed metadata failure before shutdown can outlive its turn.
      const failure = openingMetadata && !signal?.aborted && (!currentOperation || currentOperation())
        ? new GitHubReferenceMetadataError(error) : error;
      await wire.close(); throw failure;
    }
  }

  return {
    /** Settings supplies independent password-mode human publication authority. */
    async owner(input: RequestBounds & { principalId: string; owner: unknown }): Promise<GitHubReferenceOwner & { ownerId: string }> {
      const { principalId, owner: ownerInput, current, signal, ...bounds } = input;
      const owner = githubReferenceOwner(ownerInput);
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (current && !current()) throw new ReferenceTransportError("denied", "the Settings operation is no longer available");
        principal(principalId, true);
      };
      assertCurrent();
      const wire = await createGitHubReferenceWire({ ...bounds, signal, owner: owner.owner, ...options.wireTransport, authorize: assertCurrent });
      let identity: GitHubReferenceOwner & { ownerId: string };
      try {
        const result = await wire.metadata(null);
        assertCurrent();
        if (result.status !== 200) throw new ReferenceTransportError("unavailable", "GitHub owner identity is unavailable");
        identity = parseGitHubOwnerMetadata(owner.owner, result.value);
      } finally { await wire.close(); }
      assertCurrent();
      return Object.freeze(identity);
    },

    /** Fixed metadata only. No revision, Git channel, token or approval proof escapes. */
    async repository(input: RequestBounds & { principalId: string; repository: unknown }): Promise<GitHubReferenceIdentity & { assertAuthority(): void }> {
      const access = await repositoryMetadata(input, true);
      try { access.assertCurrent(); }
      finally { await access.close(); }
      // Wire shutdown is an asynchronous wait too. Its intentional abort does
      // not invalidate the caller's independent live Settings authority.
      access.assertAuthority();
      // A later synchronous publication fence must retain this operation's
      // selected grant and credential, rather than select a replacement grant.
      // This checks authority only; a new review/commit still needs fresh metadata.
      return Object.freeze({ ...access.identity, assertAuthority: access.assertAuthority });
    },

    /** Open one host-only budget; anonymous metadata always precedes any permitted private retry. */
    async open(input: RequestBounds & { principalId: string; repository: unknown; revision: unknown;
      /** The source host must hide prior public exposure before a credentialed retry can await. */
      withdrawPublic?: () => Promise<void> }) {
      const revision = referenceRevision(input.revision);
      const access = await repositoryMetadata(input, false);
      const { identity, domain, grantId, wire, credential, repository, assertCurrent, assertAuthority, revalidate, close } = access;
      let resolved: Extract<ReferenceCheck, { ok: true }> | undefined;
      return Object.freeze({ identity, get identityObservedAt() { return access.identityObservedAt; }, domain, grantId, revision, signal: wire.signal, bytes: wire.bytes, assertCurrent, assertAuthority, revalidate, close,
        async resolve() {
          assertCurrent();
          const result = await options.transport.resolve({ repository, revision, token: credential, wire, signal: wire.signal });
          assertCurrent();
          if (resolved && (!result.ok || result.ref !== resolved.ref || result.commit !== resolved.commit)) {
            await close(); throw new ReferenceTransportError("invalid", "the selected Git reference changed during acquisition");
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
            await close(); throw new ReferenceTransportError("invalid", "the fetched commit differs from the selected reference");
          }
          return result;
        },
      });
    },
  };
}
