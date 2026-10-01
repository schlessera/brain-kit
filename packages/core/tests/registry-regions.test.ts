/**
 * Generated regions and `_index.md` registry tables (#403).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { brainConfigSchema } from "../src/lib/config";
import { readGeneratedRegion, replaceGeneratedRegion } from "../src/lib/generated-regions";
import { applyRegistry, planRegistry, registrySpecSchema, renderRegistry, runRegistry } from "../src/lib/index-registry";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

describe("replaceGeneratedRegion / readGeneratedRegion", () => {
  const OPEN = "<!-- brain:generated:t -->";
  const CLOSE = "<!-- /brain:generated:t -->";

  test("keeps every byte outside the markers, and reads back what it wrote", () => {
    const before = "Intro  \r\nwith odd spacing\n\n";
    const after = "\n\nTrailing *prose*\n";
    const body = `${before}${OPEN}\n\nold\n\n${CLOSE}${after}`;
    const next = replaceGeneratedRegion(body, "t", "| a |\n| - |");
    expect(next).toBe(`${before}${OPEN}\n\n| a |\n| - |\n\n${CLOSE}${after}`);
    expect(readGeneratedRegion(next, "t")).toBe("| a |\n| - |");
  });

  test("is a no-op, the very same string, when the content is unchanged", () => {
    const body = `x\n\n${OPEN}\n\nsame\n\n${CLOSE}\n`;
    expect(replaceGeneratedRegion(body, "t", "same")).toBe(body);
  });

  test("appends the region to a body that has none", () => {
    expect(replaceGeneratedRegion("Prose.\n\n", "t", "c")).toBe(`Prose.\n\n${OPEN}\n\nc\n\n${CLOSE}\n`);
    expect(readGeneratedRegion("Prose.", "t")).toBeNull();
  });

  test("appending keeps every byte of the body, trailing spaces and CRLF included", () => {
    const crlf = "Prose.  \r\n\r\n\r\n";
    expect(replaceGeneratedRegion(crlf, "t", "a\nb")).toBe(`${crlf}${OPEN}\r\n\r\na\r\nb\r\n\r\n${CLOSE}\r\n`);
    expect(replaceGeneratedRegion("Prose.  ", "t", "c")).toBe(`Prose.  \n\n${OPEN}\n\nc\n\n${CLOSE}\n`);
    expect(replaceGeneratedRegion("Prose.\n", "t", "c")).toBe(`Prose.\n\n${OPEN}\n\nc\n\n${CLOSE}\n`);
  });

  test("a marker inside a line is text: a cell quoting the closing marker does not end the region", () => {
    const content = `| title |\n| --- |\n| a ${CLOSE} b |`;
    const once = replaceGeneratedRegion("Prose.\n", "t", content);
    expect(readGeneratedRegion(once, "t")).toBe(content);
    expect(replaceGeneratedRegion(once, "t", content)).toBe(once);
  });

  test("markers quoted in a fenced example are text: the region is appended after it, the example untouched", () => {
    const example = `Prose.\n\n\`\`\`markdown\n${OPEN}\n\n${CLOSE}\n\`\`\`\n`;
    const next = replaceGeneratedRegion(example, "t", "c");
    expect(next).toBe(`${example}\n${OPEN}\n\nc\n\n${CLOSE}\n`);
    expect(readGeneratedRegion(next, "t")).toBe("c");
  });

  test("a body that ends inside an unclosed fence is refused, since the region would not read back", () => {
    for (const fence of ["```", "~~~"]) {
      const body = `Prose.\n\n${fence}markdown\nan example left open\n`;
      expect(() => replaceGeneratedRegion(body, "t", "c")).toThrow(/would not read back as written/);
    }
  });

  test("malformed markers throw instead of guessing the region", () => {
    for (const body of [
      `${OPEN}\n\nx\n`, // no closing line
      `${CLOSE}\n\n${OPEN}\n`, // closing first
      `${OPEN}\n${CLOSE}\n${OPEN}\n${CLOSE}\n`, // two regions
      `${CLOSE}\n`, // a stray closing line
    ]) {
      expect(() => replaceGeneratedRegion(body, "t", "c")).toThrow(/malformed markers/);
    }
  });
});

describe("planRegistry / applyRegistry", () => {
  const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({}) });
  const INDEX = ["---", "type: index", "title: Projects", "updated: 2026-01-02", "registry: { columns: [title, status] }", "---", "", "Prose.", ""].join("\n");

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "brain-registry-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  const child = (title: string, status = "active") => `---\ntype: project\ntitle: ${JSON.stringify(title)}\nstatus: ${status}\n---\n\nBody.\n`;

  test("an index edited after planning is not overwritten, and is listed as stale", () => {
    const root = tree({ "projects/_index.md": INDEX, "projects/a.md": child("Alpha") });
    const plan = planRegistry(root, taxonomy, "2026-06-01");
    expect(plan.indexes[0].next).not.toBeNull();
    const edited = INDEX.replace("Prose.", "Prose, edited while the plan was made.");
    writeFileSync(join(root, "projects/_index.md"), edited);

    const run = applyRegistry(root, plan, {});
    expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(edited);
    expect(run).toMatchObject({ written: [], stale: ["projects/_index.md"] });
  });

  test("a child whose frontmatter does not parse is reported, and its index left as it is", () => {
    const root = tree({
      "projects/_index.md": INDEX,
      "projects/a.md": child("Alpha"),
      "projects/b.md": '---\ntitle: "Unclosed\nstatus: active\n---\n',
    });
    const run = runRegistry(root, taxonomy, { asOf: "2026-06-01" });
    expect(run.invalid).toEqual([{ path: "projects/_index.md", error: expect.stringContaining("child projects/b.md: frontmatter does not parse") }]);
    expect(run.written).toEqual([]);
    expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(INDEX);
  });

  test("an index whose frontmatter does not parse is reported when it has a registry line", () => {
    const broken = INDEX.replace("registry: { columns: [title, status] }", "registry: { columns: [title, status]");
    const root = tree({ "projects/_index.md": broken, "projects/a.md": child("Alpha"), "notes/_index.md": '---\ntitle: "Unclosed\n---\n' });
    const run = runRegistry(root, taxonomy, { asOf: "2026-06-01" });
    expect(run.invalid.map((p) => p.path)).toEqual(["projects/_index.md"]);
    expect(run.invalid[0].error).toContain("frontmatter does not parse");
    expect(run.indexes).toBe(1);
    expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(broken);
  });

  test("an index whose frontmatter never closes is reported and left as it is", () => {
    const unclosed = "---\ntitle: Projects\nupdated: 2026-01-01\nregistry: {columns: [title]}\n\nProse.\n";
    const root = tree({ "projects/_index.md": unclosed, "projects/a.md": child("Alpha") });
    const run = runRegistry(root, taxonomy, { asOf: "2026-06-01" });
    expect(run.invalid).toEqual([{ path: "projects/_index.md", error: expect.stringContaining("no closing --- line") }]);
    expect(run.written).toEqual([]);
    expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(unclosed);
    // And the next run still reports it, rather than finding nothing.
    expect(runRegistry(root, taxonomy, { asOf: "2026-06-02" }).invalid.map((p) => p.path)).toEqual(["projects/_index.md"]);
  });

  test("an index that ends inside an unclosed fence is reported, left as it is, and a second run changes nothing", () => {
    for (const fence of ["```", "~~~"]) {
      const open = `${INDEX}\n${fence}text\nan example left open\n`;
      const root = tree({ "projects/_index.md": open, "projects/a.md": child("Alpha") });
      for (const asOf of ["2026-06-01", "2026-06-02"]) {
        const run = runRegistry(root, taxonomy, { asOf });
        expect({ fence, asOf, invalid: run.invalid, written: run.written }).toEqual({
          fence,
          asOf,
          invalid: [{ path: "projects/_index.md", error: expect.stringContaining("would not read back as written") }],
          written: [],
        });
        expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(open);
      }
    }
  });

  test("a child whose frontmatter never closes is reported on its index", () => {
    // Valid YAML, and no body: only the missing closing fence is wrong, which gray-matter accepts.
    const root = tree({ "projects/_index.md": INDEX, "projects/a.md": "---\ntitle: Alpha\nstatus: active\n" });
    const run = runRegistry(root, taxonomy, { asOf: "2026-06-01" });
    expect(run.invalid).toEqual([
      { path: "projects/_index.md", error: "child projects/a.md: frontmatter does not parse: frontmatter has no closing --- line" },
    ]);
    expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(INDEX);
  });

  test("a malformed quoted registry key counts as opted in and is reported", () => {
    const broken = INDEX.replace("registry: { columns: [title, status] }", '"registry": {columns: [title]');
    const root = tree({ "projects/_index.md": broken, "projects/a.md": child("Alpha") });
    const run = runRegistry(root, taxonomy, { asOf: "2026-06-01" });
    expect(run.invalid.map((p) => p.path)).toEqual(["projects/_index.md"]);
    expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(broken);
  });

  test("an unreadable index is reported, not skipped", () => {
    const root = tree({ "projects/_index.md": INDEX, "projects/a.md": child("Alpha") });
    chmodSync(join(root, "projects/_index.md"), 0o000);
    try {
      // Root reads anything; the case only exists for a normal user.
      if (process.getuid?.() === 0) return;
      const run = runRegistry(root, taxonomy, { asOf: "2026-06-01" });
      expect(run.invalid).toEqual([{ path: "projects/_index.md", error: expect.stringContaining("unreadable") }]);
    } finally {
      chmodSync(join(root, "projects/_index.md"), 0o644);
    }
  });

  test("a title quoting the closing marker is inert in its cell, and a second run writes nothing", () => {
    const root = tree({ "projects/_index.md": INDEX, "projects/a.md": child("<!-- /brain:generated:registry --> trick") });
    expect(runRegistry(root, taxonomy, { asOf: "2026-06-01" }).written).toEqual(["projects/_index.md"]);
    const first = readFileSync(join(root, "projects/_index.md"), "utf8");
    expect(readGeneratedRegion(first, "registry")).toContain("| &lt;!-- /brain:generated:registry --> trick | active |");
    expect(runRegistry(root, taxonomy, { asOf: "2026-06-02" }).written).toEqual([]);
    expect(readFileSync(join(root, "projects/_index.md"), "utf8")).toBe(first);
  });
});

/** A file's identity and mtime: a write (in place or by rename) changes one of them. */
function stamp(path: string): { ino: number; mtimeMs: number } {
  const { ino, mtimeMs } = statSync(path);
  return { ino, mtimeMs };
}

