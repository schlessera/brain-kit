// The demo brain's search, graph and maintenance answers. The graph is what
// brain-kit's own indexer would compute for these files: core's Louvain
// communities, PageRank and ForceAtlas2 layout over the links as written,
// including the ones that resolve to nothing.
import Graph from 'graphology';
import { computeMetrics } from '../../../packages/core/src/lib/graph/metrics.ts';
import { computeClusterLayout } from '../../../packages/core/src/lib/graph/layout.ts';
import { communityTopTerms, type TermIndex } from '../../../packages/core/src/lib/graph/labels.ts';
import type { GraphBrokenLink, GraphNodePayload } from '../../../packages/ui-sdk/src/protocol.ts';
import { demoDocuments, documentByPath, resolveWikilink } from './corpus.ts';
import { referenceNow, type DemoDocument } from './odyssey.ts';

// Title words that never name a topic, as the indexer's own list does.
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'not', 'are', 'was', 'were', 'has', 'have', 'had', 'his', 'her', 'its', 'our', 'their', 'one', 'two', 'all', 'any', 'more', 'most', 'other', 'than', 'then', 'there', 'here', 'about', 'over', 'under', 'notes', 'note', 'index', 'draft', 'todo', 'misc', 'day']);
const field = (record: DemoDocument, key: string) => {
  const line = record.content.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];
  try { return line === undefined ? undefined : JSON.parse(line); } catch { return line; }
};
const body = (record: DemoDocument) => record.content.split('\n---\n').slice(1).join('\n---\n');

// Index order: the indexer numbers files as it first meets them, so the oldest
// records hold the lowest ids. Discovery's rings order by id, which mixes
// folders the way a real brain's history does.
const records = demoDocuments.filter(record => record.kind === 'markdown')
  .map(record => ({ record, created: String(field(record, 'created') ?? record.updated) }))
  .sort((a, b) => a.created.localeCompare(b.created) || a.record.path.localeCompare(b.record.path))
  .map(({ record }) => record);
const idOf = new Map(records.map((record, index) => [record.path, index + 1]));

// Links as the indexer reads them: frontmatter-listed paths and body wiki-links.
// A target that is not a file is a broken link, recorded as written.
const brokenLinks: GraphBrokenLink[] = [];
const outgoing = new Map<number, Set<number>>();
for (const record of records) {
  const targets = new Set<number>(); const broken = new Set<string>();
  const written = [...record.links, ...[...body(record).matchAll(/\[\[([^[\]\n]+?)\]\]/g)].map(match => match[1])];
  for (const text of new Set(written)) {
    const path = text.endsWith('.md') && record.links.includes(text) ? text : resolveWikilink(text);
    const id = path && documentByPath[path]?.kind === 'markdown' ? idOf.get(path) : undefined;
    if (id === undefined) { if (!(path && documentByPath[path]) && !broken.has(path ?? text)) { broken.add(path ?? text); brokenLinks.push({ sourcePath: record.path, target: text }); } continue; }
    if (id !== idOf.get(record.path)) targets.add(id);
  }
  outgoing.set(idOf.get(record.path)!, targets);
}

const graph = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });
for (const record of records) graph.addNode(String(idOf.get(record.path)), { path: record.path });
for (const [source, targets] of outgoing) for (const target of targets) graph.addEdge(String(source), String(target));
const metrics = computeMetrics(graph);
const positions = computeClusterLayout(graph, { communities: metrics.communities }).positions;

// Community labels from the same inputs the indexer weighs: tags twice, title words once.
const termIndex: TermIndex = { byDoc: new Map(), documentFrequency: new Map(), totalDocs: records.length };
for (const record of records) {
  const tags = (Array.isArray(field(record, 'tags')) ? field(record, 'tags') as string[] : []).map(tag => tag.toLowerCase().trim()).filter(tag => tag.length >= 3);
  const words = record.title.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !STOP_WORDS.has(word));
  const terms = [...tags.flatMap(tag => [tag, tag]), ...words];
  termIndex.byDoc.set(idOf.get(record.path)!, terms);
  for (const term of new Set(terms)) termIndex.documentFrequency.set(term, (termIndex.documentFrequency.get(term) ?? 0) + 1);
}
const communities = [...metrics.communities].map(([community, members]) => {
  const topTerms = communityTopTerms(termIndex, members);
  return { community, size: members.length, label: topTerms[0] ?? null, topTerms };
});

