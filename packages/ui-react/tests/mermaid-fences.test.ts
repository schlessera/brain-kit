import { describe, test, expect } from "bun:test";
import {
  findMermaidFences,
  inlineRenderedFences,
  replaceMermaidFences,
} from "../src/lib/mermaid";

const DIAGRAM = "graph TD\n  A --> B";

describe("findMermaidFences", () => {
  test("finds a closed mermaid fence", () => {
    const md = `before\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\nafter`;
    const fences = findMermaidFences(md);
    expect(fences).toHaveLength(1);
    expect(fences[0].source).toBe(DIAGRAM);
    expect(md.slice(fences[0].start, fences[0].end)).toBe("```mermaid\n" + DIAGRAM + "\n```\n");
  });

  test("accepts the mmd language alias and tilde fences", () => {
    const md = "```mmd\nA --> B\n```\n\n~~~mermaid\nB --> C\n~~~";
    const fences = findMermaidFences(md);
    expect(fences.map((f) => f.source)).toEqual(["A --> B", "B --> C"]);
  });

  test("ignores an unterminated (streaming) fence", () => {
    expect(findMermaidFences("text\n\n```mermaid\ngraph TD\n  A --")).toHaveLength(0);
  });

  test("ignores non-mermaid fences", () => {
    expect(findMermaidFences("```ts\nconst x = 1;\n```")).toHaveLength(0);
  });

  test("ignores a mermaid fence nested inside another code block", () => {
    const md = "````md\n```mermaid\ngraph TD\n```\n````";
    expect(findMermaidFences(md)).toHaveLength(0);
  });

  test("a longer closing run closes a shorter opening fence, not vice versa", () => {
    // ```` opened; ``` inside does not close it
    const md = "````mermaid\ngraph TD\n```\nstill inside\n````";
    const fences = findMermaidFences(md);
    expect(fences).toHaveLength(1);
    expect(fences[0].source).toBe("graph TD\n```\nstill inside");
  });

  test("handles an empty diagram body and a fence at EOF without trailing newline", () => {
    expect(findMermaidFences("```mermaid\n```")[0]?.source).toBe("");
    const md = "```mermaid\nA --> B\n```";
    const fences = findMermaidFences(md);
    expect(fences).toHaveLength(1);
    expect(fences[0].end).toBe(md.length);
  });

  test("allows up to three spaces of indentation", () => {
    expect(findMermaidFences("   ```mermaid\nA --> B\n   ```")).toHaveLength(1);
    expect(findMermaidFences("    ```mermaid\nA --> B\n    ```")).toHaveLength(0);
  });
});

describe("replaceMermaidFences", () => {
  test("replaces closed fences and preserves surrounding text", () => {
    const md = `intro\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\noutro`;
    const out = replaceMermaidFences(md, (f) => `<svg>${f.source.length}</svg>\n`);
    expect(out).toBe(`intro\n\n<svg>${DIAGRAM.length}</svg>\noutro`);
  });

  test("keeps a fence when the replacement returns null", () => {
    const md = "```mermaid\nbroken\n```";
    expect(replaceMermaidFences(md, () => null)).toBe(md);
  });

  test("replaces multiple fences independently", () => {
    const md = "```mermaid\nA\n```\n\nmiddle\n\n```mermaid\nB\n```";
    const out = replaceMermaidFences(md, (_f, i) => (i === 0 ? "[first]\n" : null));
    expect(out).toBe("[first]\n\nmiddle\n\n```mermaid\nB\n```");
  });
});

describe("inlineRenderedFences", () => {
  test("preserves a list-nested fence's indentation", () => {
    const md = "- item\n  ```mermaid\n  A --> B\n  ```\n- next";
    const out = inlineRenderedFences(md, ["<svg/>"]);
    expect(out).toContain('\n  <div class="mermaid-figure"><svg/></div>\n');
    expect(out).toContain("- next");
  });

  test("collapses SVG newlines to a single line", () => {
    const md = "```mermaid\nA\n```";
    const out = inlineRenderedFences(md, ["<svg>\n<g>\r\n</g>\n</svg>"]);
    expect(out).toContain('<div class="mermaid-figure"><svg> <g> </g> </svg></div>');
  });

  test("leaves a fence as source when inlining would cross the size budget", () => {
    const md = "```mermaid\nA\n```\n\n```mermaid\nB\n```";
    const bigSvg = `<svg>${"x".repeat(200)}</svg>`;
    const out = inlineRenderedFences(md, [bigSvg, bigSvg], md.length + 250);
    // Only one of the two fits under the budget; the other stays a fence.
    expect(out.split("mermaid-figure").length - 1).toBe(1);
    expect(out).toContain("```mermaid");
  });

  test("null renders (invalid/unrendered) keep their fences", () => {
    const md = "```mermaid\nbroken\n```";
    expect(inlineRenderedFences(md, [null])).toBe(md);
  });
});
