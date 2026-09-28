/**
 * Jev reranker — built-in Reranker #1 (TypeSafe System One, direct fetch, no
 * SDK dependency).
 *
 * One Choice question over the candidate ids per search: the pool goes into
 * `state` as {title, type, tags, summary, excerpt, …attributes} entries, the
 * model returns a probability per id, and the ordering is those
 * probabilities descending. A brain's attributes are its lifecycle fields
 * (status, relevance, updated), so the judgment weighs a draft or a
 * historical document as one.
 *
 * Measured with `brain eval` on a 1,133-document brain (0.39 pipeline, 27
 * hand-written and 83 development queries, pool 20): hit@1 on the hybrid
 * lane 0.556 → 0.741 (hand) and 0.675 → 0.807 (development) against
 * retrieval order, where the lifecycle multipliers alone score 0.407 and
 * 0.494. One request per search, about 7k input tokens, p50 under a second.
 *
 * What was tried and lost, so it is not re-added without a new measurement:
 * pairwise Noul judgments (worse at 30× the calls), a second pass over the
 * top 8–12 with document bodies, decomposed sub-judgments, type-first routing
 * (hit@10 0.963 → 0.852: a wrong filter removes the answer for good), and
 * sending document heads instead of the retrieval excerpt (−0.074 hit@1).
 * Evidence quality is about query-conditioning, not volume: the excerpt is
 * the span the retriever already matched, and unconditioned text dilutes it.
 */

import { readEnvVar } from "../../config/env.js";
import { JEV_MODEL } from "../../lib/llm-defaults.js";
import type { Ranked, RerankCandidate, Reranker, RerankRequest } from "../../lib/seams.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";

/** A Choice accepts at most 255 options (the API answers 400 beyond that). */
const MAX_OPTIONS = 255;
/**
 * Per-candidate text caps. Summary and excerpt carried the whole gain in the
 * evidence ablation; longer fields only cost tokens.
 */
const SUMMARY_CHARS = 300;
const EXCERPT_CHARS = 400;
const TITLE_CHARS = 200;
/**
 * The request budget is ~32k tokens shared by state and question. 50 full
 * candidates are ~7.4k tokens; this cap (≈15k tokens at 4 chars/token) leaves
 * room for the 255-option worst case without ever tripping the hard limit.
 */
const MAX_STATE_CHARS = 60_000;

/**
 * The question wording was measured too (same pools, same evidence): naming
 * the situation plus the one failure mode to avoid beat a plain question by
 * 0.037 hit@1, and every variant that piled on more guidance (a role
 * statement, a "prefer the title" hint, a terse directive) did worse.
 */
function instructions(multiSource: boolean) {
  return {
    situation:
      "A person is searching their own personal knowledge base: notes, project files, " +
      "people, trips, talks, opinions and assets they wrote or collected themselves. " +
      "The search engine retrieved the candidate documents in `candidates` for the " +
      "query in `query`. Each candidate gives the document's title, type, tags, " +
      "one-line summary and the passage the retriever matched" +
      (multiSource ? "; `source` names the store it came from." : "."),
    question: "Which candidate is the document this person is looking for?",
    caution:
      "Prefer the document that is specifically about the subject of the query over " +
      "an index, registry, overview or dashboard page that merely lists or links to it.",
  };
}
type Instructions = ReturnType<typeof instructions>;

export interface JevRerankerConfig {
  /** Model id (default: the pinned JEV_MODEL — thresholds do not transfer across versions). */
  model?: string;
  /** Env var holding the API key (default: TYPESAFE_API_KEY). */
  apiKeyEnv?: string;
  /** API endpoint override. */
  baseUrl?: string;
  /** Injectable fetch — keyless contract tests stub the network with it. */
  fetch?: typeof fetch;
}

interface Candidate {
  id: string;
  source?: string;
  title: string;
  type: string;
  tags: string;
  summary: string;
  excerpt: string;
  /** The candidate's attributes (status, relevance, updated, …), flattened. */
  [attribute: string]: string | number | boolean | null | undefined;
}

/** Keys an attribute may not take over: the fields every candidate has. */
const RESERVED = new Set(["id", "source", "title", "type", "tags", "summary", "excerpt"]);
/** Bounds on what attributes may add per candidate, so they cannot crowd the budget. */
const MAX_ATTRIBUTES = 8;
const ATTRIBUTE_CHARS = 100;

/** A candidate's attributes as flat state fields: reserved keys dropped, values bounded. */
function clipAttributes(attributes: RerankCandidate["attributes"]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes).slice(0, MAX_ATTRIBUTES + RESERVED.size)) {
    if (RESERVED.has(key) || Object.keys(out).length >= MAX_ATTRIBUTES) continue;
    out[key] = typeof value === "string" ? clip(value, ATTRIBUTE_CHARS) : value;
  }
  return out;
}

