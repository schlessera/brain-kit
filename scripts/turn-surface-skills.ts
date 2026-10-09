import type { CapturedRequest } from "./capture-turn-surface";
import type { SkillEntry } from "./turn-surface-routing";

/** Read the actual native listing, including bundled entries rather than only
 * the fixture's authored files. Reject changed/ambiguous native boundaries.
 */
export function observedSkills(request: CapturedRequest): SkillEntry[] {
  const startMarker = "The following skills are available for use with the Skill tool:\n\n";
  const endMarker = "\n\n<total_tokens>";
  const lists: string[] = [];
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type?: string; text?: string }>) {
      if (block.type !== "text" || !block.text?.includes(startMarker)) continue;
      const start = block.text.indexOf(startMarker) + startMarker.length;
      const end = block.text.indexOf(endMarker, start);
      if (end < 0 || block.text.indexOf(startMarker, start) >= 0) throw Error("Native skill-listing boundaries changed");
      lists.push(block.text.slice(start, end));
    }
  }
  if (lists.length !== 1) throw Error("Expected one actual native skill listing");
  const matches = [...lists[0]!.matchAll(/(?:^|\n)- ([^\s:]+): ([\s\S]*?)(?=\n- [^\s:]+: |$)/g)];
  const entries = matches.map(match => ({ name: match[1]!, description: match[2]!.trim() }));
  if (!entries.length || new Set(entries.map(entry => entry.name)).size !== entries.length
    || entries.some(entry => !entry.description)) throw Error("Incomplete or duplicate native skills");
  return entries;
}
