/**
 * A keyless fixture web executor (#3685): a real child process that speaks the
 * child executor's line protocol and stores fictional Odysseus results under
 * its own upstream ids. It reaches no network. What a call does is chosen by
 * its query or URL text, never by the host:
 *
 * - `slow …`   answers after 300 ms and honours `cancel`.
 * - `hang …`   never answers, ignores `cancel` and starts a grandchild, so the
 *              host must kill the whole process group.
 * - `die …`    exits with code 3 mid-call.
 * - `late …`   answers `cancel` with a result instead of `cancelled`.
 * - `huge …`   answers with more text than the host admits.
 *
 * Every received call is appended to `$WEB_FIXTURE_DIR/calls.jsonl` and the
 * grandchild's pid to `grandchild.pid`, so a test can read what crossed.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.WEB_FIXTURE_DIR!;
const stored = new Map<string, string>();
const slow = new Map<string, ReturnType<typeof setTimeout>>();
const late = new Set<string>();
let next = 0;
const send = (frame: unknown): void => { process.stdout.write(JSON.stringify(frame) + "\n"); };

function answer(call: { id: string; tool: string; input: Record<string, any> }): void {
  const { id, tool, input } = call;
  if (tool === "get_search_content") {
    const content = stored.get(String(input.responseId));
    if (!content) return send({ type: "result", id, ok: false, code: "unknown_handle", message: "No stored result." });
    return send({ type: "result", id, ok: true, text: `Stored ${input.responseId}: ${content}` });
  }
  const subject = String(input.query ?? input.queries?.[0] ?? input.url ?? input.urls?.[0] ?? input.claim ?? "");
  if (subject.startsWith("huge")) return send({ type: "result", id, ok: true, text: "Scylla ".repeat(40_000) });
  const handle = `upstream-${process.pid}-${++next}`;
  const content = `${subject}: the raft reaches Ithaca at dawn.`;
  stored.set(handle, content);
  send({ type: "result", id, ok: true, text: `${tool} found 1 source for ${subject} (responseId: ${handle}).`, handle });
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  let newline: number;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const frame = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    if (frame.type === "cancel") {
      if (late.has(frame.id)) { late.delete(frame.id); answer({ id: frame.id, tool: "web_search", input: { query: "late" } }); continue; }
      const timer = slow.get(frame.id);
      if (timer) { clearTimeout(timer); slow.delete(frame.id); send({ type: "cancelled", id: frame.id }); }
      continue;
    }
    if (frame.type !== "call") continue;
    appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ tool: frame.tool, input: frame.input, scope: frame.scope }) + "\n");
    const subject = String(frame.input.query ?? frame.input.queries?.[0] ?? frame.input.url ?? frame.input.claim ?? "");
    if (subject.startsWith("slow")) slow.set(frame.id, setTimeout(() => { slow.delete(frame.id); answer(frame); }, 300));
    else if (subject.startsWith("hang")) {
      const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
      writeFileSync(join(dir, "grandchild.pid"), String(grandchild.pid));
      process.on("SIGTERM", () => { /* Ignored: the host must escalate. */ });
    } else if (subject.startsWith("die")) process.exit(3);
    else if (subject.startsWith("late")) late.add(frame.id);
    else answer(frame);
  }
});
send({ type: "ready" });
