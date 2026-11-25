/** The fixed system brief sends Gmail through the host tools (#4207, plan §9). */
import { expect, test } from "bun:test";
import { buildSystemPromptAppend } from "../src/server/index.js";

const PI = { search: "brain_google_gmail_search", read: "brain_google_gmail_read", modify: "brain_google_gmail_modify",
  trash: "brain_google_gmail_trash", draft: "brain_google_gmail_draft", send: "brain_google_gmail_send" };
const CLAUDE = Object.fromEntries(Object.entries(PI).map(([key, name]) => [key, `mcp__brain-ui__${name}`])) as typeof PI;
// Typed loosely, so the option a brief does not know yet is an assertion, not a type error.
const brief = (googleTools?: typeof PI) => buildSystemPromptAppend({ ...(googleTools ? { googleTools } : {}) } as Parameters<typeof buildSystemPromptAppend>[0]);

test("the brief names the host Gmail tools under the backend's visible names, the structured view and the refusals", () => {
  for (const [label, tools] of [["claude", CLAUDE], ["pi", PI]] as const) {
    const text = brief(tools);
    expect(text, `GOOGLE_BRIEF_HEADING ${label}`).toContain("**Gmail goes through the host tools.**");
    for (const name of Object.values(tools)) expect(text, `GOOGLE_BRIEF_NAMES_TOOLS ${label}`).toContain(`\`${name}\``);
    expect(text, "GOOGLE_BRIEF_NO_CREDENTIAL").toContain("so `gog`, `curl` and WebFetch cannot act as the user on Google.");
    expect(text, "GOOGLE_BRIEF_STRUCTURED_UNTAINTED").toContain("view structured when ids, labels and dates are enough to act on, which keeps\n  this session untainted");
    expect(text, "GOOGLE_BRIEF_REFUSALS").toContain("If these tools answer unavailable or policy_denied, tell the\n  user what they said and stop.");
    // Fixed text: the same inputs give the same bytes, whatever the policy says.
    expect(brief(tools), `GOOGLE_BRIEF_FIXED ${label}`).toBe(text);
  }
  expect(brief(), "GOOGLE_BRIEF_ONLY_WITH_TOOLS").not.toContain("Gmail goes through the host tools.");
});
