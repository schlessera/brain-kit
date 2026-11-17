/** The fixed system brief sends GitHub through the host tools (#3791, #3799). */
import { expect, test } from "bun:test";
import { buildSystemPromptAppend, GITHUB_TOOL_NAMES } from "../src/server/index.js";
import type { GithubToolsBrief } from "../src/server/system-prompt.js";

const PI: GithubToolsBrief = { read: GITHUB_TOOL_NAMES.read, search: GITHUB_TOOL_NAMES.search, create: GITHUB_TOOL_NAMES.create, comment: GITHUB_TOOL_NAMES.comment };
const CLAUDE = Object.fromEntries(Object.entries(PI).map(([key, name]) => [key, `mcp__brain-ui__${name}`])) as unknown as GithubToolsBrief;

test("the brief names the host GitHub tools under the backend's visible names and says not to fall back", () => {
  for (const [label, tools] of [["claude", CLAUDE], ["pi", PI]] as const) {
    const brief = buildSystemPromptAppend({ githubTools: tools });
    for (const name of Object.values(tools)) expect(brief, `GITHUB_BRIEF_NAMES_TOOLS ${label}`).toContain(`\`${name}\``);
    expect(brief, "GITHUB_BRIEF_NO_FALLBACK").toContain("Do not fall back to\n  gh, curl or WebFetch for GitHub.");
    expect(brief, "GITHUB_BRIEF_UNAVAILABLE").toContain("If these tools answer unavailable or\n  policy_denied, tell the user what they said and stop.");
    // Fixed text: the same inputs give the same bytes, whatever the device.
    expect(buildSystemPromptAppend({ githubTools: tools })).toBe(brief);
  }
  expect(buildSystemPromptAppend({}), "GITHUB_BRIEF_ONLY_WITH_TOOLS").not.toContain("GitHub goes through the host tools.");
});
