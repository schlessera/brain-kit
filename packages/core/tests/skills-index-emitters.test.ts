import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  CONTRACT_END,
  CONTRACT_FILE,
  CONTRACT_START,
  codexEmitter,
  renderContractBlock,
} from "../src/lib/skills/emitters/codex";
import { geminiEmitter } from "../src/lib/skills/emitters/gemini";
import {
  INDEX_END,
  INDEX_START,
  renderIndexBlock,
  upsertIndexBlock,
} from "../src/lib/skills/emitters/index-block";
import { syncSkills } from "../src/lib/skills/sync";
import type { SkillManifest } from "../src/lib/seams";

const tmpRoots: string[] = [];
function mkRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "bf-index-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A skill whose SKILL.md carries Claude-specific frontmatter keys + a body. */
function skill(root: string, name: string, description: string): SkillManifest {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      "disable-model-invocation: true",
      "allowed-tools: Bash",
      "---",
      "",
      `# ${name}`,
      "",
      "Run the workflow.",
      "",
    ].join("\n")
  );
  return { name, description, dir, source: "core", frontmatter: {} };
}

/** The text between the contract markers, below the managed-by comment. */
function contractBlockBody(text: string): string {
  const from = text.indexOf(CONTRACT_START);
  const to = text.indexOf(CONTRACT_END);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const inner = text.slice(from + CONTRACT_START.length, to);
  return inner.slice(inner.indexOf("-->") + "-->".length).trim();
}

const contractBody = readFileSync(CONTRACT_FILE, "utf8").trim();
const block = renderContractBlock(readFileSync(CONTRACT_FILE, "utf8"));

/**
 * Run `fn` with `paths` read-only: files 0444, directories 0555. The probe
 * proves the OS actually refuses a write (it would not for root), so a test
 * that passes inside here really made no write.
 */
function readOnly<T>(paths: string[], fn: () => T): T {
  for (const p of paths) chmodSync(p, statSync(p).isDirectory() ? 0o555 : 0o444);
  try {
    const dir = paths.find((p) => statSync(p).isDirectory())!;
    expect(() => writeFileSync(join(dir, ".write-probe"), "")).toThrow();
    return fn();
  } finally {
    for (const p of paths) chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
  }
}

describe("codexEmitter AGENTS.md contract block", () => {
  const root = mkRepo();
  const add = skill(root, "add", "Capture a note into the brain.");
  const audit = skill(root, "audit", "Report hygiene issues: staleness, orphans.");
  const agentsFile = join(root, "AGENTS.md");

  test("writes AGENTS.md and no .codex directory", () => {
    const res = codexEmitter.emit([add, audit], root);
    expect(res.written).toEqual(["AGENTS.md"]);
    expect(existsSync(join(root, ".codex"))).toBe(false);
  });

  test("the block's text is the body of the installed CONTRACT.md", () => {
    expect(contractBody.length).toBeGreaterThan(0);
    expect(contractBody).toContain("source of truth");
    expect(contractBlockBody(readFileSync(agentsFile, "utf8"))).toBe(contractBody);
  });

  test("the block restates no skill", () => {
    const text = readFileSync(agentsFile, "utf8");
    expect(text).not.toContain(INDEX_START);
    expect(text).not.toContain("Capture a note into the brain.");
  });

  test("re-running on an unchanged skill set makes no write at all", () => {
    const before = readFileSync(agentsFile);
    const res = readOnly([agentsFile, root], () => codexEmitter.emit([add, audit], root));
    expect(res).toEqual({ written: [], removed: [], warnings: [] });
    expect(readFileSync(agentsFile).equals(before)).toBe(true);
  });
});

