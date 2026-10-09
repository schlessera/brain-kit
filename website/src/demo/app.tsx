// A local transport simulation around the production UI. Nothing is sent to a host.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityPage, AppErrorBoundary, AppShell, BrainUiProvider, ChatPage, GraphPage, createBrainUiRoot, useUIStore } from '@schlessera/brain-ui-react';
import type { ActivitySpan, RenderRequest } from '@schlessera/brain-ui-sdk/protocol';
// The Odysseus fixtures are the shared example corpus (docs/decisions/example-corpus.md),
// read from source on purpose: they are test and demo data, not package API (#1382).
import { geo } from '../../../packages/ui-kit/fixtures/geo/index.ts';
import { binaryDocuments, corpusBlocks, demoDocuments, departureDiagram, directories, documentByPath, referenceNow, supportingFilesBlock, treeEntries, wikilinks } from './odyssey.ts';
import { exportKey, type ExportCatalogue } from './export-key.ts';
import { knowledgeResponse } from './knowledge.ts';

const workStart = referenceNow - 60000;
// The clock, like the responses, is fictional and isolated inside this iframe.
Date.now = () => referenceNow;
const workSpans: ActivitySpan[] = [
  { runId: 'departure-review', spanId: 'root', kind: 'cron', origin: 'cron', name: 'Prepare for departure', startedAt: workStart },
  { runId: 'departure-review', spanId: 'supplies', parentSpanId: 'root', kind: 'subagent', origin: 'cron', name: 'invoke_agent', subagent: { type: 'supplies', description: 'Review the provisions.' }, startedAt: workStart, endedAt: workStart + 23000, outcome: 'success' },
  { runId: 'departure-review', spanId: 'raft', parentSpanId: 'root', kind: 'subagent', origin: 'cron', name: 'invoke_agent', subagent: { type: 'raft-check', description: 'Review the raft preparations.' }, startedAt: workStart + 5000, endedAt: workStart + 38000, outcome: 'success' },
  { runId: 'departure-review', spanId: 'course', parentSpanId: 'root', kind: 'subagent', origin: 'cron', name: 'invoke_agent', subagent: { type: 'course-review', description: "Read Calypso's directions." }, startedAt: workStart + 16000 },
];
const sessions = [
  { id: 'ogygia', title: 'Leaving Ogygia', backendId: 'pi', lastActiveAt: referenceNow, createdAt: referenceNow, totalCostUsd: 0, numTurns: 2 },
  { id: 'raft', title: 'Raft supplies', backendId: 'pi', lastActiveAt: referenceNow - 3600000, createdAt: referenceNow - 3600000, totalCostUsd: 0, numTurns: 1 },
  ...[
    ['decision', 'Scylla or Charybdis'], ['crew', 'The twelve-ship ledger'],
    ['household', 'News from Ithaca'], ['forecast', 'The forecast and the oath'],
    ['library', 'Records for the crossing'], ['diagram', 'The planned passage'],
  ].map(([id, title], index) => ({ id, title, backendId: 'pi', lastActiveAt: referenceNow - (index + 2) * 3600000, createdAt: referenceNow - (index + 2) * 3600000, totalCostUsd: 0, numTurns: 2 })),
];
const nativeFetch = window.fetch.bind(window);
declare const __DEMO_VERSION__: string;
const siteBase = location.pathname.slice(0, location.pathname.indexOf('/demo/') + 1);
let catalogue: Promise<ExportCatalogue> | undefined;
function exportsIndex() { return catalogue ||= nativeFetch(`${siteBase}assets/shares/index.json?v=${__DEMO_VERSION__}`).then(response => { if (!response.ok) throw Error('The demo export catalogue is unavailable.'); return response.json(); }); }
// The worker only adapts the product's URL-based image/HTML/download paths to
// static files. It holds no cache or user state and claims only /demo/ clients.
if ('serviceWorker' in navigator) {
  const registration = await navigator.serviceWorker.register(`${siteBase}demo/transport.js?v=${__DEMO_VERSION__}`, { scope: `${siteBase}demo/` });
  const installing = registration.installing || registration.waiting;
  if (installing && installing.state !== 'activated') await new Promise<void>((resolve, reject) => installing.addEventListener('statechange', () => {
    if (installing.state === 'activated') resolve();
    else if (installing.state === 'redundant') reject(Error('The local file preview transport could not start.'));
  }));
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
}
const params = new URLSearchParams(location.search);
let scene = params.get('scene') || location.pathname.split('/').filter(Boolean).at(-1) || 'rank';
let turn = 0;
let generation = 0;
function announce(message: string) { window.parent.postMessage({ type: 'brain-demo-status', message }, location.origin); }

