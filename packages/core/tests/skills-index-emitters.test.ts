import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  CONTRACT_END,
  CONTRACT_FILE,
  CONTRACT_START,
  codexEmitter,
} from "../src/lib/skills/emitters/codex";
import { geminiEmitter } from "../src/lib/skills/emitters/gemini";
import { INDEX_END, INDEX_START, upsertIndexBlock } from "../src/lib/skills/emitters/index-block";
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

  test("re-running on an unchanged skill set writes nothing", () => {
    const before = readFileSync(agentsFile);
    const res = codexEmitter.emit([add, audit], root);
    expect(res).toEqual({ written: [], removed: [] });
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

  test("re-run stays idempotent with the surrounding content intact", () => {
    const before = readFileSync(agentsFile);
    codexEmitter.emit([add], root);
    expect(readFileSync(agentsFile).equals(before)).toBe(true);
  });
});

describe("codexEmitter migrates a repo off the prompts and the index block", () => {
  /** AGENTS.md and `.codex/prompts/` as the codex emitter left them before it changed. */
  function legacyRepo(extraPrompt?: string) {
    const root = mkRepo();
    const add = skill(root, "add", "Capture a note.");
    const audit = skill(root, "audit", "Report hygiene issues.");
    const agentsFile = join(root, "AGENTS.md");
    const preamble = "# My Repo\n\nHand-written.\n";
    writeFileSync(agentsFile, preamble);
    upsertIndexBlock(agentsFile, [add, audit]);
    writeFileSync(agentsFile, readFileSync(agentsFile, "utf8") + "\nTrailing notes.\n");
    const promptsDir = join(root, ".codex", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    for (const name of ["add", "audit", ...(extraPrompt ? [extraPrompt] : [])]) {
      writeFileSync(join(promptsDir, `${name}.md`), `---\nname: "${name}"\n---\n`);
    }
    return { root, add, audit, agentsFile, preamble, promptsDir };
  }

  test("ends with neither the index block nor the prompts it named", () => {
    const { root, add, audit, agentsFile, preamble } = legacyRepo();
    expect(readFileSync(agentsFile, "utf8")).toContain("- **audit**");

    const res = codexEmitter.emit([add, audit], root);
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
    expect(text.startsWith(preamble + "\n" + CONTRACT_START)).toBe(true);
    expect(text.endsWith(CONTRACT_END + "\n\nTrailing notes.\n")).toBe(true);
    expect(contractBlockBody(text)).toBe(contractBody);

    expect(codexEmitter.emit([add, audit], root)).toEqual({ written: [], removed: [] });
  });

  test("keeps a prompt the index block did not name, and its directory", () => {
    const { root, add, audit, promptsDir } = legacyRepo("handmade");
    const res = codexEmitter.emit([add, audit], root);
    expect(res.removed.sort()).toEqual([".codex/prompts/add.md", ".codex/prompts/audit.md"]);
    expect(readdirSync(promptsDir)).toEqual(["handmade.md"]);
  });

  test("drops an index block left beside an existing contract block", () => {
    const { root, add, audit, agentsFile } = legacyRepo();
    codexEmitter.emit([add, audit], root);
    upsertIndexBlock(agentsFile, [add]);
    expect(readFileSync(agentsFile, "utf8")).toContain(INDEX_START);

    const res = codexEmitter.emit([add, audit], root);
    expect(res.written).toEqual(["AGENTS.md"]);
    const text = readFileSync(agentsFile, "utf8");
    expect(text).not.toContain(INDEX_START);
    expect(text.endsWith(CONTRACT_END + "\n\nTrailing notes.\n")).toBe(true);
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
