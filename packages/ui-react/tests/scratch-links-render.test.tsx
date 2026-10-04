import { afterAll, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

import { BrainMarkdown } from "../src/components/chat/brain-markdown.js";
import { DirLink, FileLink, linkifyPaths, renderBarePathsInText } from "../src/components/chat/brain-markdown-links.js";
import { BrainUiProvider } from "../src/root-context.js";
import { createBrainUiRoot } from "../src/root.js";

const scratch = ".brain/scratch/raft/overview.pdf";
const root = createBrainUiRoot({ storage: null });
const parser = new Window().DOMParser;
afterAll(() => root.dispose());

function links(text: string) {
  return renderBarePathsInText(text).flatMap((node) => {
    if (!React.isValidElement<{ path: string; children: string }>(node)) return [];
    return [{ kind: node.type === FileLink ? "file" : node.type === DirLink ? "dir" : "wiki",
      path: node.props.path, text: node.props.children }];
  });
}

describe("the actual bare-path scanner", () => {
  test("a scratch file keeps its leading dot", () => {
    expect(links(`Preview: ${scratch}`)).toEqual([{ kind: "file", path: scratch, text: scratch }]);
  });

  test("a scratch directory keeps its leading dot", () => {
    expect(links("Look in .brain/scratch/raft/ next.")).toEqual([
      { kind: "dir", path: ".brain/scratch/raft", text: ".brain/scratch/raft/" },
    ]);
  });

  for (const path of ["notes/raft.md", ".brain/scratch/raft.pdf", ".brain/scratch/raft.PNG", ".brain/scratch/raft-2026-07-12.pdf"]) {
    for (const prefix of ["", "./"]) {
      test(`whole file token ${prefix}${path}`, () => {
        expect(links(`Before (${prefix}${path}), after.`)).toEqual([
          { kind: "file", path, text: prefix + path },
        ]);
      });
    }
  }

  test("dot-relative directories retain their written text and normalized target", () => {
    expect(links("./notes/raft/ and ./.brain/scratch/raft/")).toEqual([
      { kind: "dir", path: "notes/raft", text: "./notes/raft/" },
      { kind: "dir", path: ".brain/scratch/raft", text: "./.brain/scratch/raft/" },
    ]);
  });

  for (const token of ["../raft.pdf", "../notes/raft.pdf", "../notes/raft/", "../../notes/raft.pdf",
    "/notes/raft.pdf", "/.brain/scratch/raft.pdf", "end.Next/thing.md", "end.Next/thing/",
    "word..brain/scratch/raft.pdf", "-notes/raft.pdf", "https://ithaca.example/notes/raft.pdf",
    "https://ithaca.example/notes/raft/", "README.md", "1.2.3", "notes/"]) {
    test(`does not salvage a suffix from ${token}`, () => {
      expect(links(token)).toEqual([]);
    });
  }

  test("multiple mixed paths retain every surrounding character", () => {
    const text = `Read ${scratch}, then ./notes/raft.md and .brain/scratch/raft/.`;
    const nodes = renderBarePathsInText(text);
    expect(nodes.map((node) => typeof node === "string" ? node : (node as React.ReactElement<{ children: string }>).props.children).join("")).toBe(text);
    expect(links(text).map((link) => link.path)).toEqual([scratch, "notes/raft.md"]);
    // The directory's established punctuation rule excludes a following dot.
    expect(links(".brain/scratch/raft/ ")).toHaveLength(1);
  });
});

describe("actual chat markdown and plain-text linkification", () => {
  for (const [label, text] of [["bare prose", `Preview: ${scratch}`], ["inline code", `Preview: \`${scratch}\``],
    ["explicit markdown", `[Preview](${scratch})`]] as const) {
    test(`${label} targets the complete scratch path`, () => {
      const markup = renderToStaticMarkup(<BrainUiProvider root={root}><BrainMarkdown content={text} fileLinks /></BrainUiProvider>);
      const doc = new parser().parseFromString(markup, "text/html");
      const found = [...doc.querySelectorAll("a.brain-file-link")];
      expect(found).toHaveLength(1);
      expect(found[0]!.getAttribute("href")).toBe(`#/files/${scratch}`);
      expect(found[0]!.textContent).toBe(label === "explicit markdown" ? "Preview" : scratch);
    });
  }

  test("the plain-text helper uses the same preserved scratch target", () => {
    const markup = renderToStaticMarkup(<BrainUiProvider root={root}>{linkifyPaths(scratch)}</BrainUiProvider>);
    expect(new parser().parseFromString(markup, "text/html").querySelector("a")?.getAttribute("href")).toBe(`#/files/${scratch}`);
  });

  test("a withheld prose link never re-linkifies its scratch text", () => {
    const markup = renderToStaticMarkup(<BrainUiProvider root={root}><BrainMarkdown content={`[\`${scratch}\`](xmpp:odysseus@ithaca.example)`} fileLinks /></BrainUiProvider>);
    expect(new parser().parseFromString(markup, "text/html").querySelectorAll("a")).toHaveLength(0);
  });
});
