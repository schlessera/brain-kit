/**
 * brain-kit is public, and two of the five repositories are not: `brain` and
 * `brain-ui` are the maintainer's own instance, permanently private. A public document
 * that sends a reader there sends them to a 404 and implies a product that
 * does not exist. Self-hosting is served by `brain-hosting-template` instead
 * (#69, and the routing rule in docs/process/github.md).
 *
 * Prose drifts back. This does not.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

/** Every tracked markdown file, which is the set a reader can reach. */
function trackedMarkdown(): string[] {
  const proc = Bun.spawnSync(["git", "-C", ROOT, "ls-files", "*.md", "**/*.md"]);
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .filter(Boolean);
}

/**
 * The three documents that name the private repository on purpose: the
 * canonical statement of the five repositories (AGENTS.md), the routing
 * agreement, and the procedure that implements it. Each says in the same line
 * that it is private and permanently so. Naming it as a destination
 * for *work* is the opposite of naming it as somewhere a reader should go.
 */
const MAY_NAME_THE_PRIVATE_REPO = [
  "AGENTS.md",
  "docs/process/github.md",
  ".agents/skills/github/SKILL.md",
];

/** `schlessera/brain-ui` as a repository, never `@schlessera/brain-ui-sdk`. */
const REPO_REFERENCE = /schlessera\/brain-ui($|[^-\w])/;

describe("public documents do not send readers to the private deployment", () => {
  test("no markdown names schlessera/brain-ui as a place to go", () => {
    const offenders = trackedMarkdown()
      .filter((f) => !MAY_NAME_THE_PRIVATE_REPO.includes(f))
      .filter((f) => REPO_REFERENCE.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the documents that may name it still do, so the allowlist is not dead", () => {
    for (const f of MAY_NAME_THE_PRIVATE_REPO) {
      expect(REPO_REFERENCE.test(readFileSync(join(ROOT, f), "utf8"))).toBe(true);
    }
  });

  test("package names were not caught by the same broom", () => {
    // The obvious way to satisfy the test above is a global search-and-replace
    // over `brain-ui`, which would rename four published packages in the docs
    // that teach people to import them.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const pkg of [
      "@schlessera/brain-ui-sdk",
      "@schlessera/brain-ui-server",
      "@schlessera/brain-ui-kit",
      "@schlessera/brain-ui-react",
    ]) {
      expect(readme).toContain(pkg);
    }
  });

  test("the hosting page points at the hosting template and says it is not ready", () => {
    const hosting = readFileSync(join(ROOT, "docs/hosting/README.md"), "utf8");
    expect(hosting).toContain("brain-hosting-template");
    expect(hosting).toContain("not published yet");
  });
});

/**
 * The hosting page states a minimum brain CLI version, and the server enforces
 * one. They were written at the same time and have no reason to stay equal —
 * the doc called it "Upgrading to 0.33.0" three releases after 0.33.0, which is
 * how a standing requirement reads as old news and gets skipped.
 */
describe("the documented CLI floor is the one the server enforces", () => {
  test("docs/hosting/README.md states MIN_BRAIN_CLI_VERSION", () => {
    const source = readFileSync(
      join(ROOT, "packages/ui-server/src/brain/client.ts"),
      "utf8"
    );
    const enforced = /MIN_BRAIN_CLI_VERSION = "([^"]+)"/.exec(source)?.[1];
    expect(enforced).toBeTruthy();

    for (const doc of ["docs/hosting/README.md", "packages/core/skills/brain-host/SKILL.md"]) {
      const text = readFileSync(join(ROOT, doc), "utf8");
      expect(text).toContain(`older than ${enforced}`);
    }
  });
});
