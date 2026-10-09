import { base, site } from '../../model.mjs';
import { publications } from '../../publication.mjs';
export const prerender = true;
export function GET() {
  const routes = ['', ...Object.values(publications).map(route => `${route}/`)];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>${site}${base}${route}</loc></url>`).join('')}</urlset>`, { headers: { 'Content-Type': 'application/xml' } });
}