describe("contract block preserves surrounding content", () => {
  const root = mkRepo();
  const add = skill(root, "add", "Capture a note.");
  const agentsFile = join(root, "AGENTS.md");
  const preamble = "# My Repo\n\nHand-written guidance the emitter must never touch.\n";
  const postamble = "\n## After\n\nMore hand-written text, below the block.\n";

  test("appends the block below existing content", () => {
    writeFileSync(agentsFile, preamble);
    codexEmitter.emit([add], root);
    const text = readFileSync(agentsFile, "utf8");
    expect(text.startsWith(preamble)).toBe(true);
    expect(text).toContain(CONTRACT_START);
  });

  test("content on both sides of the markers is byte-identical after a sync", () => {
    writeFileSync(agentsFile, readFileSync(agentsFile, "utf8") + postamble);
    const staleBlock = readFileSync(agentsFile, "utf8").replace(
      /<!-- brain-kit:contract:start -->[\s\S]*<!-- brain-kit:contract:end -->/,
      `${CONTRACT_START}\nan older contract\n${CONTRACT_END}`
    );
    writeFileSync(agentsFile, staleBlock);
    const before = readFileSync(agentsFile, "utf8");

    const res = codexEmitter.emit([add], root);
    expect(res.written).toEqual(["AGENTS.md"]);
    const after = readFileSync(agentsFile, "utf8");
    const outside = (t: string) => [
      t.slice(0, t.indexOf(CONTRACT_START)),
      t.slice(t.indexOf(CONTRACT_END) + CONTRACT_END.length),
    ];
    expect(outside(before)[0]).toBe(preamble + "\n");
    expect(outside(before)[1]).toBe("\n" + postamble);
    expect(outside(after)).toEqual(outside(before));
    expect(contractBlockBody(after)).toBe(contractBody);
  });

  test("re-run makes no write with the surrounding content intact", () => {
    const before = readFileSync(agentsFile);
    const res = readOnly([agentsFile, root], () => codexEmitter.emit([add], root));
    expect(res.written).toEqual([]);
    expect(readFileSync(agentsFile).equals(before)).toBe(true);
  });

  test("a whitespace-only AGENTS.md keeps its bytes ahead of the block", () => {
    const repo = mkRepo();
    writeFileSync(join(repo, "AGENTS.md"), "\n  \n");
    codexEmitter.emit([], repo);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("\n  \n\n" + block + "\n");
  });
});

