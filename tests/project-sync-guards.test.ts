// The two guards `scripts/sync-project.ts` runs before it touches the board:
// which repositories it covers, and whether its token can do the job.

import { describe, expect, test } from "bun:test";
import { REPOS, REQUIRED_SCOPES, scopesFromHeaders } from "../scripts/sync-project.ts";

describe("REPOS", () => {
  test("covers the three public repositories and nothing else (AGENTS.md, the five repositories)", () => {
    expect([...REPOS].sort()).toEqual([
      "schlessera/brain-hosting-template",
      "schlessera/brain-kit",
      "schlessera/brain-template",
    ]);
  });
});

describe("scopesFromHeaders", () => {
  // The shape `gh api --include user` prints, trimmed. The expose-headers line
  // names `X-OAuth-Scopes` too, and must not be read as the scope list.
  const response = (scopes: string) =>
    [
      "HTTP/2.0 200 OK",
      "Access-Control-Expose-Headers: ETag, Link, X-OAuth-Scopes, X-Accepted-OAuth-Scopes",
      "X-Accepted-Oauth-Scopes: ",
      `X-Oauth-Scopes: ${scopes}`,
      "",
      // A body line shaped like the header, which only the header/body split
      // keeps out of the scope list.
      "X-Oauth-Scopes: project, read:org",
    ].join("\r\n");

  test("reads the exact scopes of the token that answered", () => {
    expect(scopesFromHeaders(response("project, read:org, repo"))).toEqual(
      new Set(["project", "read:org", "repo"]),
    );
  });

  test("`read:project` is not `project`", () => {
    const scopes = scopesFromHeaders(response("read:project, read:org, repo"));
    expect(scopes.size).toBe(3);
    expect(REQUIRED_SCOPES.filter((s) => !scopes.has(s))).toEqual(["project"]);
  });

  test("a token without read:org is missing it", () => {
    const scopes = scopesFromHeaders(response("project, repo"));
    expect(scopes.size).toBe(2);
    expect(REQUIRED_SCOPES.filter((s) => !scopes.has(s))).toEqual(["read:org"]);
  });

  test("no header, as for a fine-grained token, is no scopes, and a body line never counts", () => {
    const noHeader = response("x").replace(/X-Oauth-Scopes: x\r\n/, "");
    expect(noHeader).toContain("\r\n\r\nX-Oauth-Scopes: project, read:org");
    expect(scopesFromHeaders(noHeader)).toEqual(new Set());
  });
});
