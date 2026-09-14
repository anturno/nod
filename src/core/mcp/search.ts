/** Lexical search over MCP tool catalogs, bounded output, and rank-ordered schema auto-selection. */
import { MAX_SEARCH_MATCHES } from "./limits.ts";
import type { McpToolDef } from "./types.ts";

export type SearchCandidate = {
  alias: string;
  server: string;
  tool: McpToolDef;
  instructions?: string;
  /** Bytes of the schema JSON the model would receive when this tool is selected. */
  schemaBytes: number;
};

export type SearchLimits = { descriptionBytes: number; resultBytes: number; selectedSchemaBytes: number };

export const SCHEMA_BUDGET_NOTICE =
  "[context] Additional MCP schemas exceed the search loading budget; narrow the search or select a tool explicitly.";

export const tokenize = (text: string): string[] => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  ),
];

const schemaProperties = (schema: Record<string, unknown>): string[] => {
  const props = schema.properties;
  return typeof props === "object" && props !== null ? Object.keys(props) : [];
};

/** name ×3, description ×2, schema property names ×1, server instructions ×1, summed over query tokens. */
export function scoreCandidate(query: string, c: SearchCandidate): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  const names = [c.alias, c.tool.name, c.tool.title ?? "", c.server].join(" ").toLowerCase();
  const description = c.tool.description.toLowerCase();
  const props = schemaProperties(c.tool.inputSchema).join(" ").toLowerCase();
  const instructions = (c.instructions ?? "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (names.includes(t)) score += 3;
    if (description.includes(t)) score += 2;
    if (props.includes(t)) score += 1;
    if (instructions.includes(t)) score += 1;
  }
  return score;
}

export const truncateBytes = (text: string, max: number): string => {
  if (Buffer.byteLength(text) <= max) return text;
  return new TextDecoder().decode(Buffer.from(text).subarray(0, max)).replace(/�+$/, "");
};

export type SearchResult = { output: string; matches: SearchCandidate[]; selected: string[]; notice?: string };

export function searchTools(query: string, candidates: SearchCandidate[], limits: SearchLimits): SearchResult {
  const scored = candidates
    .map((c) => ({ c, score: scoreCandidate(query, c) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.c.alias.localeCompare(b.c.alias));
  const total = scored.length;
  const matches = scored.slice(0, MAX_SEARCH_MATCHES).map((s) => s.c);
  const render = (shown: SearchCandidate[], omitted: number, observed: number) => {
    const doc: Record<string, unknown> = {
      tools: shown.map((c) => ({
        name: c.alias,
        server: c.server,
        description: truncateBytes(c.tool.description, limits.descriptionBytes),
      })),
      count: shown.length,
      total_matches: total,
      more_available: false,
      next_cursor: null,
    };
    if (omitted > 0)
      doc.context_limit = {
        name: "mcp_search_result_bytes",
        action: "omitted",
        omitted_count: omitted,
        observed_bytes: observed,
        effective_bytes: limits.resultBytes,
        override: "--context-limit mcp_search_result_bytes=BYTES|off",
      };
    return JSON.stringify(doc);
  };
  let output = render(matches, 0, 0);
  const observed = Buffer.byteLength(output);
  let shown = matches.length;
  while (Buffer.byteLength(output) > limits.resultBytes && shown > 0)
    output = render(matches.slice(0, --shown), matches.length - shown, observed);

  const selected: string[] = [];
  let notice: string | undefined;
  let remaining = limits.selectedSchemaBytes;
  for (const c of matches.slice(0, shown)) {
    if (c.schemaBytes > remaining) {
      notice = SCHEMA_BUDGET_NOTICE;
      break;
    }
    remaining -= c.schemaBytes;
    selected.push(c.alias);
  }
  return { output, matches: matches.slice(0, shown), selected, notice };
}
