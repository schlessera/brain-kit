/**
 * The anchors a markdown file exposes to a `#fragment` link, as GitHub renders
 * them.
 *
 * tests/docs-paths.test.ts uses this to check that a link such as
 * `docs/extending/README.md#promoting-a-community-provider-to-a-built-in`
 * still names a heading after the heading is edited. It lives in its own
 * module (not exported from a .test.ts file) so its unit tests can import it
 * without re-registering the link gate.
 */

/**
 * GitHub's heading slug, before duplicate numbering: link syntax reduced to
 * its text, lowercased, every character that is not a letter, a digit, a
 * space, `-` or `_` dropped (inline code backticks included), and each space
 * turned into `-`.
 */
export function headingSlug(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Every anchor in a markdown body: one slug per ATX heading, with `-1`, `-2`
 * suffixes on repeats, plus explicit `<a id="…">` / `<a name="…">` targets.
 * Headings and anchors inside fenced code blocks are not rendered as either,
 * so they do not count.
 */
export function markdownAnchors(body: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    if (fence !== null) {
      // Only a bare run of the opening character, at least as long, closes it.
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      continue;
    }

    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) {
      const slug = headingSlug(heading[1]);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
    for (const explicit of line.matchAll(/<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      anchors.add(explicit[1]);
    }
  }
  return anchors;
}
