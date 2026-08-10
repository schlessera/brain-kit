import type { Chunk } from "./types.js";

const MIN_TOKENS = 100;
const MAX_TOKENS = 1000;

/**
 * Estimate token count from text length.
 * Rough heuristic: ~4 characters per token.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ChunkInput {
  title: string;
  content: string;
  documentId: number;
}

interface Section {
  heading: string;
  content: string;
}

/**
 * Split markdown content into sections by ## headings.
 * Tracks fenced code blocks so a `## ` line inside a fence is content,
 * not a section boundary.
 */
function splitBySections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentHeading = "(intro)";
  let currentLines: string[] = [];
  let fenceChar: string | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (fenceChar === null) fenceChar = char;
      else if (fenceChar === char) fenceChar = null;
      currentLines.push(line);
      continue;
    }
    if (fenceChar !== null) {
      currentLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      // Save previous section if it has content
      const sectionContent = currentLines.join("\n").trim();
      if (sectionContent) {
        sections.push({ heading: currentHeading, content: sectionContent });
      }
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Save final section
  const sectionContent = currentLines.join("\n").trim();
  if (sectionContent) {
    sections.push({ heading: currentHeading, content: sectionContent });
  }

  return sections;
}

/**
 * Split a large section at paragraph boundaries to stay under MAX_TOKENS.
 */
function splitLargeSection(section: Section): Section[] {
  const paragraphs = section.content.split(/\n\n+/);
  const result: Section[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let partIndex = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (currentTokens + paraTokens > MAX_TOKENS && current.length > 0) {
      const heading = partIndex === 0
        ? section.heading
        : `${section.heading} (cont.)`;
      result.push({ heading, content: current.join("\n\n") });
      current = [];
      currentTokens = 0;
      partIndex++;
    }

    current.push(para);
    currentTokens += paraTokens;
  }

  if (current.length > 0) {
    const heading = partIndex === 0
      ? section.heading
      : `${section.heading} (cont.)`;
    result.push({ heading, content: current.join("\n\n") });
  }

  return result;
}

/**
 * Deterministic markdown chunking by ## headings.
 *
 * - Splits content by ## headings into sections
 * - Merges small sections (<100 tokens) with the next section
 * - Splits large sections (>1000 tokens) at paragraph boundaries
 */
export function chunkDocument(input: ChunkInput): Omit<Chunk, "id">[] {
  const sections = splitBySections(input.content);

  if (sections.length === 0) {
    return [];
  }

  // Phase 1: merge small sections with the next section
  const merged: Section[] = [];
  let i = 0;

  while (i < sections.length) {
    const section = sections[i];
    const tokens = estimateTokens(section.content);

    if (tokens < MIN_TOKENS && i + 1 < sections.length) {
      // Merge with the next section
      const next = sections[i + 1];
      sections[i + 1] = {
        heading: next.heading,
        content: `${section.heading !== "(intro)" ? `## ${section.heading}\n\n` : ""}${section.content}\n\n${next.content}`,
      };
      i++;
      continue;
    }

    merged.push(section);
    i++;
  }

  // Phase 2: split large sections at paragraph boundaries
  const final: Section[] = [];
  for (const section of merged) {
    const tokens = estimateTokens(section.content);
    if (tokens > MAX_TOKENS) {
      final.push(...splitLargeSection(section));
    } else {
      final.push(section);
    }
  }

  // Phase 3: convert to Chunk objects
  return final.map((section, index) => ({
    document_id: input.documentId,
    chunk_index: index,
    heading: section.heading,
    content: section.content,
    token_estimate: estimateTokens(section.content),
  }));
}

/**
 * Format chunk text for embedding, prepending title, heading, and (when
 * available) an LLM-generated context blurb situating the chunk in its
 * document (contextual retrieval).
 */
export function chunkTextForEmbedding(
  title: string,
  heading: string,
  content: string,
  context?: string | null
): string {
  const contextLine = context ? `${context}\n` : "";
  return `[${title}] [${heading}]\n${contextLine}${content}`;
}