async function request(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
  const path = url.pathname;
  const knowledge = knowledgeResponse(url);
  if (knowledge) return knowledge;
  if (path.endsWith('/render')) {
    const payload = JSON.parse(String(init?.body || '{}'));
    const key = await exportKey(payload);
    const asset = (await exportsIndex()).exports[key]?.[payload.format as 'png' | 'pdf'];
    if (!asset) return Response.json({ error: 'demo_export_missing', detail: 'This exact response has no prepared export. Try a prepared Odyssey scenario.' }, { status: 422 });
    return nativeFetch(`${siteBase}assets/shares/${asset}?v=${__DEMO_VERSION__}`);
  }
  if (path.endsWith('/sessions')) return Response.json({ sessions });
  if (path.endsWith('/providers')) return Response.json({ providers: [], backends: {} });
  if (path.endsWith('/activity/inbox')) return Response.json({ intents: [] });
  if (path.endsWith('/activity/runs/departure-review')) return Response.json({ runId: 'departure-review', detailPruned: false, spans: workSpans, events: [], highWaterSeq: 0 });
  if (path.endsWith('/activity/runs')) return Response.json({ live: [], history: [] });
  if (path.endsWith('/session-drafts')) return Response.json({ supported: false, drafts: [] });
  if (path.endsWith('/geo/coastline')) return Response.json({ ...geo.gozo, roads: [], streets: [], detail: 'coast', partial: false });
  if (path.endsWith('/files/tree')) {
    const directory = url.searchParams.get('path') || '';
    return directories.has(directory) ? Response.json({ path: directory, entries: treeEntries(directory) }) : Response.json({ error: 'Directory not found' }, { status: 404 });
  }
  if (path.endsWith('/files/content')) {
    const selected = url.searchParams.get('path') || '';
    const file = documentByPath[selected];
    if (file) {
      if (url.searchParams.get('raw') === '1') return new Response(file.content, { headers: { 'Content-Type': file.kind === 'html' ? 'text/html' : 'text/plain' } });
      return Response.json({ content: file.content, path: file.path, kind: file.kind, size: new TextEncoder().encode(file.content).length, mtime: Date.parse(`${file.updated}T04:40:00Z`) });
    }
    const binary = (await exportsIndex()).files[selected];
    if (binary) return url.searchParams.get('raw') === '1' ? nativeFetch(`${siteBase}assets/shares/${binary.asset}?v=${__DEMO_VERSION__}`) : Response.json({ path: selected, kind: 'binary', size: binary.size, mime: binary.mime, mtime: referenceNow });
    return Response.json({ error: 'This file is outside the fictional demonstration.' }, { status: 404 });
  }
  if (path.endsWith('/files/resolve')) {
    const selected = url.searchParams.get('path') || '';
    const directory = directories.has(selected);
    const exists = directory || !!documentByPath[selected] || binaryDocuments.some(file => file.path === selected);
    const parts = selected.split('/');
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    return Response.json({ path: selected, exists, type: directory ? 'dir' : 'file', ancestors });
  }
  if (path.endsWith('/files/wikilinks')) return Response.json({ generatedAt: referenceNow, count: Object.keys(wikilinks).length, slugs: wikilinks });
  // Unsupported services are honest failures; they never fall through to fetch.
  return Response.json({ error: 'This service is outside the fictional demonstration.' }, { status: 404 });
}

class FixtureSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: ((event: object) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: object) => void) | null = null;
  onerror = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor() { this.later(() => { this.readyState = 1; this.onopen?.({}); this.emit({ type: 'server_hello', protocolRev: 5, principalKey: 'fictional-odysseus', capabilities: { askReceipts: true, liveness: true, activity: true } }); }, 20); }
  later(callback: () => void, delay = 0) { const timer = setTimeout(() => { this.timers.delete(timer); if (this.readyState !== 3) callback(); }, delay); this.timers.add(timer); }
  emit(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    if (frame.type === 'ping') this.emit({ type: 'pong', probeId: frame.probeId });
    if (frame.type === 'activity_subscribe') this.emit({ type: 'activity_snapshot', view: frame.view, runId: frame.runId, spans: workSpans, events: [], highWaterSeq: { 'departure-review': 0 } });
    if (frame.type === 'session_resume') { ui.stores.chat.getState().setActiveSession(frame.sessionId); seed(frame.sessionId === 'raft' ? 'comparison' : frame.sessionId === 'ogygia' ? 'rank' : frame.sessionId, frame.sessionId); }
    if (frame.type === 'ask_user_rank_response') {
      const key = frame.sessionId || ui.stores.chat.getState().activeSessionId || 'ogygia';
      if (frame.submissionId) this.emit({ type: 'ask_answer_receipt', requestId: frame.requestId, submissionId: frame.submissionId, sessionId: key, turnId: frame.turnId, state: 'accepted' });
      const labels: Record<string, string> = { supplies: 'water and provisions', raft: 'the raft', course: 'the course' };
      ui.stores.chat.getState().appendText(key, `\n\nYour first priority is ${labels[frame.order[0]]}. This staged plan follows your order.`);
      ui.stores.chat.getState().finishAssistantMessage(key);
      this.emit({ type: 'result', sessionId: key, turnId: frame.turnId, outcome: 'success', durationMs: 0, numTurns: 1, isError: false });
      announce('Priorities received. Explore the plan beside your decision.');
    }
    if (frame.type === 'ask_user_cancel' || frame.type === 'cancel') ui.stores.chat.getState().finishAssistantMessage('ogygia');
    if (frame.type === 'tool_approval' || frame.type === 'tool_denial') {
      const accepted = frame.type === 'tool_approval';
      const key = ui.stores.chat.getState().activeSessionId || 'ogygia';
      this.later(() => {
        const chat = ui.stores.chat.getState();
        chat.setToolResult(key, 'archive-checklist', accepted ? 'The fictional checklist was archived in this demo.' : 'Archive denied. The fictional checklist stays active.', !accepted);
        chat.appendText(key, accepted ? '\n\nThe staged archive was approved. No real file changed.' : '\n\nThe staged archive was denied. No real file changed.');
        chat.finishAssistantMessage(key);
        this.emit({ type: 'result', sessionId: key, turnId: chat.buffers[key]?.messages.at(-1)?.turnId, outcome: 'success', durationMs: 0, numTurns: 1, isError: false });
      }, 100);
    }
    if (frame.type === 'chat_message') {
      const epoch = generation;
      const key = frame.sessionId || `demo-session-${++turn}`;
      if (!frame.sessionId) ui.stores.chat.getState().bindDraftSession(key);
      ui.stores.chat.getState().finishAssistantMessage(key);
      this.later(() => {
        if (generation !== epoch) return;
        const turnId = `fixture-turn-${++turn}`;
        this.emit({ type: 'status', status: 'thinking', sessionId: key, turnId, requestId: frame.requestId });
        respond(frame.text, key, turnId);
        if (!ui.stores.chat.getState().buffers[key]?.isStreaming) this.emit({ type: 'result', sessionId: key, turnId, outcome: 'success', durationMs: 0, numTurns: 1, isError: false });
      }, 280);
    }
  }
  close() { this.readyState = 3; this.timers.forEach(clearTimeout); this.timers.clear(); }
}
Object.assign(window, { WebSocket: FixtureSocket });
// Secondary UI paths use the same closed transport boundary.
window.fetch = request as typeof fetch;
const ui = createBrainUiRoot({ storage: null, request: request as typeof fetch, config: { appName: 'Brain', assistantName: 'Brain', backendUrl: `${location.origin}${siteBase}demo`, composerPlaceholder: 'Try: plan, crew ledger, Scylla, or files', sourceCommit: 'fictional-demo' } });
ui.stores.file.setState({ frontmatterCollapsed: true });
ui.stores.ui.getState().setTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
ui.stores.chat.getState().setActiveSession('ogygia');
ui.stores.chat.getState().setSessionBackend('ogygia', 'pi');
let ready = false;