const nodes: GraphNodePayload[] = records.map(record => {
  const id = idOf.get(record.path)!; const measured = metrics.byNode.get(id)!; const at = positions.get(id);
  return { id, path: record.path, title: record.title, type: String(field(record, 'type') ?? 'note'), inDegree: measured.inDegree, outDegree: measured.outDegree, community: measured.community ?? undefined, pagerank: measured.pagerank, ...(at ? { x: at.x, y: at.y } : {}) };
});
const nodeById = new Map(nodes.map(node => [node.id, node]));
const nodeByPath = new Map(nodes.map(node => [node.path, node]));
const edges = [...outgoing].flatMap(([source, targets]) => [...targets].map(target => ({ source, target })));
const computedAt = new Date(referenceNow).toISOString();
const ROOT = 'goals/return-to-ithaca.md';
const reachable = new Set([nodeByPath.get(ROOT)!.id]);
for (let frontier = [...reachable]; frontier.length;) frontier = frontier.flatMap(id => [...outgoing.get(id)!].filter(next => !reachable.has(next) && reachable.add(next)));

/** The indexed graph, for the stats endpoints to measure at any past date. */
export const indexed = { records, idOf, outgoing, brokenLinks, tagsOf: (record: DemoDocument) => (Array.isArray(field(record, 'tags')) ? field(record, 'tags') as string[] : []), createdOf: (record: DemoDocument) => String(field(record, 'created') ?? record.updated), typeOf: (record: DemoDocument) => String(field(record, 'type') ?? 'note'), statusOf: (record: DemoDocument) => field(record, 'status') as string | undefined, body };
/** What the maintenance view and `brain stats` report; also read by the stats endpoints. */
export const graphHealth = {
  documents: records.length, links: edges.length, brokenLinks: brokenLinks.length,
  orphans: nodes.filter(node => !node.inDegree && !node.outDegree).length,
  unreachable: nodes.length - reachable.size, communities: communities.length,
};

export function knowledgeResponse(url: URL): Response | null {
  const path = url.pathname;
  if (path.endsWith('/brain/search')) {
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    // Every term must appear; a title hit outranks body hits, then the most
    // mentions win. Ties keep index order, so results are stable.
    const scored = query ? records.flatMap(record => {
      const title = record.title.toLowerCase(); const text = record.content.toLowerCase();
      if (!terms.every(term => title.includes(term) || text.includes(term))) return [];
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 10 : 0) + text.split(term).length - 1, 0);
      return [{ record, score }];
    }).sort((a, b) => b.score - a.score) : [];
    return Response.json({ results: scored.slice(0, Number(url.searchParams.get('limit')) || 20).map(({ record, score }) => ({ path: record.path, title: record.title, type: nodeByPath.get(record.path)!.type, relevance: 'Demo keyword match', score, snippet: body(record).replace(/^\s*#.*\n/, '').trim().slice(0, 220) || record.title })), warnings: ['Demo keyword search over fictional records; no retrieval backend is running.'] });
  }
  if (path.endsWith('/graph/meta')) return Response.json({ available: true, schemaVersion: 8, computedAt, stale: false, nodeCount: nodes.length, edgeCount: edges.length, communities, defaultRoot: { path: ROOT, virtual: false } });
  if (path.endsWith('/graph/maintenance')) {
    const staleDays = Number(url.searchParams.get('staleDays') || 90);
    return Response.json({ orphans: nodes.filter(node => !node.inDegree && !node.outDegree), unreachable: nodes.filter(node => !reachable.has(node.id)), brokenLinks, stale: records.filter(record => (referenceNow - Date.parse(record.updated)) / 86400000 >= staleDays).sort((a, b) => a.updated.localeCompare(b.updated)).map(record => ({ ...nodeByPath.get(record.path)!, updated: record.updated })), staleDays });
  }
  if (/\/graph\/(clusters|discovery|neighborhood)$/.test(path)) {
    let selected = nodes;
    if (url.searchParams.has('community')) selected = nodes.filter(node => node.community === Number(url.searchParams.get('community')));
    if (!path.endsWith('/clusters')) {
      const root = nodeByPath.get(url.searchParams.get('center') || url.searchParams.get('root') || ROOT);
      if (!root) return Response.json({ nodes: [], edges: [], truncated: false });
      const distances = new Map([[root.id, 0]]);
      const depth = Number(url.searchParams.get('depth') || url.searchParams.get('maxDepth') || 3);
      const direction = url.searchParams.get('direction') || (path.endsWith('/discovery') ? 'out' : 'both');
      for (let step = 0; step < depth; step++) for (const edge of edges) {
        if (direction !== 'in' && distances.get(edge.source) === step && !distances.has(edge.target)) distances.set(edge.target, step + 1);
        if (direction !== 'out' && distances.get(edge.target) === step && !distances.has(edge.source)) distances.set(edge.source, step + 1);
      }
      selected = [...distances].map(([id, distance]) => ({ ...nodeById.get(id)!, distance })).sort((a, b) => a.id - b.id);
    }
    const ids = new Set(selected.map(node => node.id));
    return Response.json({ nodes: selected, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), truncated: false, ...(path.endsWith('/discovery') && !url.searchParams.get('root') ? { reachableCount: reachable.size, unreachableCount: nodes.length - reachable.size } : {}) });
  }
  return null;
}