interface JevRequest {
  model: string;
  state: { query: string; candidates: Candidate[] };
  questions: {
    ranking: {
      type: "choice";
      instructions: Instructions;
      criteria: Record<string, string>;
    };
  };
}

interface RankingAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface JevResponse {
  model?: string;
  answers?: { ranking?: RankingAnswer };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function candidateId(i: number): string {
  return "C" + String(i + 1).padStart(3, "0");
}

function cleanExcerpt(text: string | undefined): string {
  return (text ?? "").replace(/>>>|<<</g, "");
}

/**
 * Build the request for the first MAX_OPTIONS candidates. Returns how many
 * were included so the caller can append the rest in retrieval order.
 */
export function buildJevRequest<C extends RerankCandidate>(
  model: string,
  req: Omit<RerankRequest<C>, "signal">
): { body: JevRequest; included: number } {
  const pool = req.candidates.slice(0, MAX_OPTIONS);
  // `source` is evidence only when the pool spans several stores; on a
  // single-source pool it is a constant field that costs tokens and says
  // nothing.
  const multiSource = new Set(pool.map((c) => c.source ?? "")).size > 1;
  const candidates: Candidate[] = [];
  const criteria: Record<string, string> = {};
  let chars = req.query.length;
  for (let i = 0; i < pool.length; i++) {
    const r = pool[i];
    const c: Candidate = {
      id: candidateId(i),
      ...(multiSource && r.source ? { source: r.source } : {}),
      title: clip(r.title, TITLE_CHARS),
      type: r.type ?? "",
      tags: clip(r.tags, 200),
      summary: clip(r.summary, SUMMARY_CHARS),
      // FTS snippets carry `>>>`/`<<<` match markers; the model does not need them.
      excerpt: clip(cleanExcerpt(r.excerpt), EXCERPT_CHARS),
      ...clipAttributes(r.attributes),
    };
    const cost = JSON.stringify(c).length + c.title.length;
    if (chars + cost > MAX_STATE_CHARS) break;
    chars += cost;
    candidates.push(c);
    criteria[c.id] = c.title;
  }
  return {
    body: {
      model,
      state: { query: req.query, candidates },
      questions: { ranking: { type: "choice", instructions: instructions(multiSource), criteria } },
    },
    included: candidates.length,
  };
}

/**
 * Turn the answer into an ordering of the included candidates. Every included
 * id must come back with a finite probability — a typed answer is not a true
 * answer, and a partial distribution would silently bury whatever it omitted.
 */
export function orderFromAnswer<C extends RerankCandidate>(
  included: readonly C[],
  answer: RankingAnswer | undefined
): Ranked<C>[] {
  if (!answer || answer.type !== "choice" || !answer.probabilities || typeof answer.probabilities !== "object") {
    throw new Error("malformed answer: expected a choice with probabilities");
  }
  const probs = answer.probabilities;
  const scored = included.map((item, i) => {
    const p = probs[candidateId(i)];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`malformed answer: no probability for candidate ${candidateId(i)}`);
    }
    return { item, score: p, i };
  });
  // Stable by construction: ties fall back to retrieval order.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map(({ item, score }) => ({ item, score }));
}

/**
 * Create a Jev-backed Reranker. Constructing it makes no network call; the
 * key is read on first rerank(). A single attempt per search: retrying inside
 * an interactive deadline only delays the fallback to retrieval order.
 */
export function jevReranker(config: JevRerankerConfig = {}): Reranker {
  const model = config.model ?? JEV_MODEL;
  const apiKeyEnv = config.apiKeyEnv ?? JEV_API_KEY_ENV;
  const url = config.baseUrl ?? API_URL;
  const doFetch = config.fetch ?? fetch;

  return {
    id: `jev:${model}`,
    capabilities: { modes: ["fts", "vector", "hybrid"], network: true },

    preview(req) {
      const { body } = buildJevRequest(model, req);
      return { url, apiKeyEnv, ...body };
    },

    async rerank(req) {
      const apiKey = readEnvVar(apiKeyEnv);
      if (!apiKey) throw new Error(`${apiKeyEnv} environment variable is required for the jev reranker`);
      if (req.candidates.length < 2) return req.candidates.map((item) => ({ item, score: 1 }));

      const { body, included } = buildJevRequest(model, req);
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 200);
        const err = new Error(`TypeSafe API error ${res.status}${text ? `: ${text}` : ""}`);
        (err as Error & { status: number }).status = res.status;
        throw err;
      }
      const data = (await res.json()) as JevResponse;
      const ordered = orderFromAnswer(req.candidates.slice(0, included), data.answers?.ranking);
      // Anything past the option cap or the state budget was never judged:
      // it stays in retrieval order after the judged block, below every
      // judged probability.
      return ordered.concat(req.candidates.slice(included).map((item) => ({ item, score: -1 })));
    },
  };
}
