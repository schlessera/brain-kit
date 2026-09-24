/**
 * brain-kit is public, and two of the five repositories are not: `brain` and
 * `brain-ui` are the maintainer's own instance, permanently private
 * (AGENTS.md, "The five repositories"). A public document that sends a reader
 * there sends them to a 404 and implies a product that does not exist. Self-hosting is served by `brain-hosting-template` instead
 * (#69, and the routing rule in docs/process/github.md).
 *
 * Prose drifts back. This does not.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Every tracked Markdown and YAML file: the docs a reader can reach, plus the
 * configuration GitHub shows them (the issue chooser, workflow names).
 */
function trackedDocs(): string[] {
  const proc = Bun.spawnSync([
    "git", "-C", ROOT, "ls-files", "*.md", "**/*.md", "*.yml", "**/*.yml", "*.yaml", "**/*.yaml",
  ]);
  // Changelogs are release history: an entry records what was true when it
  // shipped and is never rewritten.
  return [...new Set(new TextDecoder().decode(proc.stdout).split("\n").filter(Boolean))].filter(
    (f) => !f.endsWith("CHANGELOG.md"),
  );
}

/**
 * The three documents that name the private repositories on purpose: the
 * canonical statement of the five repositories (AGENTS.md), the routing
 * agreement, and the procedure that implements it. Each says in the same line
 * that they are private and permanently so. Naming them as a destination
 * for *work* is the opposite of naming them as somewhere a reader should go.
 */
const MAY_NAME_THE_PRIVATE_REPO = [
  "AGENTS.md",
  "docs/process/github.md",
  ".agents/skills/github/SKILL.md",
];

/**
 * Decision records that still cite the private instance repository, pending
 * #303, which decides where the container design they describe belongs. The
 * liveness test below fails once one of them is clean, so this list only
 * shrinks.
 */
const PENDING_303 = [
  "docs/decisions/container-privilege.md",
  "docs/decisions/agent-observability.md",
  "docs/decisions/README.md",
];

/**
 * The ways a document points at the private repositories. `brain-ui` alone
 * is not one of them: it is also the product, in the `@schlessera/brain-ui-*`
 * packages, the `.brain-ui/` directory, `brain-ui.db`, `BRAIN_UI_*` and the
 * `mcp__brain-ui__*` tool prefix, which all stay.
 */
const PRIVATE_REFERENCES: [string, RegExp][] = [
  // `schlessera/brain` or `schlessera/brain-ui` as a repository or URL, never
  // the `@schlessera/brain` package or `schlessera/brain-kit`.
  ["repository name", /(?<![@\w])schlessera\/brain(?:-ui)?(?![-\w])/],
  ["\"separate repo\"", /brain-ui(?![-\w./])`?[\s,(]*separate repo/i],
  ["the repo in words", /brain-ui(?![-\w./])`?(?:'s own\b|\s+(?:repo|repository)\b)/i],
  ["a parenthetical owner", /\(brain-ui\)/],
  // One real deployment of the product, rather than the product.
  ["the deployment", /deployed brain-ui(?![-\w./])|brain-ui (?:deploy|deployment|container)\b/i],
  // The two repositories named side by side, as peers.
  ["brain-kit and brain-ui", /brain-kit and brain-ui(?![-\w./])/i],
  ["a citation into it", /\[brain-ui\]/],
];

const referencesIn = (text: string) =>
  PRIVATE_REFERENCES.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);

describe("public documents do not send readers to the private repositories", () => {
  test("no tracked doc or YAML file points at them", () => {
    const offenders = trackedDocs()
      .filter((f) => !MAY_NAME_THE_PRIVATE_REPO.includes(f) && !PENDING_303.includes(f))
      .flatMap((f) => referencesIn(readFileSync(join(ROOT, f), "utf8")).map((what) => `${f}: ${what}`));
    expect(offenders).toEqual([]);
  });

  test("the scan reaches Markdown and YAML, including the issue chooser", () => {
    const docs = trackedDocs();
    expect(docs).toContain("README.md");
    expect(docs).toContain(".github/ISSUE_TEMPLATE/config.yml");
    expect(docs.length).toBeGreaterThan(50);
  });

  test("each pattern catches what it is for, and not the product names", () => {
    for (const text of [
      "https://github.com/schlessera/brain",
      "see schlessera/brain-ui for that",
      "a chat UI (brain-ui, separate repo)",
      "`brain-ui` (separate repo) owns",
      "See brain-ui's own SECURITY.md",
      "a separate PR in the brain-ui repo",
      "`docs/decisions.md` (brain-ui) needs two entries",
      "Modify: `[brain-ui] scripts/entrypoint.sh`",
      "brain-kit and brain-ui each keep their own copies",
      "### 1a. The deployed brain-ui container",
      "| brain-ui deploy | 0.11.0 in the repo |",
    ]) {
      expect({ text, found: referencesIn(text).length > 0 }).toEqual({ text, found: true });
    }
    for (const text of [
      "@schlessera/brain",
      "@schlessera/brain-ui-react",
      "schlessera/brain-kit#12",
      "schlessera/brain-template",
      "the brain-ui-server package",
      "staged under .brain-ui/inbox",
      "writes brain-ui.db",
      "mcp__brain-ui__ask_user",
      "BRAIN_UI_LIVE_TESTS=1",
      "(brain-ui's spelling; checked after PUPPETEER_EXECUTABLE_PATH)",
    ]) {
      expect({ text, found: referencesIn(text).length > 0 }).toEqual({ text, found: false });
    }
  });

  test("the documents that may name them still do, so the allowlist is not dead", () => {
    for (const f of MAY_NAME_THE_PRIVATE_REPO) {
      expect({ f, named: referencesIn(readFileSync(join(ROOT, f), "utf8")).length > 0 }).toEqual({ f, named: true });
    }
  });

  test("each record pending #303 still has a reference, so the list only shrinks", () => {
    for (const f of PENDING_303) {
      expect({ f, pending: referencesIn(readFileSync(join(ROOT, f), "utf8")).length > 0 }).toEqual({ f, pending: true });
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