describe("codexEmitter refuses ambiguous markers and changes nothing", () => {
  const cases: [string, string][] = [
    ["a contract start marker with no end", `# Rules\n\n${CONTRACT_START}\nKeep this rule.\n`],
    ["an orphan contract end marker", `# Rules\n\nKeep this rule.\n${CONTRACT_END}\n`],
    [
      "two contract blocks",
      `${CONTRACT_START}\nold\n${CONTRACT_END}\n\nKeep this rule.\n\n${CONTRACT_START}\nolder\n${CONTRACT_END}\n`,
    ],
    ["an end marker before its start", `${CONTRACT_END}\nKeep this rule.\n${CONTRACT_START}\n`],
    ["an index start marker with no end", `${INDEX_START}\n- **add** — Capture.\nKeep this rule.\n`],
    [
      "overlapping contract and index blocks",
      `${CONTRACT_START}\n${INDEX_START}\n${CONTRACT_END}\nKeep this rule.\n${INDEX_END}\n`,
    ],
  ];
  for (const [name, text] of cases) {
    test(`${name}: AGENTS.md is byte-identical after two syncs, with a warning`, () => {
      const root = mkRepo();
      const agentsFile = join(root, "AGENTS.md");
      writeFileSync(agentsFile, text);
      for (let run = 0; run < 2; run++) {
        const res = codexEmitter.emit([], root);
        expect(res.written).toEqual([]);
        expect(res.warnings?.join("\n")).toContain("fix the markers by hand");
        expect(readFileSync(agentsFile, "utf8")).toBe(text);
      }
    });
  }

  test("two index blocks delete no prompt", () => {
    const root = mkRepo();
    const add = skill(root, "add", "Capture a note.");
    const index = renderIndexBlock([add]);
    const text = `${index}\n\n${index}\n`;
    writeFileSync(join(root, "AGENTS.md"), text);
    legacyPrompt(root, "add", "Capture a note.");
    const res = codexEmitter.emit([add], root);
    expect(res.removed).toEqual([]);
    expect(existsSync(join(root, ".codex", "prompts", "add.md"))).toBe(true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(text);
  });
});

/** A prompt exactly as the old codex emitter rendered it. */
function legacyPrompt(root: string, name: string, description: string, body = "# Body\n\nRun it."): string {
  const dir = join(root, ".codex", "prompts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.md`);
  writeFileSync(
    file,
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
  );
  return file;
}

describe("codexEmitter migrates a repo off the prompts and the index block", () => {
  /** AGENTS.md and `.codex/prompts/` as the codex emitter left them before it changed. */
  function legacyRepo() {
    const root = mkRepo();
    const add = skill(root, "add", "Capture a note.");
    const audit = skill(root, "audit", "Report hygiene issues.");
    const agentsFile = join(root, "AGENTS.md");
    const preamble = "# My Repo\n\nHand-written.\n";
    writeFileSync(agentsFile, preamble);
    upsertIndexBlock(agentsFile, [add, audit]);
    writeFileSync(agentsFile, readFileSync(agentsFile, "utf8") + "\nTrailing notes.\n");
    const promptsDir = join(root, ".codex", "prompts");
    legacyPrompt(root, "add", "Capture a note.");
    legacyPrompt(root, "audit", "Report hygiene issues.");
    return { root, add, audit, agentsFile, preamble, promptsDir };
  }

  test("ends with neither the index block nor the prompts it named", () => {
    const { root, add, audit, agentsFile, preamble } = legacyRepo();
    expect(readFileSync(agentsFile, "utf8")).toContain("- **audit**");

    const res = codexEmitter.emit([add, audit], root);
    expect(res.warnings).toEqual([]);
    expect(res.written).toEqual(["AGENTS.md"]);
    expect(res.removed.sort()).toEqual(
      [".codex", ".codex/prompts", ".codex/prompts/add.md", ".codex/prompts/audit.md"].sort()
    );
    expect(existsSync(join(root, ".codex"))).toBe(false);

    const text = readFileSync(agentsFile, "utf8");
    expect(text).not.toContain(INDEX_START);
    expect(text).not.toContain(INDEX_END);
    expect(text).not.toContain("- **add**");
    // Swapped in place: what surrounded the old block surrounds the new one.
    expect(text).toBe(preamble + "\n" + block + "\n\nTrailing notes.\n");
    expect(contractBlockBody(text)).toBe(contractBody);

    const again = readOnly([agentsFile, root], () => codexEmitter.emit([add, audit], root));
    expect(again).toEqual({ written: [], removed: [], warnings: [] });
  });

  test("keeps a prompt the index block did not name, and its directory", () => {
    const { root, add, audit, promptsDir } = legacyRepo();
    legacyPrompt(root, "handmade", "Mine.");
    const res = codexEmitter.emit([add, audit], root);
    expect(res.removed.sort()).toEqual([".codex/prompts/add.md", ".codex/prompts/audit.md"]);
    expect(readdirSync(promptsDir)).toEqual(["handmade.md"]);
  });

  test("keeps a named prompt whose content is not the generated template, and says so", () => {
    const { root, add, audit, promptsDir } = legacyRepo();
    const edited = join(promptsDir, "audit.md");
    writeFileSync(edited, readFileSync(edited, "utf8").replace("---\n\n", "---\n\nMy own edit.\n"));
    const withKey = join(promptsDir, "add.md");
    writeFileSync(
      withKey,
      readFileSync(withKey, "utf8").replace("---\n", "---\nauthor: me\n")
    );
    const res = codexEmitter.emit([add, audit], root);
    // audit.md: only the frontmatter is checked. The old emitter rewrote the
    // body from SKILL.md on every sync, so an edit there never survived anyway.
    expect(res.removed).toEqual([".codex/prompts/audit.md"]);
    expect(existsSync(withKey)).toBe(true);
    expect(res.warnings).toEqual([".codex/prompts/add.md is not the prompt brain-kit generated for \"add\"; left in place"]);
  });

  test("a row naming a path outside .codex/prompts deletes nothing there", () => {
    const root = mkRepo();
    mkdirSync(join(root, "notes"), { recursive: true });
    const note = join(root, "notes", "keep.md");
    const noteText = `---\nname: "../../notes/keep"\ndescription: "x"\n---\n\nA real note.\n`;
    writeFileSync(note, noteText);
    mkdirSync(join(root, ".codex", "prompts"), { recursive: true });
    const agentsFile = join(root, "AGENTS.md");
    writeFileSync(agentsFile, renderIndexBlock([{ name: "../../notes/keep", description: "x", dir: root, source: "local", frontmatter: {} }]) + "\n");

    const res = codexEmitter.emit([], root);
    expect(existsSync(note)).toBe(true);
    expect(readFileSync(note, "utf8")).toBe(noteText);
    expect(res.removed).not.toContain("notes/keep.md");
    expect(res.warnings?.[0]).toContain("does not name a skill unambiguously");
  });

  test("a row whose name the old renderer could not delimit keeps a hand-written prompt", () => {
    const root = mkRepo();
    const agentsFile = join(root, "AGENTS.md");
    // The old renderer wrote this row for a skill named `review** — notes`.
    writeFileSync(agentsFile, renderIndexBlock([{ name: "review** — notes", description: "desc", dir: root, source: "local", frontmatter: {} }]) + "\n");
    mkdirSync(join(root, ".codex", "prompts"), { recursive: true });
    const handwritten = join(root, ".codex", "prompts", "review.md");
    writeFileSync(handwritten, "My own review prompt.\n");
    const generated = legacyPrompt(root, "review** — notes", "desc");

    const res = codexEmitter.emit([], root);
    expect(existsSync(handwritten)).toBe(true);
    expect(readFileSync(handwritten, "utf8")).toBe("My own review prompt.\n");
    expect(existsSync(generated)).toBe(true);
    expect(res.removed).toEqual([]);
    expect(res.warnings).toEqual([".codex/prompts/review.md is not the prompt brain-kit generated for \"review\"; left in place"]);
  });

  test("a symlinked prompt, or a symlinked prompts directory, is not followed", () => {
    const { root, add, audit, promptsDir } = legacyRepo();
    const outside = mkRepo();
    const target = legacyPrompt(outside, "audit", "Report hygiene issues.");
    rmSync(join(promptsDir, "audit.md"));
    symlinkSync(target, join(promptsDir, "audit.md"));
    const res = codexEmitter.emit([add, audit], root);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(promptsDir) ? readdirSync(promptsDir) : []).toEqual(["audit.md"]);
    expect(lstatSync(join(promptsDir, "audit.md")).isSymbolicLink()).toBe(true);
    expect(res.removed).toEqual([".codex/prompts/add.md"]);

    const second = legacyRepo();
    const elsewhere = join(mkRepo(), "prompts");
    renameSync(second.promptsDir, elsewhere);
    symlinkSync(elsewhere, second.promptsDir);
    const res2 = codexEmitter.emit([second.add, second.audit], second.root);
    expect(readdirSync(elsewhere).sort()).toEqual(["add.md", "audit.md"]);
    expect(res2.removed).toEqual([]);
    expect(res2.warnings).toEqual(["`.codex/prompts` is not a plain directory; left its prompts in place"]);
  });

  test("a failed deletion keeps the index block, and the next sync finishes the job", () => {
    const { root, add, audit, agentsFile, promptsDir } = legacyRepo();
    const before = readFileSync(agentsFile, "utf8");
    const res = readOnly([promptsDir], () => codexEmitter.emit([add, audit], root));
    expect(res.written).toEqual([]);
    expect(res.warnings?.join("\n")).toContain("kept the old index block so the next sync retries");
    expect(readFileSync(agentsFile, "utf8")).toBe(before);

    const retry = codexEmitter.emit([add, audit], root);
    expect(retry.removed).toContain(".codex/prompts/audit.md");
    expect(existsSync(join(root, ".codex"))).toBe(false);
    expect(readFileSync(agentsFile, "utf8")).not.toContain(INDEX_START);
  });

  test("empty legacy directories go even when there was nothing to delete", () => {
    const root = mkRepo();
    writeFileSync(join(root, "AGENTS.md"), renderIndexBlock([]) + "\n");
    mkdirSync(join(root, ".codex", "prompts"), { recursive: true });
    const res = codexEmitter.emit([], root);
    expect(res.removed).toEqual([".codex/prompts", ".codex"]);
    expect(existsSync(join(root, ".codex"))).toBe(false);
  });

  test("drops an index block left beside an existing contract block, and only its span", () => {
    const root = mkRepo();
    const add = skill(root, "add", "Capture a note.");
    const text = `# Top\n\n${block}\n\nMiddle.\n\n${renderIndexBlock([add])}\n\nBottom.\n`;
    writeFileSync(join(root, "AGENTS.md"), text);

    const res = codexEmitter.emit([add], root);
    expect(res.written).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(`# Top\n\n${block}\n\nMiddle.\n\n\n\nBottom.\n`);
  });
});

describe("syncSkills surfaces an emitter's warnings", () => {
  test("a malformed AGENTS.md reaches SyncResult.warnings, prefixed with the agent", () => {
    const root = mkRepo();
    writeFileSync(join(root, "AGENTS.md"), `${CONTRACT_START}\nno end\n`);
    const res = syncSkills({ root, modules: [] }, { emitters: [codexEmitter], coreSkillsDir: join(root, "none") });
    expect(res.warnings.some((w) => w.startsWith("codex emitter: AGENTS.md has 1 start and 0 end marker(s)"))).toBe(true);
    expect(res.emitters).toEqual([{ agent: "codex", written: [], removed: [] }]);
  });
});

describe("geminiEmitter GEMINI.md index", () => {
  const root = mkRepo();
  const add = skill(root, "add", "Capture a note.");
  const geminiFile = join(root, "GEMINI.md");

  test("creates the block then is idempotent", () => {
    const first = geminiEmitter.emit([add], root);
    expect(first.written).toEqual(["GEMINI.md"]);
    const bytes = readFileSync(geminiFile);
    expect(readFileSync(geminiFile, "utf8")).toContain("- **add**");

    const second = geminiEmitter.emit([add], root);
    expect(second.written).toEqual([]);
    expect(readFileSync(geminiFile).equals(bytes)).toBe(true);
  });
});
