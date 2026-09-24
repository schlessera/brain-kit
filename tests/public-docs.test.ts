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
  return [...new Set(new TextDecoder().decode(proc.stdout).split("\n").filter(Boolean))];
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
 * Files that still carry references, and exactly how many lines of them. A
 * count, not a file exemption: a new reference in one of these files fails
 * the scan like anywhere else, and a removed one fails it until the count is
 * lowered, so these only shrink.
 *
 * - Three decision records cite the private repository's files, pending #303,
 *   which decides where the container design they describe belongs.
 * - `packages/core/README.md` is generated from an env descriptor in
 *   `packages/core/src/config/env.ts`, which is source, pending #305.
 * - Changelogs are release history: an entry records what was true when it
 *   shipped. The count keeps a NEW entry, copied in from a changeset at
 *   version time, from carrying a reference past this test.
 */
const RECORDED: Record<string, number> = {
  "docs/decisions/container-privilege.md": 18,
  "docs/decisions/agent-observability.md": 2,
  "docs/decisions/README.md": 1,
  "packages/core/README.md": 1,
  "packages/core/CHANGELOG.md": 1,
  "packages/ui-react/CHANGELOG.md": 1,
  "packages/ui-sdk/CHANGELOG.md": 1,
  "packages/ui-server/CHANGELOG.md": 1,
};

/** Name-like `brain-ui`: not followed by a character that makes it a package, path or file. */
const NAME = String.raw`brain-ui(?![-\w./])`;

/**
 * The ways a document points at the private repositories or describes their
 * deployment. `brain-ui` alone is not one of them: it is also the product, in
 * the `@schlessera/brain-ui-*` packages, the `.brain-ui/` directory,
 * `brain-ui.db`, `BRAIN_UI_*` and the `mcp__brain-ui__*` tool prefix, which
 * all stay.
 */
const PRIVATE_REFERENCES: [string, RegExp][] = [
  // `schlessera/brain` or `schlessera/brain-ui` as a repository or URL, in any
  // case, never the `@schlessera/brain` package or `schlessera/brain-kit`.
  ["repository name", /(?<![@\w])schlessera\/brain(?:-ui)?(?![-\w])/i],
  ['"separate repo"', new RegExp(`${NAME}[^.\\n]{0,24}\\bseparate repo(?:sitory)?\\b`, "i")],
  ["the repo in words", new RegExp(`${NAME}\`?(?:'s own\\b|\\s+(?:repo|repository|repositories|decisions?)\\b)`, "i")],
  ["a file in it", new RegExp(`${NAME}(?:'s)?\\s+\`[\\w./-]+\\.(?:sh|md|ts|ya?ml|conf|json)\`|${NAME}'s\\s+[\\w./-]+\\.(?:sh|md|ts|ya?ml|conf|json)\\b`, "i")],
  // A parenthesis that names who owns something: "(brain-ui)",
  // "(ui-server + brain-ui)", "(brain-ui `docs/decisions.md` #3)". Not the
  // product in passing: "(with brain-ui)", "(primarily **brain-ui**)".
  ["a parenthetical owner", /\((?:brain-ui|[^()]*\+\s*brain-ui)(?:\s+`[^`]*`[^()]*)?\)/i],
  ["a release of it", new RegExp(`${NAME}\\*{0,2}\\s+(?:gets\\s+)?(?:release|bump|client|tags?)\\b|${NAME}[^.\\n]{0,60}\\bredeploy\\b`, "i")],
  ["a repo action", new RegExp(`\\b(?:grep|clone|check out|in) ${NAME}`, "i")],
  // One real deployment of the product, rather than the product.
  ["the deployment", new RegExp(`deployed ${NAME}|${NAME}\`? (?:deploy|deployment|container|docker image|image|shell)\\b`, "i")],
  // The two repositories named side by side, as peers.
  ["brain-kit and brain-ui", new RegExp(`brain-kit and (?:the )?(?:private )?${NAME}`, "i")],
  // A citation into it, never a Markdown link whose text is the product name.
  ["a citation into it", /\[brain-ui\](?!\()/i],
];

const referencesIn = (text: string) =>
  PRIVATE_REFERENCES.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);

/** The lines of a text that point at the private repositories. */
const referencingLines = (text: string) => text.split("\n").filter((line) => referencesIn(line).length > 0);

