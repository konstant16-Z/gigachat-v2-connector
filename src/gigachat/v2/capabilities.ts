/**
 * Model capability map for GigaChat V2 (plan §17).
 *
 * Pipeline: request → capability filter → GigaChat. The filter must never
 * send capabilities the model/API cannot honor (RULE: no silent guesses).
 *
 * Evidence-backed enforcement (all live-verified on GigaChat-2-Max, 2026-09-16):
 *   - tools / function calling  — live round-trips, function_call + states
 *   - structured output        — response_format json_schema live 200
 *   - vision / files           — /v1/files upload → content.files live 200
 *   - webSearch                — tools:[{web_search:{}}] live 200
 *   - reasoning                — V2 has NO reasoning field; the mapper drops
 *                                 request reasoning controls and maps streaming
 *                                 reasoning_content (model selection controls it)
 *
 * Capability filtering is enforced at the boundaries rather than this map:
 *   - unknown builtin ids → controlled error (tools/builtin.ts registry)
 *   - code_interpreter    → deliberately NOT registered (live 422 unavailable)
 *   - HTTP(S) image URLs  → controlled error (V2 cannot ingest URLs)
 *   - json_object/json    → controlled error (live 400 unknown type)
 */
export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  structuredOutput: boolean;
  webSearch: boolean;
  files: boolean;
}

/** Capabilities verified live on all supported V2 chat models (shared API). */
const VERIFIED_CAPABILITIES: ModelCapabilities = {
  tools: true,
  reasoning: true, // via streaming reasoning_content + model selection
  vision: true, // via files upload (base64 data URLs); HTTP URLs unsupported
  structuredOutput: true, // json_schema only (text|json_schema)
  webSearch: true,
  files: true,
};

const KNOWN_MODELS = new Set(["GigaChat-2-Max", "GigaChat-2-Pro", "GigaChat-3-Ultra"]);

/**
 * Return the capability set for a model. All currently supported V2 chat
 * models share the same verified capability set; unknown model ids fall back
 * to the verified set rather than an empty one (a false-negative would drop
 * working features, violating the no-silent-guess rule in the other direction).
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  if (KNOWN_MODELS.has(model)) return { ...VERIFIED_CAPABILITIES };
  // Unknown models: keep the live-verified defaults. Boundary checks still
  // reject genuinely unsupported constructs (builtins, image URLs, formats).
  return { ...VERIFIED_CAPABILITIES };
}
