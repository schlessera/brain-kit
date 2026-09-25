/**
 * The measurement harness's counting rules, asserted.
 *
 * `scripts/measure-show-block-server.ts` produces a number that goes into a
 * decision record, and a counting hole there is a confident wrong number
 * rather than a visible failure. Two of its rules are pure and cheap to pin,
 * and both were wrong at some point on the way to the recorded number. The
 * table count began as a regex over delimiter rows: it required the outer
 * pipes GFM does not, missed a single-column table, and counted a table
 * printed inside a fenced code block, which draws nothing. The escape rule
 * began as a string prefix, which puts `/home/x/brain-backup` inside
 * `/home/x/brain`.
 *
 * The live half needs the network and a key, so it is not tested here and
 * never runs in CI.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { SHOW_BLOCK_CONTRACT } from "../packages/ui-sdk/src/tool-contracts/blocks.ts";
import {
  assertMeasurableBrainPath,
  countMarkdownTables,
  escapesBrain,
  EXPECTED_KIND,
  PROMPTS,
} from "../scripts/measure-show-block-server.ts";

function tables(...parts: string[]): number {
  return countMarkdownTables(...parts);
}

describe("the markdown-table matcher", () => {
  test("counts a table written with outer pipes", () => {
    expect(tables("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(1);
  });

  test("counts a table written without them, which GFM allows", () => {
    expect(tables("a | b\n--- | ---\n1 | 2")).toBe(1);
  });

  test("counts an alignment row", () => {
    expect(tables("| a | b |\n|:--|--:|\n| 1 | 2 |")).toBe(1);
  });

  test("counts each table in an answer that has two", () => {
    expect(tables("| a | b |\n| --- | --- |\n\n| c | d |\n| --- | --- |")).toBe(2);
  });

  test("counts a single-column table, whose delimiter row has no interior pipe", () => {
    expect(tables("| Step |\n| --- |\n| Build |")).toBe(1);
  });

  test("does not count prose, or a lone pipe line with no delimiter row", () => {
    expect(tables("no table here\njust prose")).toBe(0);
    expect(tables("a | b\nprose")).toBe(0);
  });

  test("does not count a table inside a fenced code block, which draws nothing", () => {
    expect(tables("```\n| a | b |\n| --- | --- |\n```")).toBe(0);
  });

  test("counts a table the reader saw in its own part, not the joined text", () => {
    // A tool call between the prose and the table makes them two parts.
    // Joined, the header row becomes the tail of a paragraph and the table
    // vanishes; the reader saw one.
    const prose = "Let me check.";
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(tables(prose, table)).toBe(1);
    expect(tables(prose + table)).toBe(0);
  });
});

describe("the brain-escape rule", () => {
  const brain = "/tmp/measure/brain";

  test("flags a home path outside the brain", () => {
    expect(escapesBrain([{ command: "ls /home/someone/brain" }], brain)).toBe(true);
  });

  test("flags a tilde path", () => {
    expect(escapesBrain([{ command: "cat ~/notes/today.md" }], brain)).toBe(true);
  });

  test("leaves a path inside the brain alone", () => {
    expect(escapesBrain([{ path: `${brain}/notes/a.md` }], brain)).toBe(false);
  });

  test("normalises the brain side, so a redundant segment is still the brain", () => {
    expect(escapesBrain([{ path: "/home/someone/brain/notes/a.md" }], "/home/someone/brain/.")).toBe(
      false
    );
  });

  test("resolves a relative brain against the working directory", () => {
    // Only bites when the working directory is itself under a home
    // directory, which is where the harness is usually run; the answer is
    // the same either way, so the assertion is unconditional.
    const relative = "fixtures/brain";
    expect(escapesBrain([{ path: `${resolve(relative)}/notes/a.md` }], relative)).toBe(false);
    expect(escapesBrain([{ path: "/home/someone/elsewhere/a.md" }], relative)).toBe(true);
  });

  test("leaves a brain that is itself under a home directory alone", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ path: `${home}/notes/a.md` }], home)).toBe(false);
    expect(escapesBrain([{ path: home }], home)).toBe(false);
    expect(escapesBrain([{ path: "/home/someone/other/a.md" }], home)).toBe(true);
  });

  test("a sibling that merely shares the brain's name prefix is outside it", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ path: "/home/someone/brain-backup/notes.md" }], home)).toBe(true);
  });

  test("a brain whose name carries a non-ASCII character is still itself", () => {
    const accented = "/home/someone/cerveau-privé";
    expect(escapesBrain([{ path: `${accented}/notes/a.md` }], accented)).toBe(false);
    expect(escapesBrain([{ path: "/home/someone/autre/a.md" }], accented)).toBe(true);
  });

  test("a sibling whose extra character is non-ASCII is still a sibling", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ path: "/home/someone/brainé/notes.md" }], home)).toBe(true);
    expect(escapesBrain([{ path: "/home/someone/brain2/notes.md" }], home)).toBe(true);
  });

  test("a brain path with whitespace is refused rather than judged", () => {
    // `<brain> copy/notes.md` and `find <brain> -type f` are the same string
    // with opposite answers, and the blob cannot tell them apart.
    expect(() => assertMeasurableBrainPath("/home/someone/brain copy")).toThrow(/whitespace/);
    expect(() => assertMeasurableBrainPath("/home/someone/brain")).not.toThrow();
  });

  test("a quoted traversal out of the brain is outside it", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `ls '${home}/..'` }], home)).toBe(true);
    expect(escapesBrain([{ command: `ls "${home}/../private"` }], home)).toBe(true);
  });

  test("the brain named as one argument of a shell command is not an escape", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `find ${home} -type f -name '*.md'` }], home)).toBe(false);
    expect(escapesBrain([{ command: `ls '${home}'` }], home)).toBe(false);
    expect(escapesBrain([{ command: `cd ${home} && git log` }], home)).toBe(false);
  });

  test("a traversal back out of the brain is outside it", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `cat ${home}/../private/notes.md` }], home)).toBe(true);
  });

  test("a traversal ended by a shell separator is still a traversal", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `cd ${home}/..; ls` }], home)).toBe(true);
    expect(escapesBrain([{ command: `cd ${home}/..&&ls` }], home)).toBe(true);
    expect(escapesBrain([{ command: `cat ${home}/..|head` }], home)).toBe(true);
    // The brain itself, ended the same way, is not.
    expect(escapesBrain([{ command: `cd ${home}; ls` }], home)).toBe(false);
  });

  test("flags a search from the filesystem root, which names no home path", () => {
    // What #137's two `trend` turns ran. A bare `/` is outside every brain.
    expect(
      escapesBrain([{ command: 'find / -maxdepth 3 -iname "*.git" -type d' }], brain)
    ).toBe(true);
    expect(escapesBrain([{ command: "ls /" }], brain)).toBe(true);
  });

  test("flags an absolute path outside /home", () => {
    expect(escapesBrain([{ command: "cat /etc/hostname" }], brain)).toBe(true);
    expect(escapesBrain([{ file_path: "/etc/hostname" }], brain)).toBe(true);
  });

  test("a brain under /tmp is judged by its own boundary, not by /home", () => {
    // Where #137 had to put the brain. Its siblings and its parent are
    // outside it; its own files are not.
    expect(escapesBrain([{ path: "/tmp/measure/other/a.md" }], brain)).toBe(true);
    expect(escapesBrain([{ command: "ls /tmp/measure" }], brain)).toBe(true);
    expect(escapesBrain([{ command: `grep -rn trend ${brain}/notes` }], brain)).toBe(false);
  });

  test("flags a path that starts a continuation line", () => {
    // Serialised as JSON, the newline is the two characters `\n`, so the
    // path would follow an `n` and not look like the start of one.
    expect(escapesBrain([{ command: "cat \\\n/etc/hostname" }], brain)).toBe(true);
  });

  test("flags a bare tilde, which is the home directory", () => {
    expect(escapesBrain([{ command: "cd ~ && ls" }], brain)).toBe(true);
    expect(escapesBrain([{ command: "cat ~root/.profile" }], brain)).toBe(true);
  });

  test("the device allowlist lets /dev/null, /dev/stdin, /dev/stdout and /dev/stderr through", () => {
    // DEVICE_PATHS: models redirect to these constantly, and none of them
    // reads anything outside the brain.
    expect(
      escapesBrain([{ command: `grep -rl trend ${brain} 2>/dev/null | head` }], brain)
    ).toBe(false);
    expect(escapesBrain([{ command: `cat ${brain}/a.md > /dev/stdout` }], brain)).toBe(false);
    expect(escapesBrain([{ command: `cat /dev/stdin; echo x >/dev/stderr` }], brain)).toBe(false);
    // The allowlist is exact: the rest of /dev is not on it.
    expect(escapesBrain([{ command: "ls /dev" }], brain)).toBe(true);
    expect(escapesBrain([{ command: "cat /dev/null/../../etc/passwd" }], brain)).toBe(true);
  });

  test("a slash inside a word, a URL or a relative path is not an absolute path", () => {
    expect(escapesBrain([{ command: `ls ${brain}/notes/2026/09` }], brain)).toBe(false);
    expect(escapesBrain([{ command: "cat notes/a.md" }], brain)).toBe(false);
    expect(escapesBrain([{ command: "curl https://example.com/a/b" }], brain)).toBe(false);
    expect(escapesBrain([{ command: "sed 's/and/or/' notes/a.md" }], brain)).toBe(false);
  });

  test("a traversal hidden behind punctuation in a path is still a traversal", () => {
    // The whole path is compared, so a comma, colon, bracket, brace or `=`
    // in a directory name cannot cut it short of its `..`.
    const home = "/home/someone/brain";
    for (const dir of ["a,b", "a:b", "a[1]", "a{1}", "a=b"]) {
      expect(escapesBrain([{ command: `cat "${home}/${dir}/../../private.md"` }], home)).toBe(true);
      expect(escapesBrain([{ command: `cat ${home}/${dir}/../../private.md` }], home)).toBe(true);
      expect(escapesBrain([{ path: `${home}/${dir}/../../private.md` }], home)).toBe(true);
    }
  });

  test("a brain whose name carries punctuation is still itself", () => {
    const punctuated = "/home/someone/brain(1)";
    expect(escapesBrain([{ path: `${punctuated}/notes/a.md` }], punctuated)).toBe(false);
    expect(escapesBrain([{ command: `ls "${punctuated}/notes"` }], punctuated)).toBe(false);
    expect(escapesBrain([{ command: `ls '${punctuated}'` }], punctuated)).toBe(false);
  });

  test("a regex with escaped slashes is not a path", () => {
    // Recorded in #137: a turn that stayed in the brain and was excluded
    // for this grep once a `/` could start a path anywhere.
    expect(
      escapesBrain(
        [{ command: "ls && echo --- && find . -maxdepth 2 -type d | grep -v '^\\.\\/\\.git' | head -50" }],
        brain
      )
    ).toBe(false);
  });

  test("a regex delimited by bare slashes counts as an escape, by design", () => {
    // The scan interprets no quoting, so it cannot tell an awk regex from a
    // path. It errs toward excluding the turn. The one recorded #137 turn
    // with this awk program also ran `find /`.
    expect(
      escapesBrain(
        [
          {
            command:
              "git log --diff-filter=A --name-only --pretty=format:'%ad' --date=format:'%Y-%m' -- '*.md' | awk 'NF{if($0 ~ /^[0-9]{4}-[0-9]{2}$/) d=$0; else print d}' | sort | uniq -c",
          },
        ],
        brain
      )
    ).toBe(true);
  });

  test("no quoting, comment or heredoc hides a path after it", () => {
    // Each of these read /etc/hostname and was missed by a rule that parsed
    // the shell's quoting.
    const leaks = [
      'echo "$(cat /etc/hostname)"',
      'echo "`cat /etc/hostname`"',
      "sh <<'EOF'\n# don't skip this read\ncat /etc/hostname\nEOF",
      "# don't skip this read\ncat /etc/hostname",
      "bash -lc 'cat /etc/hostname'",
      "echo 'cat /etc/hostname' | sh",
      "printf '%s\\n' 'cat /etc/hostname' | xargs -I CMD sh -c CMD",
    ];
    for (const command of leaks) expect(escapesBrain([{ command }], brain)).toBe(true);
  });

  test("a path after a redirection is its own path", () => {
    // With the brain at /usr, the command itself is inside it; what it reads
    // is not.
    expect(escapesBrain([{ command: "/usr/bin/cat</etc/hostname" }], "/usr")).toBe(true);
    expect(escapesBrain([{ command: `${brain}/script>/etc/x` }], brain)).toBe(true);
  });

  test("a path field is taken whole, whitespace included", () => {
    expect(escapesBrain([{ path: `${brain}/a b/../../private.md` }], brain)).toBe(true);
    expect(escapesBrain([{ file_path: `${brain}/a b/notes.md` }], brain)).toBe(false);
  });

  test("an attached short option's value is a path", () => {
    expect(escapesBrain([{ command: "env -C/etc cat hostname" }], brain)).toBe(true);
    expect(escapesBrain([{ command: "env -C /etc cat hostname" }], brain)).toBe(true);
    expect(escapesBrain([{ command: `env -C${brain} cat notes/a.md` }], brain)).toBe(false);
  });

  test("reads the script handed to sh -c", () => {
    expect(escapesBrain([{ command: "sh -c 'cat /etc/hostname'" }], brain)).toBe(true);
    expect(escapesBrain([{ command: `bash -c "ls / | head"` }], brain)).toBe(true);
    expect(escapesBrain([{ command: `sh -c 'ls ${brain}/notes'` }], brain)).toBe(false);
  });

  test("reads the value of a NAME= or --flag= word", () => {
    expect(escapesBrain([{ command: "grep -r x --exclude-from=/etc/hostname ." }], brain)).toBe(
      true
    );
    expect(escapesBrain([{ command: "HOME=/etc ls" }], brain)).toBe(true);
    expect(escapesBrain([{ command: `rg --glob='*.md' x ${brain}` }], brain)).toBe(false);
  });

  test("reads every argument, not only the first", () => {
    expect(
      escapesBrain([{ path: `${brain}/a.md` }, { command: "ls /home/someone" }], brain)
    ).toBe(true);
  });
});

describe("the brain-escape rule, replayed over #137's recorded turns", () => {
  // Every non-block tool call from the 64 Claude-backend turns #137
  // measured, from the CLI's own transcripts, with the brain's path replaced.
  // An audit of those transcripts found exactly two turns that left the
  // brain: both ran `find / -maxdepth 3 …` looking for git history.
  const recorded = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/show-block-137-tool-calls.json"), "utf8")
  ) as {
    brain: string;
    turns: { run: string; prompt: number; rep: number; calls: { input: unknown }[] }[];
  };

  test("flags exactly the two turns that searched from the root", () => {
    expect(recorded.turns).toHaveLength(64);
    const flagged = recorded.turns
      .filter((t) => escapesBrain(t.calls.map((c) => c.input), recorded.brain))
      .map((t) => `${t.run} prompt ${t.prompt} rep ${t.rep}`);
    expect(flagged).toEqual(["a-0-3 prompt 2 rep 4", "b-0-3 prompt 2 rep 3"]);
  });
});

describe("the expected kind per prompt", () => {
  test("has exactly one entry per prompt", () => {
    // Scoring indexes it by prompt index, so a prompt added without an entry
    // would score against another prompt's expectation.
    expect(EXPECTED_KIND).toHaveLength(PROMPTS.length);
  });

  test("names only kinds the brief itself names", () => {
    // The provenance claim — "taken clause by clause from the brief" — as a
    // test. A typo, or a kind renamed in the union, fails here rather than
    // silently scoring every turn wrong.
    const brief = SHOW_BLOCK_CONTRACT.brief("show_block");
    for (const kind of EXPECTED_KIND) {
      if (kind === null) continue;
      expect(brief).toContain(`\`${kind}\``);
    }
  });

  test("leaves a prompt unscored rather than inventing a right answer", () => {
    // At least one prompt the brief prescribes nothing single for, so the
    // null branch of the scoring is exercised by the real data.
    expect(EXPECTED_KIND).toContain(null);
  });
});
