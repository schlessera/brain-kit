/**
 * Inside an actual strict Claude worker (#2848): the brain's own MCP server,
 * started as the brain's `.mcp.json` starts it (with `BRAIN_ROOT` pinned to
 * the brain path), answers one `brain_search` over stdio. The worker's
 * launch maps that root to the turn's data tree.
 */
const [cli, query, pinned] = process.argv.slice(2) as [string, string, string];
const child = Bun.spawn([process.execPath, cli, "mcp"], { env: { ...process.env, BRAIN_ROOT: pinned }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const waiting = new Map<number, (message: { result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown }) => void>();
let buffer = "", id = 0;
void (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk);
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); waiting.get(message.id)?.(message);
    }
  }
})();
const send = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof waiting.get>>>[0]>(done => {
  waiting.set(++id, done); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); child.stdin.flush();
});
const timer = setTimeout(() => { child.kill("SIGKILL"); console.log(JSON.stringify({ error: "the brain MCP server did not answer within 60 s" })); process.exit(1); }, 60_000);
try {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "odysseus-native-worker", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); child.stdin.flush();
  const found = await send("tools/call", { name: "brain_search", arguments: { query, limit: 50 } });
  const text = found.result?.content?.map(part => part.text).join("\n") ?? "";
  const paths = [...new Set(text.match(/notes\/scheria-log-\d\d\.md/g) ?? [])].sort();
  console.log(JSON.stringify({ paths, isError: found.result?.isError === true || found.error !== undefined, root: process.env.BRAIN_ROOT, dataRoot: process.env.BRAIN_WORKER_DATA_ROOT }));
} finally { clearTimeout(timer); child.kill("SIGKILL"); }
export {};
