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
 * Every tracked Markdown, YAML and TypeScript file: the docs a reader can
 * reach, the configuration GitHub shows them (the issue chooser, workflow
 * names), and the source comments and strings that ship or that a
 * contributor reads (#305).
 */
function trackedDocs(): string[] {
  const proc = Bun.spawnSync([
    "git", "-C", ROOT, "ls-files",
    "*.md", "**/*.md", "*.yml", "**/*.yml", "*.yaml", "**/*.yaml", "*.ts", "**/*.ts", "*.tsx", "**/*.tsx",
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
  // This file: every reference in it is a fixture, and its recorded digests
  // could not include themselves.
  "tests/public-docs.test.ts",
  "AGENTS.md",
  "docs/process/github.md",
  ".agents/skills/github/SKILL.md",
];

/**
 * Files that still carry references, pinned to exactly the references they
 * carry: a digest of their referencing paragraphs. Not a file exemption and
 * not a count: a new reference, an edited one, or one swapped for another
 * fails the scan like anywhere else, and so does one that was cleaned away,
 * until the digest is updated. The failure prints the new digest and the
 * paragraphs behind it, so an update is a reviewed diff of both.
 *
 * - Three decision records cite the private repository's files, pending #303,
 *   which decides where the container design they describe belongs.
 * - Tooling pending its own issue: the citation checker's form for another
 *   repository (#303), and the label taxonomy and sync that still cover the
 *   private instance (#299).
 * - Tests and the board sync that name the private repositories on purpose:
 *   as negative fixtures a guard must refuse, or as the rule that keeps
 *   them off the board. This is the explicit list of such fixtures (#305);
 *   a private reference added to any other test fails the scan.
 * - Changelogs are release history: an entry records what was true when it
 *   shipped. The digest keeps a NEW entry, copied in from a changeset at
 *   version time, from carrying a reference past this test.
 */
const RECORDED: Record<string, string> = {
  "docs/decisions/container-privilege.md": "a787d2c3dc0b49f2",
  "docs/decisions/agent-observability.md": "12daf66b1658bd40",
  "docs/decisions/README.md": "4ba97a8e9273de8d",
  "scripts/check-citations.ts": "819f30d08a731a31",
  "scripts/labels.ts": "667ad2a8bcecbf0f",
  "scripts/sync-labels.ts": "4cf488160f63c036",
  "scripts/sync-project.ts": "c491185e4368cdc2",
  "tests/decision-citations.test.ts": "b952ad1cdf51a17b",
  "tests/project-blockers.test.ts": "84dc8b0154e79476",
  "tests/project-sync-main.test.ts": "67116a2297046d31",
  "tests/project-sync-item.test.ts": "c8805cd52b00d4a9",
  "packages/core/CHANGELOG.md": "74c0ce78fcafc50e",
  "packages/ui-react/CHANGELOG.md": "2d30014b1c9170fd",
  "packages/ui-sdk/CHANGELOG.md": "2d30014b1c9170fd",
  "packages/ui-server/CHANGELOG.md": "2d30014b1c9170fd",
};

/** Name-like `brain-ui`: not followed by a character that makes it a package, path or file. */
const NAME = String.raw`brain-ui(?![-\w./])`;
/** Either apostrophe, as prose and editors write it. */
const APOS = "['\u2019]";

/**
 * The ways a document points at the private repositories or describes their
 * deployment. `brain-ui` alone is not one of them: it is also the product, in
 * the `@schlessera/brain-ui-*` packages, the `.brain-ui/` directory,
 * `brain-ui.db`, `BRAIN_UI_*` and the `mcp__brain-ui__*` tool prefix, and in
 * prose about the chat UI ("Open Settings in brain-ui"), which all stay.
 */
const PRIVATE_REFERENCES: [string, RegExp][] = [
  // `schlessera/brain` or `schlessera/brain-ui` as a repository or URL, in any
  // case, never the `@schlessera/brain` package or `schlessera/brain-kit`.
  ["repository name", /(?<![@\w])schlessera\/brain(?:-ui)?(?![-\w])/i],
  ["a link into it", /\]\([^)]*(?:^|\/|\.\.\/)brain-ui\/[^)]*\)/i],
  ['"separate repo"', new RegExp(`${NAME}[^.]{0,24}\\bseparate repo(?:sitory)?\\b`, "i")],
  ["the repo in words", new RegExp(`${NAME}\`?\\s+(?:repo|repository|repositories|decisions?)\\b|\\bprivate (?:deployment|instance)\\b`, "i")],
  ["a file in it", new RegExp(`${NAME}(?:${APOS}s)?\\s+\`[\\w./-]+\\.(?:sh|md|ts|ya?ml|conf|json)\`|${NAME}${APOS}s(?:\\s+own)?\\s+[\\w./-]+\\.(?:sh|md|ts|ya?ml|conf|json)\\b`, "i")],
  // A parenthesis that names who owns something: "`docs/decisions.md`
  // (brain-ui)", "(ui-server + brain-ui)", "(brain-ui `docs/decisions.md` #3)",
  // "(brain-ui, private)", "(… in brain-ui)". Not a product label: "(brain-ui)"
  // on its own, "(with brain-ui)", "(primarily **brain-ui**)".
  ["a parenthetical owner", /`[^`]+`\s*\(brain-ui\)|\([^()]*\+\s*brain-ui\)|\(brain-ui(?:,[^)]*|\s+`[^`]*`[^()]*)\)|\bin brain-ui\)/i],
  ["a release of it", new RegExp(`${NAME}\\*{0,2}\\s+(?:gets\\s+)?(?:release|bump|client|tags?)\\b|${NAME}[^.]{0,60}\\bredeploy\\b`, "i")],
  ["a repo action", new RegExp(`\\b(?:grep|clone|check out) ${NAME}`, "i")],
  // One real deployment of the product, rather than the product: "the
  // brain-ui container", not "a brain-ui container can be built".
  ["the deployment", new RegExp(`deployed ${NAME}|\\bthe ${NAME}\`? (?:container|docker image|image|deployment)\\b|${NAME}\`? (?:deploy|deployment shell|shell|docker image)\\b`, "i")],
  // A statement of what one real deployment has or lacks, rather than what
  // a deployment may have: "the deployment has neither", "A hosting
  // container **does** have `python3`".
  ["what the deployment has", /\bthe deployment (?:has neither|lacks)\b|\ba hosting container \*{0,2}does\*{0,2} have\b/i],
  // Its parts and its history: a file of the private deployment, what it had,
  // what a package descends from, and it as the named consumer.
  ["its parts or history", new RegExp(`\\bmirrored in \`scripts/entrypoint\\.sh\`|\`bun install\`ed by entrypoint\\.sh|\\b${NAME}['\u2019]s (?:hardcoded|container|shell|entrypoint|image|cron)\\b|\\bdescends from ${NAME}|\\bconsumer \\(brain-ui\\)`, "i")],
  // The two repositories named side by side, as peers that each keep something.
  ["brain-kit and brain-ui", new RegExp(`brain-kit and (?:the )?(?:private )?${NAME} (?:each|both|repos|repositories)\\b`, "i")],
  // A citation into it, never a Markdown link whose text is the product name.
  ["a citation into it", /\[brain-ui\](?!\()/i],
];

