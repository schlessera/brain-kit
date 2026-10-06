import { describe, expect, test } from "bun:test";
import { handoffWhy } from "../src/hooks/use-handoff-entry.js";

// Why the handoff entry cannot run (#61 §1), and how it names a backend that
// is set up but cannot run (#1090).
const claude = { id: "claude", label: "Claude Opus", backendId: "claude" };
const codex = { id: "codex", label: "Codex", backendId: "pi" };
const proxy = { id: "ithaca-proxy", label: "Ithaca proxy", reason: "needs-credentials", backendId: "pi" };
const relay = { id: "circe-relay", label: "Circe relay", reason: "needs-credentials", backendId: "codex" };
const NAMES: Record<string, string> = { pi: "Ithaca proxy", codex: "Circe relay", claude: "Claude Opus" };
const name = (backendId: string) => NAMES[backendId] ?? backendId;

describe("handoffWhy", () => {
  test("one other backend whose profiles all need credentials is named, with the singular verb", () => {
    expect(handoffWhy([claude], "claude", true, [proxy], name)).toBe("Ithaca proxy needs credentials");
  });

  test("two such backends are both named, joined with a comma, with the plural verb", () => {
    expect(handoffWhy([claude], "claude", true, [proxy, relay], name)).toBe("Ithaca proxy, Circe relay need credentials");
  });

  test("a backend is named once however many of its profiles cannot run", () => {
    const second = { ...proxy, id: "ithaca-proxy-2", label: "Ithaca proxy 2" };
    expect(handoffWhy([claude], "claude", true, [proxy, second], name)).toBe("Ithaca proxy needs credentials");
  });

  test("any other reason among them reads can't run now, as the sheet's split does", () => {
    const other = { ...relay, reason: "rate-limited" };
    expect(handoffWhy([claude], "claude", true, [proxy, other], name)).toBe("Ithaca proxy, Circe relay can't run now");
    expect(handoffWhy([claude], "claude", true, [other], name)).toBe("Circe relay can't run now");
  });

  test("the cannot-run reason comes before needs the host", () => {
    expect(handoffWhy([claude], "claude", false, [proxy], name)).toBe("Ithaca proxy needs credentials");
  });

  test("a profile on the session's own backend is not another backend, unavailable or not", () => {
    const own = { ...proxy, backendId: "claude" };
    expect(handoffWhy([claude], "claude", true, [own], name)).toBe("no other backend set up");
  });

  test("with no profile on any other backend, there is no other backend set up", () => {
    expect(handoffWhy([claude], "claude", true, [], name)).toBe("no other backend set up");
    expect(handoffWhy([claude], "claude", false, [], name)).toBe("no other backend set up");
  });

  test("any runnable profile on another backend enables the entry, whatever else cannot run", () => {
    expect(handoffWhy([claude, codex], "claude", true, [proxy, relay], name)).toBeUndefined();
    expect(handoffWhy([claude, codex], "claude", false, [proxy, relay], name)).toBe("needs the host");
  });
});
