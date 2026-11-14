import { expect, test } from "bun:test";
import { githubReferenceRepository, parseGitHubReferenceMetadata, sameGitHubReferenceIdentity } from "../src/brain/github-reference-identity";

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 101, owner: { id: 201, login: "Odysseus" }, name: "Ithaca", full_name: "Odysseus/Ithaca",
    clone_url: "https://github.com/Odysseus/Ithaca.git", url: "https://api.github.com/repos/Odysseus/Ithaca", private: false, ...overrides };
}

test("one canonical repository fixes both Git and metadata recipients", () => {
  const expected = { owner: "odysseus", repository: "ithaca", canonical: "https://github.com/odysseus/ithaca",
    cloneUrl: "https://github.com/odysseus/ithaca.git", metadataUrl: "https://api.github.com/repos/odysseus/ithaca" };
  for (const input of ["Odysseus/Ithaca", "https://github.com/Odysseus/Ithaca.git", "HTTPS://GITHUB.COM/Odysseus/Ithaca"])
    expect(githubReferenceRepository(input), "GITHUB_REFERENCE_FIXED_RECIPIENTS").toEqual(expected);
  expect(githubReferenceRepository("odysseus/charts.git.git").repository, "one optional transport suffix is removed").toBe("charts.git");
});

test("userinfo, helpers, traversal, other recipients and extra path segments are refused before URL normalization", () => {
  for (const input of [undefined, null, 7, "odysseus", "odysseus/.", "odysseus/..", "odysseus//ithaca", "odysseus/ithaca/extra",
    "odysseus/ithaca/", "odysseus/../ithaca", "-odysseus/ithaca", "ody--sseus/ithaca", "odysseus/ithaca?x=1",
    "https://github.com/odysseus/../ithaca", "https://github.com/odysseus%2fcrew/ithaca", "https://github.com/odysseus/ithaca%2fextra",
    "https://github.com@calypso.example/odysseus/ithaca", "https://token@github.com/odysseus/ithaca", "https://github.com:443/odysseus/ithaca",
    "https://github.com./odysseus/ithaca", "https://github.com.evil.example/odysseus/ithaca", "http://github.com/odysseus/ithaca",
    "git@github.com:odysseus/ithaca", "ext::git anything", "file:///odysseus/ithaca", " odysseus/ithaca", "odysseus/ithaca "])
    expect(() => githubReferenceRepository(input), "GITHUB_REFERENCE_AMBIGUOUS_LOCATION_REFUSED").toThrow();
});

test("metadata binds independent stable repository and owner identities to the requested transport", () => {
  const identity = parseGitHubReferenceMetadata("odysseus/ithaca", metadata());
  expect(identity).toEqual({ ...githubReferenceRepository("odysseus/ithaca"), repositoryId: "101", ownerId: "201", private: false });
  expect(Object.keys(identity)).not.toContain("verifiedBy");
  expect(() => parseGitHubReferenceMetadata("penelope/ithaca", metadata()), "GITHUB_REFERENCE_FOREIGN_OWNER_REFUSED").toThrow();
  expect(() => parseGitHubReferenceMetadata("odysseus/loom", metadata()), "GITHUB_REFERENCE_FOREIGN_REPOSITORY_REFUSED").toThrow();
});

test("the API document cannot substitute a remote, generic endpoint or differently named source", () => {
  for (const changes of [{ full_name: "penelope/ithaca" }, { clone_url: "https://github.com/penelope/ithaca.git" },
    { clone_url: "https://github.com/odysseus/ithaca.git?service=git-receive-pack" }, { clone_url: "ssh://git@github.com/odysseus/ithaca" },
    { url: "https://api.github.com/repos/penelope/ithaca" }, { url: "https://api.github.com/repositories/101" }, { private: "false" },
    { owner: { id: 201, login: "odysseus/crew" } }, { name: "../ithaca" }, { full_name: undefined }, { clone_url: undefined }, { url: undefined }])
    expect(() => parseGitHubReferenceMetadata("odysseus/ithaca", metadata(changes)), "GITHUB_REFERENCE_METADATA_TRANSPORT_BOUND").toThrow();
});

test("stable IDs never round or acquire a value from an absent or malformed field", () => {
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", "01", "1e2", "-1", "1.0", "1".repeat(21), null, undefined]) {
    expect(() => parseGitHubReferenceMetadata("odysseus/ithaca", metadata({ id })), "GITHUB_REFERENCE_REPOSITORY_ID_EXACT").toThrow();
    expect(() => parseGitHubReferenceMetadata("odysseus/ithaca", metadata({ owner: { id, login: "Odysseus" } })), "GITHUB_REFERENCE_OWNER_ID_EXACT").toThrow();
  }
  expect(parseGitHubReferenceMetadata("odysseus/ithaca", metadata({ id: "12345678901234567890" })).repositoryId).toBe("12345678901234567890");
});

test("transfer, namespace reassignment, name reuse and privacy changes cannot be one unchanged acquisition", () => {
  const original = parseGitHubReferenceMetadata("odysseus/ithaca", metadata());
  expect(sameGitHubReferenceIdentity(original, parseGitHubReferenceMetadata("odysseus/ithaca", metadata()))).toBe(true);
  for (const changed of [metadata({ id: 102 }), metadata({ owner: { id: 202, login: "Odysseus" } }), metadata({ private: true })])
    expect(sameGitHubReferenceIdentity(original, parseGitHubReferenceMetadata("odysseus/ithaca", changed)), "GITHUB_REFERENCE_CHANGED_IDENTITY_REFUSED").toBe(false);
  const renamed = parseGitHubReferenceMetadata("odysseus/argo", metadata({ name: "argo", full_name: "Odysseus/Argo",
    clone_url: "https://github.com/Odysseus/Argo.git", url: "https://api.github.com/repos/Odysseus/Argo" }));
  expect(sameGitHubReferenceIdentity(original, renamed), "a rename needs fresh validation, not an in-flight substitution").toBe(false);
});
