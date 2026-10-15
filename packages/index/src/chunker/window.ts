import { type ParseResult, type ParsedChunk } from "../types.ts";

const WINDOW_LINES = 40;
const STRIDE = 20;

/**
 * Fallback chunker for files we don't have a grammar for. Produces
 * overlapping line windows so BM25 can still match across boundaries.
 * No symbols, no refs — pure text lift.
 */
export const windowChunker = (source: string): ParseResult => {
  const lines = source.split(/\r?\n/);
  const chunks: ParsedChunk[] = [];
  if (lines.length === 0) return { chunks, symbols: [] };
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    chunks.push({
      kind: "window",
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join("\n"),
    });
    if (end >= lines.length) break;
    start += STRIDE;
  }
  return { chunks, symbols: [] };
};