function block(value: object, key = 'ogygia') {
  const chat = ui.stores.chat.getState(); const id = `demo-block-${++turn}`;
  chat.startToolCall(key, id, 'show_block'); chat.completeToolCall(key, id, 'show_block', { block: value }); chat.setToolResult(key, id, JSON.stringify({ block: value }), false);
}
function rich(key = 'ogygia') {
  block({ kind: 'stats', tiles: [
    { label: 'Departure', value: 'Today', meta: '12 July', icon: 'calendar' },
    { label: 'Passage', value: '17 days', meta: 'Planned', icon: 'deadline' },
    { label: 'Landfall', value: '29 July', meta: 'Scheria · planned', icon: 'resolved' },
  ] }, key);
  block({ kind: 'map', title: 'Leaving Ogygia', places: [
    { label: 'Ogygia', lat: 36.05, lon: 14.25, source: 'Conventional identification: Gozo' },
    { label: 'The cave', lat: 36.062, lon: 14.283, source: 'Fixture: Ramla Bay, Gozo' },
  ] }, key);
}
function rank(key = 'ogygia', turnId = `fixture-turn-${turn}`) {
  const setRank = ui.stores.chat.getState().setAskUserRankRequest as (key: string, id: string, payload: Parameters<ReturnType<typeof ui.stores.chat.getState>['setAskUserRankRequest']>[2], turnId?: string) => void;
  // The optional turn identity was added after the original three-argument API.
  setRank(key, `preparations-${++turn}`, {
    prompt: 'What should we prepare first?', items: [
      { id: 'supplies', label: 'Water and provisions', detail: 'Prepare supplies for the passage.' },
      { id: 'raft', label: 'Check the raft', detail: 'Review the launch preparations.' },
      { id: 'course', label: 'Review the course', detail: "Recall Calypso's sailing directions." },
    ],
  }, turnId);
}
function comparison(key = 'ogygia') {
  block({ kind: 'comparison', corner: '', columns: [{ label: 'Supplies', tone: 'teal' }, { label: 'Sailing directions', tone: 'gold' }], rows: [
    { label: 'Purpose', cells: ['Water and provisions', 'A course toward Scheria'] },
    { label: 'Review', cells: ['Passage supplies', "Calypso's directions"] },
    { label: 'Record', cells: ['Raft preparations', 'Voyage plan'] },
  ] }, key);
}
const scenarioPrompts: Record<string, string> = {
  crew: 'Show the crew ledger.', decision: 'Compare Scylla and Charybdis.', household: 'What is happening in Ithaca?',
  forecast: 'Recall the forecast and the oath.', library: 'Find the records for the crossing.', diagram: 'Show the departure diagram.',
};
function archive(key = 'ogygia') {
  ui.stores.chat.getState().requestToolApproval(key, 'archive-checklist', 'brain_archive', { slug: 'raft-supply-checklist' }, 'Archive the completed raft supply checklist. This is a fictional, staged permission request.', 'tool', false);
}
function seed(next: string, key = 'ogygia') {
  scene = next; generation++;
  // The exterior Reset starts fresh demonstration state, outside product navigation.
  const trackers = (ui.stores as unknown as { trackers?: { setState(state: object): void } }).trackers;
  trackers?.setState({ records: {}, evidence: {}, unconfirmed: {}, createdFor: {}, refusedRequests: [], acceptedRequests: [], reading: {} });
  const chat = ui.stores.chat.getState();
  chat.clearMessages();
  const buffers = { ...ui.stores.chat.getState().buffers };
  delete buffers[key];
  ui.stores.chat.setState({ buffers });
  chat.setActiveSession(key); chat.setSessionBackend(key, 'pi');
  ui.stores.voice.setState({ reviewText: '', mode: 'idle' });
  ui.stores.ui.getState().setFilePanelOpen(false);
  ui.stores.file.getState().closeFile();
  ui.stores.ui.getState().setActiveView(next === 'work' ? 'activity' : 'chat');
  if (next === 'work') {
    ui.stores.activity.setState({ supported: true });
    ui.stores.activity.getState().applySnapshot({ type: 'activity_snapshot', view: 'index', spans: workSpans, events: [], highWaterSeq: { 'departure-review': 0 } });
    location.hash = '#/activity/departure-review';
    return;
  }
  location.hash = '';
  if (scenarioPrompts[next]) {
    chat.addUserMessage(key, scenarioPrompts[next], 'typed');
    respond(scenarioPrompts[next], key, `fixture-turn-${++turn}`);
    return;
  }
  const text = next === 'rank' ? 'Help me prioritise the final preparations.' : next === 'rich' ? 'Show me the departure plan.' : next === 'approval' ? 'Archive the completed raft supply checklist.' : 'What should I prepare before leaving Ogygia?';
  chat.addUserMessage(key, text, 'typed'); chat.startAssistantMessage(key, `fixture-turn-${++turn}`);
  chat.appendText(key, next === 'rank' ? 'The raft is ready to launch. Put the remaining preparations in the order that matters to you.' : next === 'rich' ? "The raft is ready. Here's the plan for leaving Ogygia." : next === 'approval' ? 'The completed checklist can be archived. This action needs your permission.' : 'Your raft is ready. These are the two preparations to review before launch.');
  if (next === 'rank') rank(key);
  else if (next === 'approval') archive(key);
  else { if (next === 'rich') rich(key); else comparison(key); chat.finishAssistantMessage(key); }
  if (next === 'voice') ui.stores.voice.setState({ reviewText: 'Check the water and provisions before launching the raft.', mode: 'idle' });
  if (next === 'files') { ui.stores.ui.getState().setFilePanelOpen(true); void ui.stores.file.getState().openFile('voyage/ogygia/departure-plan.md'); }
}
function respond(text: string, key: string, turnId: string) {
  const chat = ui.stores.chat.getState();
  chat.startAssistantMessage(key, turnId);
  if (/scylla|charybdis/i.test(text)) { chat.appendText(key, 'The recorded choice was Scylla. Six men were lost; those losses are included in the closed crew ledger. Read [[decisions/scylla-or-charybdis]] for the reasoning and the unresolved questions.'); block(corpusBlocks.decision, key); chat.finishAssistantMessage(key); }
  else if (/crew|ledger|manifest/i.test(text)) { chat.appendText(key, 'Six hundred crew embarked in twelve ships. None survived; Odysseus is the sole survivor. This is the historical ledger, not a crew for the new crossing. Read [[crew/manifest-0012]].'); block(corpusBlocks.crew, key); chat.finishAssistantMessage(key); }
  else if (/ithaca|penelope|telemachus|household/i.test(text)) { chat.appendText(key, '[[people/penelope]] holds the household in Ithaca. [[people/telemachus]] is seeking news in Sparta. Return remains the goal: [[goals/return-to-ithaca]]. These are fictional records, not live messages.'); chat.finishAssistantMessage(key); }
  else if (/forecast|oath|helios/i.test(text)) { chat.appendText(key, 'Teiresias warned against touching the cattle of Helios. The oath was broken on Thrinacia; the remaining crew died in the storm. Read [[knowledge/teiresias-forecast]], [[oaths/helios]] and [[decisions/cattle-of-helios]].'); chat.finishAssistantMessage(key); }
  else if (/diagram|sequence/i.test(text)) { chat.appendText(key, `The next landfall is planned, not reported. The sequence is also in [passage.mmd](voyage/ogygia/passage.mmd).\n\n\`\`\`mermaid\n${departureDiagram}\n\`\`\``); chat.finishAssistantMessage(key); }
  else if (/files|records|library|notes/i.test(text)) { chat.appendText(key, 'These records connect the current departure to the earlier voyage. Open a file to read its body, metadata and related notes.'); if (supportingFilesBlock) block(supportingFilesBlock, key); else chat.appendText(key, '\n\n- [[voyage/ogygia/departure-plan]] — The plan, supplies and open questions.\n- [[crew/manifest-0012]] — The historical crew ledger.\n- [[decisions/scylla-or-charybdis]] — The decision and its recorded cost.'); chat.finishAssistantMessage(key); }
  else if (/checklist/i.test(text) && !/archiv/i.test(text)) { chat.appendText(key, 'The raft build is complete. Water and provisions still need review. See [[voyage/ogygia/raft]].'); block(corpusBlocks.steps, key); chat.finishAssistantMessage(key); }
  else if (/priorit|rank|decid|order/i.test(text)) { chat.appendText(key, 'Choose the order that matters to you.'); rank(key, turnId); }
  else if (/archiv/i.test(text)) { chat.appendText(key, 'This staged archive needs your permission.'); archive(key); }
  else if (/plan|map|voyage|course/i.test(text)) { chat.appendText(key, "Here's the staged departure plan."); rich(key); chat.finishAssistantMessage(key); }
  else if (/water|provision|raft|prepare/i.test(text)) { chat.appendText(key, 'Water, provisions and the launch preparations belong together. Here is the fictional preparation comparison.'); comparison(key); chat.finishAssistantMessage(key); }
  else { chat.appendText(key, 'This demo has prepared Odyssey responses. Try “show the plan”, “crew ledger”, “Scylla”, “files”, “departure diagram”, “prioritise preparations”, or “archive the checklist”. Your text stays in this page; no model is running.'); chat.finishAssistantMessage(key); }
}
function Surface() {
  const view = useUIStore(state => state.activeView);
  return <><div style={{ display: view === 'chat' ? 'contents' : 'none' }}><ChatPage /></div>{view === 'activity' ? <ActivityPage /> : view === 'graph' ? <GraphPage /> : null}</>;
}
seed(scene);
createRoot(document.getElementById('app')!).render(<AppErrorBoundary><BrainUiProvider root={ui}><AppShell><Surface /></AppShell></BrainUiProvider></AppErrorBoundary>);
ready = true;
window.parent.postMessage({ type: 'brain-demo-ready' }, location.origin);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== location.origin) return;
  if (event.data?.type === 'brain-demo-scene' && ready && ['rank', 'rich', 'comparison', 'work', 'voice', 'approval', 'files'].includes(event.data.scene)) seed(event.data.scene);
  if (event.data?.type === 'brain-demo-theme') ui.stores.ui.getState().setTheme(event.data.theme === 'dark' ? 'dark' : 'light');
});
// Do not request device access or send visitor uploads in a marketing simulation.
document.addEventListener('click', event => {
  const target = (event.target as Element).closest('button,input');
  const name = `${target?.getAttribute('aria-label') || ''} ${target?.getAttribute('title') || ''} ${target?.getAttribute('type') || ''}`;
  if (/microphone|dictat|append more voice|start recording|attach|upload|push notification|enable push/i.test(name)) { event.preventDefault(); event.stopImmediatePropagation(); announce('Device access is outside this demo. Choose Capture to review staged dictation.'); }
}, true);
window.addEventListener('pagehide', () => ui.dispose(), { once: true });
window.addEventListener('keydown', event => { if (event.key === 'Escape') window.parent.postMessage({ type: 'brain-demo-escape' }, location.origin); });

