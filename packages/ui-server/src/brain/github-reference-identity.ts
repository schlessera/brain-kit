/** Fixed GitHub metadata validation. Parsing alone establishes no transport, access or source trust. */
import { parseTrustGithub, TrustSelectorSchema } from "@schlessera/brain-common/internal/governance-policy";

interface GitHubReferenceRepository {
  owner: string;
  repository: string;
  canonical: string;
  cloneUrl: string;
  metadataUrl: string;
}

interface GitHubReferenceIdentity extends GitHubReferenceRepository {
  repositoryId: string;
  ownerId: string;
  private: boolean;
}

/** Reject ambiguous syntax before a URL parser can erase traversal or separators. */
export function githubReferenceRepository(input: unknown): GitHubReferenceRepository {
  if (typeof input !== "string") throw new Error("Use one canonical GitHub owner/repository");
  const location = parseTrustGithub(input.replace(/^https:\/\/github\.com\//iu, "https://github.com/"));
  if (!location.repository) throw new Error("A repository is required for reference acquisition");
  const { owner, repository } = location;
  const canonical = `https://github.com/${owner}/${repository}`;
  return { owner, repository, canonical, cloneUrl: `${canonical}.git`, metadataUrl: `https://api.github.com/repos/${owner}/${repository}` };
}

function providerId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("GitHub metadata has an unsupported stable identity");
    value = String(value);
  }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) throw new Error("GitHub metadata has an unsupported stable identity");
  return value;
}

/** Validate only the fields the fixed host request consumes; no worker claims become verification flags. */
export function parseGitHubReferenceMetadata(repository: unknown, input: unknown): GitHubReferenceIdentity {
  const requested = githubReferenceRepository(repository);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("GitHub identity metadata is unavailable");
  const value = input as Record<string, unknown>;
  const owner = value.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw new Error("GitHub owner identity metadata is unavailable");
  const details = owner as Record<string, unknown>;
  if (typeof details.login !== "string" || typeof value.name !== "string") throw new Error("GitHub metadata has invalid repository names");
  const selector = TrustSelectorSchema.parse({ kind: "github_repository", host: "github.com", owner: details.login.toLowerCase(),
    repository: value.name.toLowerCase(), repositoryId: providerId(value.id) });
  if (selector.kind !== "github_repository") throw new Error("GitHub repository identity is unavailable");
  if (selector.owner !== requested.owner || selector.repository !== requested.repository)
    throw new Error("GitHub metadata does not match the requested repository");
  if (typeof value.full_name !== "string" || value.full_name.toLowerCase() !== `${requested.owner}/${requested.repository}`
    || typeof value.clone_url !== "string" || value.clone_url.toLowerCase() !== requested.cloneUrl
    || typeof value.url !== "string" || value.url.toLowerCase() !== requested.metadataUrl
    || typeof value.private !== "boolean") throw new Error("GitHub metadata does not bind the fixed repository transport");
  return { ...requested, repositoryId: selector.repositoryId, ownerId: providerId(details.id), private: value.private };
}

/** Both observations must describe one unchanged acquisition; this does not authorize either observation. */
export function sameGitHubReferenceIdentity(before: GitHubReferenceIdentity, after: GitHubReferenceIdentity): boolean {
  return before.repositoryId === after.repositoryId && before.ownerId === after.ownerId
    && before.canonical === after.canonical && before.private === after.private;
}