describe("public documents do not send readers to the private repositories", () => {
  test("no tracked doc or YAML file points at them, beyond the recorded history", () => {
    const offenders = trackedDocs()
      .filter((f) => !MAY_NAME_THE_PRIVATE_REPO.includes(f))
      .flatMap((f) => {
        const lines = referencingLines(readFileSync(join(ROOT, f), "utf8"));
        const allowed = RECORDED[f] ?? 0;
        return lines.length === allowed
          ? []
          : [`${f}: ${lines.length} referencing line(s), ${allowed} recorded: ${lines.slice(0, 3).map((l) => l.trim().slice(0, 80)).join(" | ")}`];
      });
    expect(offenders).toEqual([]);
  });

  test("every recorded file exists and is scanned", () => {
    const docs = trackedDocs();
    const missing = Object.keys(RECORDED).filter((f) => !docs.includes(f));
    expect({ missing }).toEqual({ missing: [] });
  });

  test("the scan reaches Markdown and YAML, including the issue chooser", () => {
    const docs = trackedDocs();
    expect(docs).toContain("README.md");
    expect(docs).toContain(".github/ISSUE_TEMPLATE/config.yml");
    expect(docs.length).toBeGreaterThan(50);
  });

  // Every phrasing this cleanup removed, verbatim, one at a time: restoring
  // any single one must fail the scan, not only restoring a whole file.
  const REMOVED = [
    "- optionally, a self-hosted chat UI (brain-ui, separate repo)",
    "- **The chat UI is a thin deployment shell.** `brain-ui` (separate repo) owns",
    "4. **brain-ui (separate repo) is a remote surface to an agent that can run",
    "`BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1` says otherwise. See brain-ui's own",
    // One sentence over two lines: caught as the sentence it is.
    "brain-kit and brain-ui each keep their own copies of the invisible-character and leakage gates. brain-ui's invisible-character gate stays dependency-free",
    "- Modify: `[brain-ui] scripts/entrypoint.sh` (five-minute poke line)",
    "guards the live tests (`BRAIN_UI_LIVE_TESTS=1` in brain-ui) — so it can never join a default",
    "- `docs/decisions.md` (brain-ui) needs two entries: the narrowed amendment to the",
    "- The crontab poke line lands in brain-ui's `entrypoint.sh` — a brain-ui release, not a",
    "(`[brain-ui] config/supervisord.conf:54-62`). The poke detects a *stopped",
    "- brain-ui deployment shell: dependency bump + verifying the cron env allowlist in `scripts/entrypoint.sh` exposes the same credentials the server classifies against — separate PR in the brain-ui repo after release.",
    "worker) lives in the separate `brain-ui` repo. Storybook/Vite would be the",
    "### 3.6 The deployment shell (phase 5, `brain-ui` repo)",
    "npm:pi-mcp-adapter npm:pi-subagents`); the brain-ui container does this on",
    "### 1a. The deployed brain-ui container",
    "- **Fail loud, secure by default** (brain-ui `docs/decisions.md` #3): the dominant defect",
    "### U3. Drain loop, leases, and the backstop poke (ui-server + brain-ui)",
    "case the brain-ui decisions doc calls out by name",
    "brain-ui `docs/decisions.md`: predicate tests on an allowlist function do not count",
    "| Protocol widening breaks the pinned brain-ui client | Additive-optional throughout; brain-ui bump is a follow-up release as with every protocol rev |",
    "default, `backend.ts:1039`, against brain-ui decision 3).",
    "9. **brain-ui gets tags.** Each milestone's deps-bump merge commit is tagged",
    "consumers in this repo — grep brain-ui before landing, and name the change in",
    "// The brain-ui shell does not currently pre-start its Puppeteer browser. For",
    "The values and shutdown order above mirror the `brain-ui` deployment shell.",
    "`bun update @schlessera/brain @schlessera/brain-module-*`; brain-ui takes it through its own lockfile bump and a redeploy.",
    "https://github.com/schlessera/brain",
    "See https://github.com/Schlessera/brain-ui/issues.",
    "url: https://github.com/schlessera/brain-ui",
  ];
  // The product names that stay, which no pattern may flag.
  const KEPT = [
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
    "[brain-ui](./packages/ui-server/README.md) is the chat server product",
    "the full brain-ui server environment, including those server-only values",
    "| 3 | + `DEEPGRAM_API_KEY` (with brain-ui) | Voice capture |",
    "The machine-readable surface other systems (primarily **brain-ui**) may depend",
    "[the maintainer's host] (using the brain-ui implementation) does not break",
  ];

  for (const text of REMOVED) {
    test(`catches: ${text.slice(0, 70)}`, () => {
      expect(referencesIn(text).length).toBeGreaterThan(0);
    });
  }

  test("flags none of the product names that stay", () => {
    expect(KEPT.filter((text) => referencesIn(text).length > 0)).toEqual([]);
  });

  test("the documents that may name them still do, so the allowlist is not dead", () => {
    for (const f of MAY_NAME_THE_PRIVATE_REPO) {
      expect({ f, named: referencesIn(readFileSync(join(ROOT, f), "utf8")).length > 0 }).toEqual({ f, named: true });
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
