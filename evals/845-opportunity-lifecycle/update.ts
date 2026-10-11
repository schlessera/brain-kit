import { data, type Case, type Files } from "./score";

function fields(s: string, values: Record<string, unknown>): string {
  const end = s.indexOf("\n---", 4);
  let head = s.slice(0, end), body = s.slice(end);
  for (const [key, value] of Object.entries(values)) {
    head = head.replace(new RegExp(`^${key}:.*\\n?`, "m"), "").trimEnd();
    if (value != null) head += `\n${key}: ${JSON.stringify(value)}`;
  }
  return head + body;
}

/** Experiment only: explicit facts drive edits; the classifier supplies only kind and target. */
export function update(c: Pick<Case, "directory" | "focusPath" | "facts" | "message">, before: Files, kind: string, target: string): { files: Files; kind: string; opportunity: string } {
  const files = { ...before }, f = c.facts, prefix = `${c.directory}/${target}/`, status = `${prefix}status.md`, prep = `${prefix}interview-prep.md`;
  const refuse = () => ({ files: before, kind: "unclear", opportunity: "unclear" });
  if (["none", "unclear"].includes(kind)) return { files: before, kind, opportunity: kind };
  if (!files[status] || !["scheduled", "rebooked", "cancelled", "offer", "closed"].includes(kind)) return refuse();
  let calls = [...new Set((files[prep] ?? "").split("\n").filter(l => /^- /.test(l) && /with .+2026-07-\d\dT/.test(l)).map(l => l.replace(/^- (\[[^\]]+\] )?/, "")))];
  if (["scheduled", "rebooked"].includes(kind)) {
    if (!f.round || !f.format || !f.startsAt || !f.timeZone || !f.contact?.name || !f.contact?.role) return refuse();
    try {
      const instant = new Date(f.startsAt);
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: f.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(instant);
      const clock = parts.filter(p => ["hour", "minute"].includes(p.type)).map(p => p.value).join(":");
      if (clock !== f.startsAt.slice(11, 16)) return refuse();
    } catch { return refuse(); }
    if (kind === "rebooked" && !calls.some(call => call.startsWith(f.round + " with "))) return refuse();
    calls = calls.filter(call => !call.startsWith(f.round + " with "));
    calls.push(`${f.round} with ${f.contact.name}, ${f.startsAt} (${f.timeZone}); ${f.format}`);
  } else if (kind === "cancelled") {
    // Only cancel an identifiable round; never guess which of several calls it was.
    const round = String(f.roundId ?? "").toLowerCase();
    const matching = calls.filter(call => call.toLowerCase().startsWith(round));
    if (matching.length !== 1 || !f.reason || !f.resumeStage) return refuse();
    calls = calls.filter(call => call !== matching[0]);
  } else if ((kind === "closed" && !f.reason) || (kind === "offer" && f.deadline && !f.nextStep)) return refuse();
  else calls = [];
  calls.sort((a, b) => Date.parse(a.match(/2026-07-\d\dT[^ ]+/)?.[0] ?? "") - Date.parse(b.match(/2026-07-\d\dT[^ ]+/)?.[0] ?? ""));
  const next = calls[0] ?? (kind === "offer" ? f.nextStep : null), deadline = calls[0]?.match(/2026-07-\d\d/)?.[0] ?? (kind === "offer" ? f.deadline : null);
  const stage = kind === "closed" ? "closed" : kind === "offer" ? "offer" : calls.length ? "interviewing" : f.resumeStage;
  const previous = data(files[status]);
  files[status] = fields(files[status], { stage, next_step: next, deadline, updated: "2026-07-12", ...(kind === "closed" ? { relevance: "historical", closed_reason: f.reason } : {}) });
  const entry = `- 2026-07-12: ${kind}; ${next ?? f.reason ?? "offer received; next step unknown"}; previous next step ${previous.next_step ?? "none"}, deadline ${previous.deadline ?? "none"}.`;
  if (/## Timeline\n/.test(files[status])) files[status] = files[status].replace(/(## Timeline\n[\s\S]*?)(?=\n## |$)/, (_, section: string) => section.trimEnd() + `\n${entry}\n`);
  else files[status] += `\n## Timeline\n\n${entry}\n`;
  if (f.contact) {
    const row = `| ${f.contact.name} | ${f.contact.role} | Interview | ${f.contact.details ?? "unknown"} |`;
    if (/## Contacts\n/.test(files[status])) files[status] = files[status].replace(/(## Contacts\n[\s\S]*?)(?=\n## |$)/, (_, section: string) => section.trimEnd() + `\n${row}\n`);
    else files[status] += `\n## Contacts\n\n| Name | Role | Relationship | Notes |\n| --- | --- | --- | --- |\n${row}\n`;
  }
  if (!files[status].includes(prep.slice(0, -3)) && calls.length) files[status] += `\n## Related preparation\n\n[[${prep.slice(0, -3)}]]\n`;
  if (["offer", "closed"].includes(kind)) for (const p of Object.keys(files).filter(p => p.startsWith(prefix) && p !== status && data(files[p]).deadline)) {
    files[p] = fields(files[p], { deadline: null, updated: "2026-07-12" }) + `\nCancelled 2026-07-12: ${kind}; prior deadline ${data(before[p]).deadline}.\n`;
  }
  if (files[prep] || calls.length) {
    files[prep] ??= `---\ntype: opportunity\ntitle: Interview preparation\ncreated: 2026-07-12\nupdated: 2026-07-12\nstatus: active\nrelevance: primary\ntags: [job-search, interview-prep]\n---\n\n## Related\n\n[[${prefix}status]]\n[[${prefix}research]]\n`;
    files[prep] = fields(files[prep], { deadline: calls.length ? deadline : null, updated: "2026-07-12" });
    for (const related of ["status", "research"]) if (!files[prep].includes(`${prefix}${related}`)) files[prep] += `\n[[${prefix}${related}]]\n`;
    // Keep prior call details as history instead of deleting them with the active section.
    files[prep] = files[prep].replace(/## Upcoming calls\n([\s\S]*?)(?=\n## |\n<!-- \/brain:|$)/g, "## Previous calls\n$1");
    files[prep] += `\n## Upcoming calls\n\n${calls.map(call => "- " + call).join("\n") || "No scheduled calls."}\n`;
  }
  const link = `[[${prefix}status]]`;
  files[c.focusPath] = fields(files[c.focusPath], { updated: "2026-07-12" }).split("\n").map(line => line.includes(link) ? next ? `- ${link} — ${next}` : kind === "offer" ? `- ${link} — Offer received; next step unknown` : "" : line).join("\n");
  return { files, kind, opportunity: target };
}
