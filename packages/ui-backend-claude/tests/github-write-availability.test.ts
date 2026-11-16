/**
 * The Claude permission boundary for the host GitHub write tools (#3798):
 * the roster is fixed, so a voice or no-grant turn still lists them, and
 * this boundary refuses them there before the host is reached; a typed turn
 * with a host handler admits them, and the host asks on its own card.
 */
import { expect, test } from "bun:test";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { toolAvailabilityRefusal } from "../src/tool-availability.js";

const github = async () => ({ ok: false as const, tool: "brain_github_issue_create" as const, error: { code: "unavailable" as const, reason: "no_credential", message: "none" } });
const request = (extra: Partial<StartTurnRequest>, handler = true) =>
  ({ prompt: "File the suitors issue", bridge: { emit() {}, requestPermission: async () => ({ behavior: "allow" }), ...(handler ? { github } : {}) }, ...extra }) as unknown as StartTurnRequest;

test("a write tool is admitted only in a typed turn with a grant surface and a host handler", () => {
  for (const name of ["brain_github_issue_create", "brain_github_issue_comment"]) for (const visible of [name, `mcp__brain-ui__${name}`]) {
    expect(toolAvailabilityRefusal(request({}), visible), `CLAUDE_GITHUB_WRITE_TYPED ${visible}`).toBeUndefined();
    expect(toolAvailabilityRefusal(request({ posture: "voice" }), visible), `CLAUDE_GITHUB_WRITE_VOICE ${visible}`).toContain("interactive typed grant surface");
    expect(toolAvailabilityRefusal(request({ noGrantSurface: true }), visible), `CLAUDE_GITHUB_WRITE_NO_GRANT ${visible}`).toContain("interactive typed grant surface");
    expect(toolAvailabilityRefusal(request({}, false), visible), `CLAUDE_GITHUB_WRITE_NO_HANDLER ${visible}`).toContain("no available host handler");
  }
  // Reads keep their membership in voice and no-grant turns.
  expect(toolAvailabilityRefusal(request({ posture: "voice" }), "mcp__brain-ui__brain_github_issue_read")).toBeUndefined();
});
