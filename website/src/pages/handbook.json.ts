import { publications } from '../../publication.mjs';
export const prerender = true;
export function GET() {
  return new Response(JSON.stringify({ schemaVersion: 1, publications }), { headers: { 'Content-Type': 'application/json' } });
}
