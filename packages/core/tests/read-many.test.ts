/**
 * The bounded multi-read operation (#3642) behind `brain_read_many` and
 * `brain read-many`: caps, item kinds, paging, versions, duplicates,
 * containment, input refusal, work limits and cancellation. The contract is
 * docs/decisions/bounded-multi-read.md; the surfaces have their own tests
 * (mcp-contract, cli-read-many, the pi brain-read-many tests).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { readDocument } from "../src/lib/ops/read";
import {
  READ_MANY_MAX_CALL_BYTES,
  READ_MANY_MAX_FILE_BYTES,
  READ_MANY_MAX_REQUESTS,
  readMany,
  ReadManyRequestError,
  type ReadManyIo,
  type ReadManyItem,
  type ReadManyRequest,
  type ReadManyResult,
} from "../src/lib/ops/read-many";
import { cleanup, makeTempBrain } from "./cli-harness";

const DATE = "2026-07-12";
let root: string;
let outside: string;

const note = (title: string, body: string, extra = "") => `---\ntype: note\ntitle: "${title}"\nupdated: ${DATE}\n${extra}---\n\n${body}`;
const DOCS: Record<string, string> = {
  "notes/crew-ledger.md": note(
    "Crew ledger",
    "## Count\n\nSix hundred men left Troy in twelve ships.\n\n## Losses\n\nRecorded in the frontmatter.\n",
    "crew:\n" + Array.from({ length: 600 }, (_, i) => `  - "Oarsman ${i + 1}"`).join("\n") + "\n"
  ),
  "journal/passage-log.md": note(
    "Passage log",
    "# Passage log\n\n" + Array.from({ length: 240 }, (_, i) => `## Day ${i + 1}\n\nThe raft holds on day ${i + 1}.\n`).join("\n")
  ),
  "studies/raw-bearings.md": note("Raw bearings", Array.from({ length: 1200 }, (_, i) => `Pleiades ${i % 90} deg, the Bear on the left;`).join(" ") + "\n"),
  "notes/names.md": note(
    "Names",
    "## Names\n\n" +
      Array.from({ length: 60 }, (_, i) => `${i}. Ὀδυσσεύς 奥德修斯 \u{1F6F6}\u{1F6F6} "polytropos" \\ path\\to\\raft\tcol`).join("\n") +
      "\n\n## Epithets\n\n\"much-enduring\"\n"
  ),
  "notes/raft.md": note("Raft", "## Build\n\nTimber from Calypso's grove.\n\n### Day 1\n\nCut.\n\n### Day 2\n\nJoined.\n\n## Launch\n\nSeventeen days to Scheria.\n"),
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`notes/stop-${i}.md`, note(`Stop ${i}`, `## Stop ${i}\n\n${"The crew rows past the headland. ".repeat(42)}\n`)])),
};

const read = (input: unknown, opts?: Parameters<typeof readMany>[2]) => readMany(root, input, opts);
const kinds = (r: ReadManyResult) => r.items.map((i) => (i.kind === "error" ? `error:${i.code}` : i.kind));
const len = (v: unknown) => JSON.stringify(v).length;

beforeAll(() => {
  root = makeTempBrain();
  for (const [path, text] of Object.entries(DOCS)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  outside = `${root}-outside.md`;
  writeFileSync(outside, "Polyphemus keeps this cave closed.\n");
  symlinkSync(outside, join(root, "notes/escape-link.md"));
  symlinkSync(join(root, "notes/raft.md"), join(root, "notes/raft-alias.md"));
});

afterAll(() => {
  cleanup(root);
  rmSync(outside, { force: true });
});

const SCENARIOS: Record<string, ReadManyRequest[]> = {
  small: [{ path: "me/identity.md" }, { path: "notes/raft.md" }],
  frontmatter: [{ path: "notes/crew-ledger.md" }],
  headings: [{ path: "journal/passage-log.md" }],
  hugeLine: [{ path: "studies/raw-bearings.md" }],
  mixed: [{ path: "notes/names.md" }],
  sections: [{ path: "notes/raft.md", section: "build" }, { path: "journal/passage-log.md", section: "Day 17" }],
  refused: [{ path: "missing.md" }, { path: "../x.md" }, { path: "/etc/hosts" }, { path: "notes/escape-link.md" }, { path: "notes" }, { path: "me/identity.md", section: "No such" }],
  duplicates: [{ path: "notes/raft.md" }, { path: "./notes/raft.md" }, { path: "notes/raft-alias.md" }, { path: "notes/raft.md", section: "BUILD" }, { path: "notes/raft.md", section: "build" }],
  overflow: Array.from({ length: 20 }, (_, i) => ({ path: `notes/stop-${i}.md` })),
};

describe("caps", () => {
  test("every scenario keeps the whole result and each item within the caps, at the default and the smallest caps", async () => {
    for (const [id, requests] of Object.entries(SCENARIOS)) {
      for (const caps of [{}, { max_total_chars: 2_000, max_item_chars: 512 }, { max_total_chars: 40_000, max_item_chars: 40_000 }]) {
        let result: ReadManyResult;
        try {
          result = await read({ requests, ...caps });
        } catch (e) {
          // Twenty stubs do not fit 2,000 chars: refused whole, never clamped.
          expect(e, `${id} ${JSON.stringify(caps)}`).toBeInstanceOf(ReadManyRequestError);
          expect(id).toBe("overflow");
          continue;
        }
        expect(len(result), `TOTAL_CAP ${id}`).toBeLessThanOrEqual(result.max_total_chars);
        for (const item of result.items) expect(len(item), `ITEM_CAP ${id}`).toBeLessThanOrEqual(result.max_item_chars);
        expect(result.items.map((i) => i.index), `ORDER ${id}`).toEqual(requests.map((_, i) => i));
      }
    }
  });

  test("the default caps are 24,000 total and 8,000 per item; a smaller total lowers the item default", async () => {
    const r = await read({ requests: [{ path: "me/identity.md" }] });
    expect([r.max_total_chars, r.max_item_chars]).toEqual([24_000, 8_000]);
    const small = await read({ requests: [{ path: "me/identity.md" }], max_total_chars: 5_000 });
    expect([small.max_total_chars, small.max_item_chars]).toEqual([5_000, 5_000]);
  });

  test("twenty notes overflow the default total: order holds, later ones shrink to outlines, the last to a stub", async () => {
    const r = await read({ requests: SCENARIOS.overflow });
    expect(len(r)).toBeLessThanOrEqual(24_000);
    const k = kinds(r);
    expect(k[0]).toBe("full");
    expect(k.at(-1)).toBe("error:budget_exhausted");
    expect(k).toContain("outline");
    expect(k.indexOf("outline")).toBeGreaterThan(k.lastIndexOf("full") - 1);
    expect(r.truncated).toBe(true);
  });

  test("at a tight total, items larger than their reserved stub become stubs and the cap still holds", async () => {
    // Refusals carry a longer message than the budget_exhausted stub each item reserves.
    const requests = Array.from({ length: READ_MANY_MAX_REQUESTS }, (_, i) => ({ path: `../ithaca/${"suitor-".repeat(8)}${i}.md` }));
    let total = 2_000;
    for (; total <= 10_000; total += 10) {
      try {
        await read({ requests, max_total_chars: total, max_item_chars: 512 });
        break;
      } catch (e) {
        expect(e).toBeInstanceOf(ReadManyRequestError);
      }
    }
    const smallest = await read({ requests, max_total_chars: total, max_item_chars: 512 });
    expect(len(smallest), "TIGHT_TOTAL_CAP").toBeLessThanOrEqual(total);
    expect(new Set(kinds(smallest))).toEqual(new Set(["error:budget_exhausted"]));
    const mixed = await read({ requests, max_total_chars: total + 200, max_item_chars: 512 });
    expect(len(mixed), "TIGHT_TOTAL_CAP").toBeLessThanOrEqual(total + 200);
    expect(kinds(mixed)[0]).toBe("error:refused");
    expect(kinds(mixed).at(-1)).toBe("error:budget_exhausted");
  });

  test("a request whose stub cannot fit max_item_chars refuses the whole call", async () => {
    await expect(read({ requests: [{ path: "\u0001".repeat(200) }], max_item_chars: 512 })).rejects.toBeInstanceOf(ReadManyRequestError);
  });
});

describe("item kinds", () => {
  test("full items are byte for byte what brain_read returns, sections included", async () => {
    const requests = [...SCENARIOS.small, ...SCENARIOS.sections, ...SCENARIOS.mixed];
    const r = await read({ requests, max_total_chars: 40_000, max_item_chars: 40_000 });
    for (const [i, req] of requests.entries()) {
      const item = r.items[i]!;
      expect(item.kind, req.path).toBe("full");
      if (item.kind === "full") expect(item.content, `SAME_AS_BRAIN_READ ${req.path}`).toBe(readDocument(root, { path: req.path, section: req.section }));
      expect(Object.keys(item)).not.toContain("bytes");
    }
    expect(r.truncated).toBe(false);
  });

  test("discriminators at the default caps", async () => {
    const expected: Record<string, string[]> = {
      small: ["full", "full"],
      frontmatter: ["outline"],
      headings: ["outline"],
      hugeLine: ["partial"],
      mixed: ["full"],
      sections: ["full", "full"],
      refused: ["error:not_found", "error:refused", "error:refused", "error:refused", "error:not_a_file", "error:section_not_found"],
      duplicates: ["full", "duplicate", "duplicate", "full", "duplicate"],
    };
    for (const [id, want] of Object.entries(expected)) expect([id, kinds(await read({ requests: SCENARIOS[id] }))]).toEqual([id, want]);
  });

  test("a large frontmatter is counted, not returned, when it does not fit; the headings still are", async () => {
    const [item] = (await read({ requests: SCENARIOS.frontmatter })).items;
    if (item!.kind !== "outline") throw new Error(`expected an outline, got ${item!.kind}`);
    expect(item.frontmatter).toBeUndefined();
    expect(item.frontmatter_chars).toBeGreaterThan(8_000);
    expect(item.headings.map((h) => h.text)).toEqual(["Count", "Losses"]);
    expect(item.next).toEqual({ offset: 1 });
  });

  test("an outline over many headings lists a prefix and counts the rest", async () => {
    const [item] = (await read({ requests: SCENARIOS.headings })).items;
    if (item!.kind !== "outline") throw new Error("expected an outline");
    expect(item.frontmatter).toStartWith("---\n");
    expect(item.headings[0]).toEqual({ level: 1, text: "Passage log", est_tokens: expect.any(Number) });
    expect(item.headings.length + (item.omitted_headings ?? 0)).toBe(241);
    expect(item.omitted_headings).toBeGreaterThan(0);
  });

  test("a section with subheadings outlines them; one without pages", async () => {
    const r = await read({ requests: [{ path: "notes/raft.md", section: "Build" }, { path: "notes/raft.md", section: "Launch" }], max_total_chars: 2_000, max_item_chars: 512 });
    // Both fit whole at 512: shrink with long sections instead.
    expect(kinds(r)).toEqual(["full", "full"]);
    const day = await read({ requests: [{ path: "journal/passage-log.md", section: "Passage log" }], max_total_chars: 2_000, max_item_chars: 600 });
    expect(day.items[0]!.kind).toBe("outline");
    const line = await read({ requests: [{ path: "notes/stop-1.md", section: "Stop 1" }], max_total_chars: 2_000, max_item_chars: 600 });
    expect(line.items[0]!.kind).toBe("partial");
  });

  test("an unknown section names as many headings as fit", async () => {
    const r = await read({ requests: [{ path: "journal/passage-log.md", section: "Day 999" }], max_total_chars: 2_000, max_item_chars: 600 });
    const item = r.items[0]!;
    if (item.kind !== "error") throw new Error("expected an error");
    expect(item.code).toBe("section_not_found");
    expect(item.headings!.length).toBeGreaterThan(0);
    expect(item.headings!.length).toBeLessThan(241);
    expect(item.message).toContain("of the document's 241 headings");
    expect(len(item)).toBeLessThanOrEqual(600);
  });

  test("an unavailable member does not discard the successful reads around it", async () => {
    const r = await read({ requests: [{ path: "me/identity.md" }, { path: "../escape.md" }, { path: "notes/raft.md" }] });
    expect(kinds(r)).toEqual(["full", "error:refused", "full"]);
  });

  test("two calls over the same files answer byte for byte the same", async () => {
    const input = { requests: [...SCENARIOS.overflow.slice(0, 6), ...SCENARIOS.refused, ...SCENARIOS.duplicates] };
    expect(JSON.stringify(await read(input))).toBe(JSON.stringify(await read(input)));
  });
});

describe("paging", () => {
  async function pages(req: ReadManyRequest, caps = { max_total_chars: 2_100, max_item_chars: 2_000 }) {
    let next: ReadManyRequest = { ...req, offset: req.offset ?? 1 };
    let text = "";
    for (let calls = 1; ; calls++) {
      const r = await read({ requests: [next], ...caps });
      expect(len(r)).toBeLessThanOrEqual(caps.max_total_chars);
      const item = r.items[0]!;
      if (item.kind !== "partial") throw new Error(`expected a page, got ${JSON.stringify(item).slice(0, 200)}`);
      expect(calls, `CONTINUATION_ADVANCES ${req.path}`).toBeLessThan(400);
      text += item.text;
      if (!item.next) return { text, calls };
      next = { ...req, offset: item.next.offset, ...(item.next.column !== undefined ? { column: item.next.column } : {}), expected_sha256: item.sha256 };
    }
  }

  test("joining every page reproduces a huge line, mixed scripts and a long log exactly", async () => {
    for (const path of ["studies/raw-bearings.md", "notes/names.md", "journal/passage-log.md"]) {
      const { text, calls } = await pages({ path });
      expect(text, `CONTINUATION_EXACT ${path}`).toBe(readFileSync(join(root, path), "utf8"));
      expect(calls).toBeGreaterThan(1);
    }
  });

  test("pages of a section reproduce the section, and the smallest caps still advance", async () => {
    const want = readDocument(root, { path: "notes/names.md", section: "Names" });
    expect((await pages({ path: "notes/names.md", section: "Names" })).text).toBe(want);
    expect((await pages({ path: "notes/names.md", section: "Names" }, { max_total_chars: 2_000, max_item_chars: 512 })).text).toBe(want);
  });

  test("a page never splits a surrogate pair, and a column that would is refused", async () => {
    const path = "notes/names.md";
    const doc = readFileSync(join(root, path), "utf8");
    let req: ReadManyRequest = { path, offset: 1 };
    for (;;) {
      const item = (await read({ requests: [req], max_total_chars: 2_000, max_item_chars: 512 })).items[0]!;
      if (item.kind !== "partial") throw new Error(item.kind);
      const last = item.text.charCodeAt(item.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      if (!item.next) break;
      req = { path, offset: item.next.offset, ...(item.next.column !== undefined ? { column: item.next.column } : {}) };
    }
    const lineNo = doc.split("\n").findIndex((l) => l.includes("\u{1F6F6}")) + 1;
    const column = doc.split("\n")[lineNo - 1]!.indexOf("\u{1F6F6}") + 1;
    const bad = (await read({ requests: [{ path, offset: lineNo, column }] })).items[0]!;
    expect(bad).toMatchObject({ kind: "error", code: "bad_offset" });
  });

  test("an offset past the end, or a column past its line, is bad_offset", async () => {
    const r = await read({ requests: [{ path: "notes/raft.md", offset: 9_999 }, { path: "notes/raft.md", offset: 1, column: 9_999 }] });
    expect(kinds(r)).toEqual(["error:bad_offset", "error:bad_offset"]);
  });
});

describe("versions and duplicates", () => {
  test("a follow-up with expected_sha256 reports source_changed instead of a newer file", async () => {
    const path = "notes/raft.md";
    const first = (await read({ requests: [{ path }] })).items[0]!;
    if (first.kind !== "full") throw new Error("expected full");
    const original = readFileSync(join(root, path), "utf8");
    writeFileSync(join(root, path), original + `\n## ${DATE} Landing\n\nScheria.\n`);
    try {
      const stale = (await read({ requests: [{ path, section: "Launch", expected_sha256: first.sha256 }] })).items[0]!;
      expect(stale, "SOURCE_CHANGED").toMatchObject({ kind: "error", code: "source_changed" });
      if (stale.kind === "error") expect(stale.sha256).not.toBe(first.sha256);
      const same = (await read({ requests: [{ path, section: "Launch" }] })).items[0]!;
      expect(same.kind).toBe("full");
    } finally {
      writeFileSync(join(root, path), original);
    }
    const again = (await read({ requests: [{ path, section: "Launch", expected_sha256: first.sha256 }] })).items[0]!;
    expect(again.kind).toBe("full");
  });

  test("sha256 is the SHA-256 of the file's bytes, shared by every item of one file", async () => {
    const r = await read({ requests: [{ path: "notes/raft.md" }, { path: "notes/raft.md", section: "Launch" }] });
    const hash = new Bun.CryptoHasher("sha256").update(readFileSync(join(root, "notes/raft.md"))).digest("hex");
    expect(r.items.map((i) => ("sha256" in i ? i.sha256 : null))).toEqual([hash, hash]);
  });

  test("duplicates point at the first equal request, through spelling, case and links, and each file is read once", async () => {
    const work = { filesRead: 0, bytesRead: 0 };
    const r = await read({ requests: SCENARIOS.duplicates }, { work });
    expect(r.items[1], "DUPLICATE_FOLDED").toMatchObject({ kind: "duplicate", of: 0 });
    expect(r.items[2]).toMatchObject({ kind: "duplicate", of: 0 });
    expect(r.items[4]).toMatchObject({ kind: "duplicate", of: 3 });
    expect(work.filesRead, "ONE_READ_PER_FILE").toBe(1);
  });
});

describe("authority", () => {
  test("traversal, absolute paths and links out of the root are refused; no item carries a host path", async () => {
    const r = await read({ requests: SCENARIOS.refused });
    expect(kinds(r).slice(1, 4), "CONTAINMENT").toEqual(["error:refused", "error:refused", "error:refused"]);
    const text = JSON.stringify(r);
    expect(text).not.toContain(root);
    expect(text).not.toContain("Polyphemus");
    const unknown = r.items.at(-1)!;
    if (unknown.kind === "error") expect(unknown.headings).toEqual(["Current Identity", "How to Work With Odysseus", "Reaching Odysseus"]);
  });

  test("an injected resolver is the only one used", async () => {
    const seen: string[] = [];
    const r = await read({ requests: [{ path: "me/identity.md" }, { path: "notes/raft.md" }] }, { resolve: (p) => (seen.push(p), p === "notes/raft.md" ? null : join(root, p)) });
    expect(seen).toEqual(["me/identity.md", "notes/raft.md"]);
    expect(kinds(r)).toEqual(["full", "error:refused"]);
  });
});

describe("input and work limits", () => {
  test("invalid calls are refused whole, never clamped, and read nothing", async () => {
    const one = { path: "me/identity.md" };
    let reads = 0;
    const io: ReadManyIo = { stat: async (p) => { reads++; return (await import("fs/promises")).stat(p); }, readFile: async (p) => { reads++; return (await import("fs/promises")).readFile(p); } };
    for (const input of [
      undefined,
      {},
      { requests: [] },
      { requests: Array.from({ length: READ_MANY_MAX_REQUESTS + 1 }, () => one) },
      { requests: [one], max_total_chars: 40_001 },
      { requests: [one], max_total_chars: 1_999 },
      { requests: [one], max_total_chars: 2_000.5 },
      { requests: [one], max_item_chars: 511 },
      { requests: [one], max_total_chars: 2_000, max_item_chars: 2_001 },
      { requests: [{ path: "me/identity.md", column: 3 }] },
      { requests: [{ path: "me/identity.md", offset: 0 }] },
      { requests: [{ path: "me/identity.md", expected_sha256: "abc" }] },
      { requests: [{ path: "x".repeat(1_025) }] },
      { requests: [{ path: "" }] },
      { requests: [{ path: "me/identity.md", section: "s".repeat(513) }] },
      { requests: [{ path: "me/identity.md", extra: true }] },
      { requests: [one], unknown: 1 },
    ]) await expect(read(input, { io }), JSON.stringify(input)?.slice(0, 80)).rejects.toBeInstanceOf(ReadManyRequestError);
    expect(reads).toBe(0);
  });

  const fakeIo = (sizes: Record<string, number>, grow: Record<string, number> = {}): ReadManyIo & { reads: string[] } => {
    const reads: string[] = [];
    return {
      reads,
      stat: async (p) => ({ isFile: () => true, size: sizes[p.split("/").pop()!] ?? 10 }),
      readFile: async (p) => {
        const name = p.split("/").pop()!;
        reads.push(name);
        return Buffer.alloc(grow[name] ?? sizes[name] ?? 10, "a");
      },
    };
  };
  const resolve = (p: string) => `/odysseus/${p}`;

  test("a file over 4 MiB is too_large, also when it grows between stat and read", async () => {
    const io = fakeIo({ "big.md": READ_MANY_MAX_FILE_BYTES + 1, "grows.md": 100 }, { "grows.md": READ_MANY_MAX_FILE_BYTES + 1 });
    const r = await read({ requests: [{ path: "big.md" }, { path: "grows.md" }, { path: "small.md" }] }, { io, resolve });
    expect(kinds(r), "FILE_LIMIT").toEqual(["error:too_large", "error:too_large", "full"]);
    expect(io.reads).toEqual(["grows.md", "small.md"]);
  });

  test("a call stops reading at 16 MiB of distinct files; later files are work_limit items", async () => {
    const each = READ_MANY_MAX_FILE_BYTES - 1;
    const sizes = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`part-${i}.md`, each]));
    const io = fakeIo(sizes);
    const r = await read({ requests: Object.keys(sizes).map((path) => ({ path })) }, { io, resolve });
    const allowed = Math.floor(READ_MANY_MAX_CALL_BYTES / each);
    expect(io.reads.length, "CALL_LIMIT").toBe(allowed);
    expect(kinds(r).slice(allowed)).toEqual(Array(6 - allowed).fill("error:work_limit"));
  });

  test("cancellation stops between files and returns nothing partial", async () => {
    const controller = new AbortController();
    const work = { filesRead: 0, bytesRead: 0 };
    const io: ReadManyIo = {
      stat: (p) => import("fs/promises").then((fs) => fs.stat(p)),
      readFile: async (p) => {
        const data = await (await import("fs/promises")).readFile(p);
        controller.abort(new Error("Odysseus cancelled the read"));
        return data;
      },
    };
    await expect(read({ requests: SCENARIOS.overflow }, { signal: controller.signal, work, io })).rejects.toThrow("Odysseus cancelled the read");
    expect(work.filesRead, "CANCELLED_BETWEEN_FILES").toBe(1);
    const already = new AbortController();
    already.abort(new Error("before"));
    await expect(read({ requests: SCENARIOS.small }, { signal: already.signal })).rejects.toThrow("before");
  });
});

describe("warnings", () => {
  test("tool warnings ride once in the envelope and count against the total", async () => {
    const warnings = ["index is stale (1 file(s) newer than index); run `brain index`"];
    const r = await read({ requests: SCENARIOS.overflow }, { warnings });
    expect(r.warnings).toEqual(warnings);
    expect(len(r)).toBeLessThanOrEqual(r.max_total_chars);
  });
});

// Keep the item union exercised by the type checker as the surfaces see it.
export type _Items = ReadManyItem;