/** Put a file's mtime in the past, so a rewrite in the same second still shows. */
function age(path: string): void {
  utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
}

/** The fixture brain with a `projects/_index.md` that opts in. */
function brain(): { root: string; index: string; prose: string } {
  const root = makeTempBrain();
  roots.push(root);
  const index = join(root, "projects/_index.md");
  const prose = [
    "---",
    "type: index",
    "title: Projects",
    'created: "2026-01-01"',
    "updated: 2026-01-02",
    "registry: { columns: [link, status, updated] }",
    "---",
    "",
    "# Projects",
    "",
    "Hand-written  purpose blurb, kept byte for byte.",
    "",
  ].join("\n");
  writeFileSync(index, prose);
  return { root, index, prose };
}

async function json(root: string, args: string[]): Promise<{ code: number; out: any }> {
  const r = await runCli(root, [...args, "--json"]);
  return { code: r.code, out: JSON.parse(r.stdout) };
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "-c", "commit.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

describe("brain registry", () => {
  test("writes a table of the children and keeps the prose around it", async () => {
    const { root, index, prose } = brain();
    const { code, out } = await json(root, ["registry"]);
    expect(code).toBe(0);
    expect(out.written).toEqual(["projects/_index.md"]);

    const text = readFileSync(index, "utf8");
    const bodyBefore = prose.slice(prose.indexOf("---\n", 4) + 4);
    const bodyAfter = text.slice(text.indexOf("---\n", 4) + 4);
    expect(bodyAfter.slice(0, bodyBefore.length)).toBe(bodyBefore);
    expect(bodyAfter.slice(bodyBefore.length)).toStartWith("\n<!-- brain:generated:registry -->\n");
    const table = readGeneratedRegion(text, "registry")!;
    expect(table.split("\n").slice(0, 2)).toEqual(["| link | status | updated |", "| --- | --- | --- |"]);
    expect(table).toContain("| [[projects/active/raft/status]] |");
    expect(table).toContain("| [[projects/active/sail-repairs/status]] |");
    expect(text).toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
    expect(text).not.toContain("updated: 2026-01-02");
  }, 60_000);

  test("a second run writes nothing and does not bump updated", async () => {
    const { root, index } = brain();
    await json(root, ["registry"]);
    const first = readFileSync(index, "utf8");
    writeFileSync(index, first.replace(/^updated: .*$/m, "updated: 2026-01-03"));
    const pinned = readFileSync(index, "utf8");

    age(index);
    const before = stamp(index);

    const { out } = await json(root, ["registry"]);
    expect(out).toMatchObject({ indexes: 1, written: [], stale: [], invalid: [] });
    expect(stamp(index)).toEqual(before);
    expect(readFileSync(index, "utf8")).toBe(pinned);
  }, 60_000);

  test("brain maintain has a registry step and writes the same file", async () => {
    const a = brain();
    const b = brain();
    await json(a.root, ["registry"]);
    const { out } = await json(b.root, ["maintain", "--no-git"]);
    const step = (out as Array<{ step: string; result: string }>).find((s) => s.step === "registry");
    expect(step?.result).toBe("ok — 1 of 1 table(s) rewritten");
    expect(readFileSync(b.index, "utf8")).toBe(readFileSync(a.index, "utf8"));
  }, 120_000);

  test("a child's changed status makes the index index-stale, not index-lag", async () => {
    const { root, index } = brain();
    // The child's updated goes far ahead of the index's first, so plain
    // index-lag would fire; the table is generated with it in place.
    const child = join(root, "projects/active/sail-repairs/status.md");
    writeFileSync(child, readFileSync(child, "utf8").replace(/^updated: .*$/m, "updated: 2027-01-01"));
    await json(root, ["registry"]);
    // Then only the status changes.
    writeFileSync(child, readFileSync(child, "utf8").replace(/^status: .*$/m, "status: paused"));
    await runCli(root, ["index", "--json"]);
    const { out } = await json(root, ["audit"]);
    const onIndex = (out.issues as Array<{ path: string; category: string }>).filter((i) => i.path === "projects/_index.md");
    expect(onIndex.map((i) => i.category)).toContain("index-stale");
    expect(onIndex.map((i) => i.category)).not.toContain("index-lag");
    expect(readFileSync(index, "utf8")).toContain("<!-- brain:generated:registry -->");
  }, 120_000);

  test("--check exits 1 on a stale index and writes nothing", async () => {
    const { root } = brain();
    await json(root, ["registry"]);
    const child = join(root, "projects/active/sail-repairs/status.md");
    writeFileSync(child, readFileSync(child, "utf8").replace(/^status: .*$/m, "status: paused"));
    git(root, "init", "-q");
    git(root, "add", "-A", "--", ".", ":!node_modules");
    git(root, "commit", "-qm", "fixture");

    const { code, out } = await json(root, ["registry", "--check"]);
    expect(code).toBe(1);
    expect(out.stale).toEqual(["projects/_index.md"]);
    expect(git(root, "status", "--porcelain", "--", ".", ":!node_modules")).toBe("");
  }, 120_000);

  test("takes no arguments", async () => {
    const { root } = brain();
    const r = await runCli(root, ["registry", "--", "--check"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("brain registry takes no arguments, got: --check");
  }, 60_000);

  test("refuses to write in an uninitialized directory; --check still reads", async () => {
    const root = makeTempBrain({ empty: true });
    roots.push(root);
    const index = join(root, "projects/_index.md");
    mkdirSync(dirname(index), { recursive: true });
    const text = "---\ntitle: Projects\nregistry: { columns: [title] }\n---\n\nProse.\n";
    writeFileSync(index, text);
    writeFileSync(join(root, "projects/a.md"), "---\ntitle: Alpha\n---\n");

    const write = await runCli(root, ["registry"]);
    expect(write.code).toBe(1);
    expect(write.stderr).toContain("refusing to modify an uninitialized directory");
    expect(readFileSync(index, "utf8")).toBe(text);

    // After `--`, "--check" is an argument, not the flag: this is still a write.
    const terminated = await runCli(root, ["registry", "--", "--check"]);
    expect(terminated.code).toBe(1);
    expect(terminated.stderr).toContain("refusing to modify an uninitialized directory");
    expect(readFileSync(index, "utf8")).toBe(text);

    const check = await runCli(root, ["registry", "--check", "--json"]);
    expect(JSON.parse(check.stdout).stale).toEqual(["projects/_index.md"]);
    expect(readFileSync(index, "utf8")).toBe(text);
  }, 60_000);
});

describe("renderRegistry split into named tables", () => {
  const child = (path: string, stage?: string) => ({ path, data: stage === undefined ? {} : { stage } });
  const spec = {
    columns: ["path", "stage"],
    split: { key: "stage", tables: { Active: ["researching", "interviewing"], Closed: ["closed"] } },
  };

  test("groups rows into the named tables, in the spec's order, then the values none named", () => {
    const out = renderRegistry(
      spec,
      [child("x/a.md", "closed"), child("x/b.md", "researching"), child("x/c.md", "interviewing"), child("x/d.md", "paused"), child("x/e.md")],
      "x"
    );
    const headings = out.split("\n").filter((line) => line.startsWith("**"));
    expect(headings).toEqual(["**Active**", "**Closed**", "**stage: paused**", "**stage: —**"]);
    const active = out.split("**Active**")[1]!.split("**Closed**")[0]!;
    expect(active).toContain("| b.md | researching |");
    expect(active).toContain("| c.md | interviewing |");
    expect(active).not.toContain("closed");
  });

  test("a whole-number label is rejected, since it would not keep its listed order", () => {
    // The counterexample: JavaScript lists "2" before "10", whatever the YAML says.
    expect(Object.keys({ "10": 1, "2": 2 })).toEqual(["2", "10"]);
    const numeric = { columns: ["path"], split: { key: "stage", tables: { "10": ["researching"], "2": ["closed"] } } };
    const parsed = registrySpecSchema.safeParse(numeric);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("whole number");
    // A label with other text, or a leading zero, keeps its place and is accepted.
    for (const label of ["Top 10", "02"]) {
      expect(registrySpecSchema.safeParse({ ...numeric, split: { key: "stage", tables: { [label]: ["closed"] } } }).success).toBe(true);
    }
  });

  test("a label is made inert like any generated text", () => {
    const out = renderRegistry(
      { columns: ["path"], split: { key: "stage", tables: { "Now | <!-- soon": ["researching"] } } },
      [child("x/b.md", "researching")],
      "x"
    );
    expect(out.split("\n")[0]).toBe("**Now \\| &lt;!-- soon**");
  });

  test("leaves out a named table no row falls into", () => {
    const out = renderRegistry(spec, [child("x/b.md", "researching")], "x");
    expect(out).toContain("**Active**");
    expect(out).not.toContain("**Closed**");
  });

  test("the spec accepts the named form and still rejects an empty table", () => {
    expect(registrySpecSchema.safeParse(spec).success).toBe(true);
    expect(registrySpecSchema.safeParse({ ...spec, split: { key: "stage", tables: { Active: [] } } }).success).toBe(false);
  });
});
