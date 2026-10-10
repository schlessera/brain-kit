import { resolve, sep } from 'node:path';
const directory = resolve(import.meta.dir, '../dist');
const manifest = await Bun.file(resolve(directory, 'build-manifest.json')).json();
const prefix = manifest.base;
const port = Number(process.env.PORT || 46401);
const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/' && prefix !== '/') return Response.redirect(new URL(prefix, url), 302);
  if (!url.pathname.startsWith(prefix)) return new Response('Not found', { status: 404 });
  let path: string;
  try { path = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { return new Response('Bad path', { status: 400 }); }
  const target = resolve(directory, path.endsWith('/') || !path ? `${path}index.html` : path);
  if (!target.startsWith(directory + sep)) return new Response('Not found', { status: 404 });
  const index = Bun.file(resolve(target, 'index.html'));
  const file = await index.exists() ? index : Bun.file(target);
  if (!await file.exists()) return new Response('Not found', { status: 404 });
  return new Response(file, { headers: { 'Cache-Control': 'no-store' } });
} });
console.log(`Website preview: http://127.0.0.1:${server.port}${prefix}`);
