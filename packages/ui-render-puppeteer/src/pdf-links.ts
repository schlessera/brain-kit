/** Check the bytes Chrome actually printed, including page-size clipping. */
import { classifyLink, classifyMailto } from "@schlessera/brain-render-template/links";
import type { StructTreeNode, StructTreeContent, TextItem } from "pdfjs-dist/types/src/display/api.js";

type Node = StructTreeNode | StructTreeContent;
function* descendants(node: Node): Generator<Node> {
  yield node;
  if ("children" in node) for (const child of node.children) yield* descendants(child);
}
const failure = () => new Error("PDF link destination is missing, clipped or too small to read");

export async function assertPdfLinkDestinations(bytes: Buffer, checkActive: () => void): Promise<void> {
  // This optional renderer owns the parser. The pure classifier and normal
  // CLI/template imports do not load it. No URI target is fetched or executed.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  checkActive();
  const loading = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, disableFontFace: true });
  try {
    const pdf = await loading.promise; checkActive();
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number); checkActive();
      const annotations = (await page.getAnnotations()).filter((a) => a.subtype === "Link" && (a.unsafeUrl || a.url));
      checkActive();
      if (!annotations.length) continue;
      const structure = await page.getStructTree(); checkActive();
      if (!structure) throw failure();
      const text = await page.getTextContent({ includeMarkedContent: true }); checkActive();
      const marked = new Map<string, TextItem[]>();
      const stack: (string | null)[] = [];
      for (const item of text.items) {
        if ("str" in item) {
          for (const id of stack) if (id) { const items = marked.get(id) ?? []; items.push(item); marked.set(id, items); }
        } else if (item.type === "endMarkedContent") stack.pop();
        else stack.push(item.id ?? null);
      }
      const accounted = new Set<string>();
      for (const node of descendants(structure)) {
        if (!("role" in node) || node.role !== "Link") continue;
        const refs = node.children.filter((n): n is StructTreeContent => "type" in n && n.type === "annotation");
        const actual = annotations.filter((a) => refs.some((r) => r.id === `pdfjs_internal_id_${a.id}`));
        if (!actual.length) continue;
        const target = actual[0].unsafeUrl || actual[0].url;
        if (actual.some((a) => (a.unsafeUrl || a.url) !== target)) throw failure();
        const verdict = /^mailto:/i.test(target) ? classifyMailto(target) : classifyLink(target);
        if (!verdict.ok) throw failure();
        const destination = "display" in verdict ? verdict.display : verdict.host;
        // Older Chrome maps HTML code to NonStruct; newer Chrome emits Code.
        // Author words are wrapped in P in both. Never accept their text as
        // the disclosure when printing has removed the final owned child.
        const children = node.children.filter((n): n is StructTreeNode => "role" in n);
        const last = children.at(-1);
        if (!last || !["Code", "NonStruct"].includes(last.role) || children.slice(0, -1).some((n) => n.role !== "P")) throw failure();
        const ids = new Set([...descendants(last)].filter((n): n is StructTreeContent => "type" in n && n.type === "content").map((n) => n.id));
        const items = [...ids].flatMap((id) => marked.get(id) ?? []).filter((i) => i.str.trim());
        if (!items.map((i) => i.str).join("").replace(/\s/g, "").includes(destination)) throw new Error("PDF link destination is incomplete");
        const [left, bottom, right, top] = page.view;
        for (const item of items) {
          const [a, b, c, d, x, y] = item.transform;
          // Owned horizontal monospace must survive print scaling at the
          // 12 CSS-pixel floor (9 PDF points), and stay on the physical page.
          if (Math.abs(b) > .01 || Math.abs(c) > .01 || a < 8.99 || d < 8.99 || item.height < 8.99
            || x < left - .5 || x + item.width > right + .5 || y - item.height * .25 < bottom - .5 || y + item.height * .8 > top + .5) throw failure();
        }
        for (const annotation of actual) accounted.add(annotation.id);
      }
      if (annotations.some((a) => !accounted.has(a.id))) throw failure();
    }
  } finally { await loading.destroy(); }
}
