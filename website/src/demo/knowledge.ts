import { demoDocuments } from './corpus.ts';
import { referenceNow } from './odyssey.ts';
import type { GraphNodePayload } from '../../../packages/ui-sdk/src/protocol.ts';

const records = demoDocuments.filter(record => record.kind === 'markdown');
const folders = [...new Set(records.map(record => record.path.split('/')[0]))].sort();
const nodes: GraphNodePayload[] = records.map((record, index) => ({
  id: index + 1, path: record.path, title: record.title, type: record.content.match(/^type: "([^"]+)"/m)?.[1] || 'note',
  inDegree: records.filter(other => other.links.includes(record.path)).length, outDegree: record.links.filter(path => records.some(other => other.path === path)).length,
  community: folders.indexOf(record.path.split('/')[0]),
  x: 0, y: 0,
}));
// One sunflower disc per folder, discs spaced around a ring: at library size a
// single ring of every record is unreadable, and a folder is what a reader
// means by "where this lives". Deterministic, so captures stay stable.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const ring = Math.max(260, folders.length * 70);
for (const community of folders.keys()) {
  const members = nodes.filter(node => node.community === community);
  const angle = community * Math.PI * 2 / folders.length;
  members.forEach((node, i) => {
    node.x = Math.cos(angle) * ring + Math.cos(i * GOLDEN) * 22 * Math.sqrt(i);
    node.y = Math.sin(angle) * ring + Math.sin(i * GOLDEN) * 22 * Math.sqrt(i);
  });
}
const edges = records.flatMap(record => record.links.flatMap(path => {
  const source = nodes.find(node => node.path === record.path); const target = nodes.find(node => node.path === path);
  return source && target ? [{ source: source.id, target: target.id }] : [];
}));
const computedAt = new Date(referenceNow).toISOString();
const reachable = new Set([nodes.find(node => node.path === 'goals/return-to-ithaca.md')!.id]);
let previousSize = -1;
while (reachable.size !== previousSize) { previousSize = reachable.size; for (const edge of edges) if (reachable.has(edge.source)) reachable.add(edge.target); }
export function knowledgeResponse(url: URL): Response | null {
  const path = url.pathname;
  if (path.endsWith('/brain/search')) {
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    // Every term must appear; a title hit outranks body hits, then the most
    // mentions win. Ties keep path order, so results are stable.
    const scored = query ? records.flatMap(record => {
      const title = record.title.toLowerCase(); const text = record.content.toLowerCase();
      if (!terms.every(term => title.includes(term) || text.includes(term))) return [];
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 10 : 0) + text.split(term).length - 1, 0);
      return [{ record, score }];
    }).sort((a, b) => b.score - a.score) : [];
    return Response.json({ results: scored.slice(0, Number(url.searchParams.get('limit')) || 20).map(({ record, score }) => ({ path: record.path, title: record.title, type: nodes.find(node => node.path === record.path)!.type, relevance: 'Demo keyword match', score, snippet: record.content.split('---\n\n')[1]?.replace(/^#.*\n/, '').trim().slice(0, 220) || record.title })), warnings: ['Demo keyword search over fictional records; no retrieval backend is running.'] });
  }
  if (path.endsWith('/graph/meta')) return Response.json({ available: true, schemaVersion: 8, computedAt, stale: false, nodeCount: nodes.length, edgeCount: edges.length, communities: folders.map((label, community) => ({ community, label, size: nodes.filter(node => node.community === community).length, topTerms: [label] })), defaultRoot: { path: 'goals/return-to-ithaca.md', virtual: false } });
  if (path.endsWith('/graph/maintenance')) {
    const staleDays = Number(url.searchParams.get('staleDays') || 90);
    return Response.json({ orphans: nodes.filter(node => !node.inDegree && !node.outDegree), unreachable: nodes.filter(node => !reachable.has(node.id)), brokenLinks: [], stale: records.filter(record => (referenceNow - Date.parse(record.updated)) / 86400000 >= staleDays).sort((a, b) => a.updated.localeCompare(b.updated)).map(record => ({ ...nodes.find(node => node.path === record.path), updated: record.updated })), staleDays });
  }
  if (/\/graph\/(clusters|discovery|neighborhood)$/.test(path)) {
    let selected = nodes;
    if (url.searchParams.has('community')) selected = nodes.filter(node => node.community === Number(url.searchParams.get('community')));
    if (!path.endsWith('/clusters')) {
      const root = nodes.find(node => node.path === (url.searchParams.get('center') || url.searchParams.get('root') || 'goals/return-to-ithaca.md'));
      if (!root) return Response.json({ nodes: [], edges: [], truncated: false });
      const distances = new Map([[root.id, 0]]);
      const depth = Number(url.searchParams.get('depth') || url.searchParams.get('maxDepth') || 3);
      const direction = url.searchParams.get('direction') || (path.endsWith('/discovery') ? 'out' : 'both');
      for (let step = 0; step < depth; step++) for (const edge of edges) {
        if (direction !== 'in' && distances.get(edge.source) === step && !distances.has(edge.target)) distances.set(edge.target, step + 1);
        if (direction !== 'out' && distances.get(edge.target) === step && !distances.has(edge.source)) distances.set(edge.source, step + 1);
      }
      selected = nodes.filter(node => distances.has(node.id)).map(node => ({ ...node, distance: distances.get(node.id) }));
    }
    const ids = new Set(selected.map(node => node.id));
    return Response.json({ nodes: selected, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), truncated: false, ...(path.endsWith('/discovery') && !url.searchParams.get('root') ? { reachableCount: reachable.size, unreachableCount: nodes.length - reachable.size } : {}) });
  }
  return null;
}
