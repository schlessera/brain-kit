/** Local-only Android measurement page. No provider, model or product server. */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) throw Error('Usage: node android-server.mjs <private-output-directory>');
mkdirSync(out, {recursive:true});
const routes = new Map([
  ['/', ['text/html', readFileSync(resolve(here,'android-page.html'))]],
  ['/page.js', ['text/javascript', readFileSync(resolve(here,'page.js'))]],
]);
const server = createServer(async (req,res) => {
  if (req.method === 'POST' && req.url === '/receipt') {
    // Bounded, local probe data only; never copy raw runtime logs to GitHub.
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024*1024) { res.writeHead(413).end(); return; }
    }
    try {
      const value = JSON.parse(body);
      appendFileSync(resolve(out,'receipts.jsonl'), JSON.stringify({...value, receivedWall:Date.now()})+'\n');
      res.writeHead(204).end();
    } catch { res.writeHead(400).end(); }
    return;
  }
  const route = routes.get(req.url);
  if (req.method !== 'GET' || !route) { res.writeHead(404).end(); return; }
  res.writeHead(200, {'content-type':route[0], 'cache-control':'no-store', 'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'"}).end(route[1]);
});
server.listen(8765,'127.0.0.1', () => console.log('Probe: http://127.0.0.1:8765; use adb reverse tcp:8765 tcp:8765'));
