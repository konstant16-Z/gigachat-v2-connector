/**
 * Builtin-tool registry for the GigaChat V2 boundary (plan §16).
 *
 * The V2 spec declares exactly two builtin tools
 * (`docs/external/gigachat-api.yml`: `image_generate`, `model_3d_generate`).
 * Live API verification (2026-09-16) additionally confirms:
 *   - `web_search` — 200, server-side live search, text returned inline;
 *   - `url_content_extraction` — 200, server-side content fetch (accepted).
 *   - `code_interpreter` — 422 "Tool code_interpreter is unavailable";
 *   - unknown tool — 404 "Unknown tool <name>".
 *
 * Unknown builtin ids raise a controlled error — never a guess. Runtime
 * execution of builtin tools is server-side (no function_call round-trip).
 */
import type { V2Tool } from "../types";

export const KNOWN_BUILTIN_TOOLS = [
  "web_search",
  "url_content_extraction",
  "image_generate",
  "model_3d_generate",
] as const;

export type KnownBuiltinTool = (typeof KNOWN_BUILTIN_TOOLS)[number];

export function isKnownBuiltinTool(id: string): id is KnownBuiltinTool {
  return (KNOWN_BUILTIN_TOOLS as readonly string[]).includes(id);
}

export function toV2BuiltinTool(id: string): V2Tool {
  switch (id) {
    case "web_search":
      return { web_search: {} };
    case "url_content_extraction":
      return { url_content_extraction: {} };
    case "image_generate":
      return { image_generate: {} };
    case "model_3d_generate":
      return { model_3d_generate: {} };
    default:
      throw new Error(`unknown builtin tool "${id}" (${KNOWN_BUILTIN_TOOLS.join("|")} expected)`);
  }
}