// Offline authoring harness. The published demo never needs this catalogue
// walk; it builds exact export inputs through the product's own share helpers.
if (params.get('catalogue') === '1') Object.assign(window, { __brainDemoCatalogue: async () => {
  const { shareMarkdown, renderBlockHtml, inlineMermaidDiagrams, splitFrontmatter, buildDiagramShareOptions, runStats } = await import('@schlessera/brain-ui-react');
  const requests: RenderRequest[] = [];
  async function messages() {
    for (const message of ui.stores.chat.getState().buffers.ogygia?.messages || []) {
      if (message.role !== 'assistant' || !message.content?.trim()) continue;
      requests.push({ content: await shareMarkdown(message, { renderBlock: block => renderBlockHtml(block), inlineMermaid: inlineMermaidDiagrams }), contentType: 'markdown', format: 'png', title: ui.config.shareTitle });
    }
  }
  const orders = [['supplies', 'raft', 'course'], ['supplies', 'course', 'raft'], ['raft', 'supplies', 'course'], ['raft', 'course', 'supplies'], ['course', 'supplies', 'raft'], ['course', 'raft', 'supplies']];
  const socket = new FixtureSocket();
  for (const next of ['rank', 'approval', 'rich', 'comparison', 'voice', ...Object.keys(scenarioPrompts)]) { seed(next); await messages(); }
  for (const prefix of ['initial', 'prompt']) {
    for (const order of orders) {
      seed('rank');
      if (prefix === 'prompt') respond('prioritise preparations', 'ogygia', `fixture-turn-${++turn}`);
      socket.send(JSON.stringify({ type: 'ask_user_rank_response', sessionId: 'ogygia', order }));
      await messages();
    }
    for (const accepted of [true, false]) {
      seed('approval');
      if (prefix === 'prompt') respond('archive the checklist', 'ogygia', `fixture-turn-${++turn}`);
      socket.send(JSON.stringify({ type: accepted ? 'tool_approval' : 'tool_denial' }));
      await new Promise(resolve => setTimeout(resolve, 150));
      await messages();
    }
  }
  for (const prompt of ['show the plan', 'water and provisions', 'checklist', 'not a prepared prompt', ...Object.values(scenarioPrompts)]) { seed('comparison'); respond(prompt, 'ogygia', `fixture-turn-${++turn}`); await messages(); }
  seed('comparison');
  await runStats(ui, 'ogygia'); await messages();
  for (const record of demoDocuments) {
    if (record.kind === 'text') continue;
    requests.push({ content: record.kind === 'markdown' ? await inlineMermaidDiagrams(splitFrontmatter(record.content).body) : record.content, contentType: record.kind, format: 'png', title: record.path.split('/').at(-1) });
  }
  // Capture the standalone diagram's PNG and PDF requests independently:
  // their real helper applies different crop/page-flow styles.
  const recordingRoot = { ...ui, request: async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(new Uint8Array(), { headers: { 'Content-Type': 'image/png' } });
  } };
  for (const option of buildDiagramShareOptions(recordingRoot, departureDiagram)) if (option.id === 'image' || option.id === 'pdf') await option.run();
  socket.close();
  return requests;
} });
