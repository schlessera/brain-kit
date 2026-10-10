/// <reference lib="webworker" />
import { documentByPath } from './odyssey.ts';
import type { ExportCatalogue } from './export-key.ts';

const worker = self as unknown as ServiceWorkerGlobalScope;
declare const __DEMO_VERSION__: string;
const base = new URL('../', worker.registration.scope).pathname;
let catalogue: Promise<ExportCatalogue> | undefined;
worker.addEventListener('install', event => event.waitUntil(worker.skipWaiting()));
worker.addEventListener('activate', event => event.waitUntil(worker.clients.claim()));
worker.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return;
  const raw = url.pathname.endsWith('/api/files/content') && url.searchParams.get('raw') === '1';
  const html = url.pathname.endsWith('/api/files/html');
  if (!raw && !html) return;
  event.respondWith((async () => {
    const path = url.searchParams.get('path') || '';
    const record = documentByPath[path];
    if (record && (!html || record.kind === 'html')) return new Response(record.content, { headers: {
      'Content-Type': record.kind === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox allow-scripts",
    } });
    catalogue ||= fetch(`${base}assets/shares/index.json?v=${__DEMO_VERSION__}`).then(response => { if (!response.ok) throw Error('Demo exports unavailable'); return response.json(); });
    const binary = (await catalogue).files[path];
    if (raw && binary) return fetch(`${base}assets/shares/${binary.asset}?v=${__DEMO_VERSION__}`);
    return new Response('This file is outside the fictional demonstration.', { status: 404 });
  })());
});
