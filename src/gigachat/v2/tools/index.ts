/**
 * GigaChat V2 tool boundary modules (plan §9-11 "tools").

 * - `normalize.ts` — spec-valid function-name validation + session-scoped
 *   aliasing registry (replaces the legacy global toolRegistry).
 * - `function.ts` — CustomFunction shaping (spec-required name/parameters).
 * - `builtin.ts` — builtin tool wire entries (web_search, url_content_extraction, image_generate, model_3d_generate).
 * - `parallel.ts` — parallel tool-call linkage (tool_1 → result_1 invariant).
 * - `state.ts` — session-scoped in-memory `tools_state_id` store.
 */

export * from "./builtin";
export * from "./function";
export * from "./normalize";
export * from "./parallel";
export * from "./state";