const referencesIn = (text: string) =>
  PRIVATE_REFERENCES.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);

/**
 * The paragraphs of a text that point at the private repositories, each with
 * its whitespace collapsed, so a reference wrapped across two lines is still
 * one reference.
 */
const referencingParagraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    // A comment's line prefixes (`*`, `//`) sit between the words of one
    // sentence; drop them so a phrase wrapped in a doc comment is one phrase.
    .map((paragraph) => paragraph.replace(/^[ \t]*(?:\/\*\*?|\*\/|\*(?!\*)|\/\/)[ \t]?/gm, ""))
    // A reference inside a string literal or inline markup is still one:
    // unescape quotes (`brain-ui\'s`) and drop tags (`<code>brain-ui</code>'s`).
    .map((paragraph) => paragraph.replace(/\\(['"`])/g, "$1").replace(/<\/?[a-z][^>]*>/gi, ""))
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => referencesIn(paragraph).length > 0);

const digest = (paragraphs: string[]) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(paragraphs)).digest("hex").slice(0, 16);

describe("public documents do not send readers to the private repositories", () => {
  test("no tracked doc or YAML file points at them, beyond the recorded history", () => {
    const offenders = trackedDocs()
      .filter((f) => !MAY_NAME_THE_PRIVATE_REPO.includes(f))
      .flatMap((f) => {
        const paragraphs = referencingParagraphs(readFileSync(join(ROOT, f), "utf8"));
        const recorded = RECORDED[f];
        if (recorded === undefined) {
          return paragraphs.length === 0 ? [] : [`${f}: ${paragraphs.map((p) => p.slice(0, 100)).join(" | ")}`];
        }
        return digest(paragraphs) === recorded
          ? []
          : [`${f}: recorded ${recorded}, now ${digest(paragraphs)} over ${paragraphs.length} paragraph(s): ${paragraphs.map((p) => p.slice(0, 80)).join(" | ")}`];
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
    "`BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1` says otherwise. See brain-ui's own SECURITY.md — it is the more critical of the two.",
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
    "| The private deployment repo | Applying the release there, and removing any deployment-specific Claude Code install or `CLAUDE_CODE_PATH` setting. Tracked there; not restated here. |",
    "least privilege in the container, is open and tracked in the private deployment shell's issue tracker.",
    // The bypasses the second review found.
    "See the repository for brain-ui\u2019s SECURITY.md.",
    "Deployment notes (brain-ui, private) document the maintainer's host.",
    "Read [brain-ui's decisions](../brain-ui/docs/decisions.md).",
    "[the security notes](../brain-ui/SECURITY.md)",
    // The source-side phrasings #305 removed.
    "Chrome refuses to start as root. `BRAIN_UI_CHROME_NO_SANDBOX` is the name the brain-ui image already sets.",
    "a deployment constraint, not a preference: the brain-ui container has bun and nothing else",
    "the brain repo is cloned and `bun install`ed by entrypoint.sh. The same preference order is mirrored in `scripts/entrypoint.sh`",
    "The wrapper (brain-ui's cron-run.ts) exports a file path",
    "Descends from brain-ui's hardcoded `ProviderConfig`, but the five personal presets are gone",
    "It descends from brain-ui's shared/protocol.ts with two deliberate cleanups",
    "There is no `magick` in a deployment. A hosting container **does** have `python3`",
    "do not reach for a Python or Node image library — the deployment has neither.",
    "The app moved out of the brain-ui repo into packages/ui-server",
    "The brain-ui shell had to peek at process.env.BRAIN_UI_REVERSE_GEOCODE",
    "brain-ui's container chain is the real case: relocation, then the user",
    "The consumer (brain-ui) declares the backend it actually deploys.",
    "often with a line range, and often in the private deployment-shell repo.",
    // Syntax the second review hid references in.
    "const help = 'See brain-ui\\'s cron-run.ts';",
    "<p>See <code>brain-ui</code>'s SECURITY.md</p>",
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
    // Product prose the second review found flagged.
    "brain-ui's own in-process tools use mcp__brain-ui__ names.",
    "The chat product (brain-ui) stores sessions in brain-ui.db.",
    "A brain-ui container can be built by any self-hoster.",
    "brain-kit and brain-ui expose CLI and chat interfaces respectively.",
    "Open Settings in brain-ui to configure voice.",
    "Create a private repo from the template",
    // Code and prose the TypeScript scan must leave alone.
    'const script = "scripts/entrypoint.sh";',
    "If the deployment has no Chrome, render skips.",
    "This protocol descends from brain-ui-sdk.",
  ];

  for (const text of REMOVED) {
    test(`catches: ${text.slice(0, 70)}`, () => {
      // Through the scan's own path, normalisation included.
      expect(referencingParagraphs(text).length).toBeGreaterThan(0);
    });
  }

  test("flags none of the product names that stay", () => {
    expect(KEPT.filter((text) => referencingParagraphs(text).length > 0)).toEqual([]);
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
