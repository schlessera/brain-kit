import { base, site } from '../../model.mjs';
export const prerender = true;
export function GET() {
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${site}${base}sitemap.xml\n`, { headers: { 'Content-Type': 'text/plain' } });
}
