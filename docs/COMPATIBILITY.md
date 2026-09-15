# Compatibility Matrix (V2 Target)

This matrix compares the **current V1‑translation behavior** (as-is connector) with the **target V2 behavior** defined by the official GigaChat API V2 contract (see `docs/V2-CONTRACT.md`).  
Statuses follow the definitions from the plan:

- `SUPPORTED` – current implementation already matches V2 (no change needed).  
- `UNSUPPORTED` – feature is not present in current implementation and requires work to match V2.  
- `MIGRATE` – feature exists but must be changed (mapping, structure, or semantics) to reach V2.  
- `PARTIAL` – some aspects work, but not fully compliant (e.g., streaming works but events differ).  
- `LEGACY` – feature will be removed after V2 is stable (kept only for rollback).  
- `BLOCKED` – cannot be implemented without breaking change or missing API detail.

**Important**: A status may only be set to `SUPPORTED` or `PARTIAL` after there is **evidence** (tests, API verification) that the behavior matches. Until then, treat as `UNSUPPORTED`.

| Capability | Current (V1‑translation) | Target (V2) | Status | Evidence / Notes |
|---|---|---|---|---|
| Chat (non‑stream) | `POST /api/v1/chat/completions` | `POST /v2/chat/completions` | `MIGRATE` | Endpoint and server differ; host mapping in `plugin.ts` must be updated. |
| Streaming (SSE) | SSE via `makeSseTransformer` (passthrough malformed, `[DONE]` passthrough) | SSE with events `response.message.delta`, `response.message.done`, `response.tool.in_progress`, `response.tool.completed`; no `[DONE]` | `PARTIAL` | Mapping layer delivered (`src/streaming/`, unit-tested); live-verified 2026-09-15: payloads nest the message under `messages:[...]` and tools `function_call` arrives in `done.messages` — handled (see live-verification section below). |
| Function tools | `functions` + `function_call` (top‑level) | `tools` array (oneOf) + `tool_config.mode` + `functions` inside `ToolsFunctions`; results use role `function`; `function_call.arguments` is an object | `MIGRATE` | Structure changed; live-verified 2026-09-15: `role:"tool"` → 400 and a string `arguments` → 400, so the request mapper emits role `function` and object arguments. |
| Parallel tools | `pendingCalls` pairs (assistant + function) | Same semantics (V2 does not forbid parallel tool calls) – relies on correct pairing via `tool_state_id`/`message.id` | `SUPPORTED` (current) | The fix for parallel tool calls is already in the connector (see `translator.ts`). No V2 change required for pairing logic. |
| Tool state | `functions_state_id` (verbatim passthrough) | request: `functions_state_id`; response: `tool_state_id` | `MIGRATE` | Live-verified 2026-09-15: request field is `functions_state_id` on assistant messages; response field is `tool_state_id` (singular; spec's `tools_state_id` also read as a fallback). Session store delivered (see "PHASE 4" below). |
| Tool IDs | SSE: stable per‑stream IDs; JSON: fresh `call_<uuid>` | V2 `function_call` carries a live-returned `id` (spec: none); streaming assigns stable sequential ids (`call_1`, …) per stream; JSON keeps the live id and only generates one when absent; linking tool→result relies on `tool_state_id` | `MIGRATE` | Live-verified 2026-09-15: responses include `function_call.id`, and requests accept an optional id; mapping preserves it (`gigachat-v2-to-normalized.ts`). Identity invariance (`tool_1 → result_1`) enforced by `verifyToolLinkage` (see "PHASE 4" below). |
| Reasoning | `reasoning_effort`/`thinking` → CoT system prompt | No explicit reasoning field; reasoning likely controlled via model selection (e.g., `GigaChat-3-Ultra` for reasoning) | `MIGRATE` | Remove CoT prompts; rely on model choice. |
| Structured output | `response_format: {type:"json"|"json_schema"}` (only if no tools) | `model_options.response_format` (same structure) | `MIGRATE` | Move from top level to `model_options`. |
| Vision (images) | base64 → upload to `/api/v2/files` → `attachments: [file_id]` | `content.files` with `id` (presumably pre‑uploaded); base64 still needs upload step | `PARTIAL` | Upload logic likely unchanged; only destination of `id` changes (from `attachments` to `content.files`). |
| Files (general) | `purpose: "general"` → `attachments: [file_id]` | `content.files` with `id` | `MIGRATE` | Change where file IDs appear. |
| Web search (builtin) | – | V2 builtin (P1) – not present in current connector | `UNSUPPORTED` | Requires implementation of built‑in tool `web_search` (if exposed via GigaChat). |
| URL extraction (builtin) | – | V2 builtin (P1) | `UNSUPPORTED` | Same as above. |
| Code interpreter / image / 3D | – | P2/P3 (e.g. `model_3d_generate` is already a built‑in tool) | `UNSUPPORTED` / `PARTIAL` | `model_3d_generate` appears in spec as built‑in; connector does not yet expose it. |
| MCP | not altered by plugin (passes through as `tool_calls`) | preserved | `PARTIAL` | No plugin changes needed; ensure tool names are not mangled incorrectly. |
| Auth OAuth2 | `POST /api/v2/oauth` (Basic, RqUID) | unchanged | `SUPPORTED` | Already V2. |
| TLS | Built‑in Russian Trusted Root CA + external file | unchanged | `SUPPORTED` | No change needed. |
| Errors | JSON `error.message`, SSE passthrough | Structured error fields? (spec shows same JSON error shape) | `PARTIAL` | Need to verify error format matches; currently pass‑through may be acceptable. |
| Retry | none (except implicit 401 → refresh + retry once) | 429/5xx with backoff, 400/403 no retry, 401 refresh + one retry | `UNSUPPORTED` | Must add retry/backoff logic. |
| Cancellation | `reader.cancel` in SSE transformer | supported (same) | `SUPPORTED` | Current implementation already respects cancellation. |
| Concurrency | OAuth refresh de‑duplicated (`refreshPromise`); `toolRegistry` global counter | `tool_state_id` scoped per conversation; `toolRegistry` must be session‑scoped or replaced | `MIGRATE` | Session‑scoped replacement delivered: `ToolNameRegistry` (`src/gigachat/v2/tools/normalize.ts`) — one instance per session, no module‑level mutable state; legacy global maps untouched until V2 integration. |
| Logs / observability | `log/warn/error` via `constants.ts` (debug‑gated) | Should add request‑ID, latency, etc. (see agents.md observability) | `UNSUPPORTED` | Enhance logging per agents.md. |

## Mapping implementation status (PHASE 2/3, evidence-backed)

| Layer | Module | Status | Evidence |
|---|---|---|---|
| Normalized model (content/tools/request/response/capabilities, neutral vocabulary) | `src/core/*` | implemented | fixtures `tests/fixtures/{requests,responses}/*` + unit tests |
| V2 wire types (keyed content items, `function_call.arguments` object per live API with string tolerated, no invented `ImagePart`) | `src/gigachat/v2/types.ts` | implemented | spec + live-verified fixtures (`tests/fixtures/responses/v2.ts`); live observations in `docs/LIVE_API_OBSERVATIONS.md` |
| Request mapping (`tool_calls`→`function_call`, tool result→`function_result`, `tool_choice`→`tool_config.mode`, `response_format`→`model_options`) | `src/translation/opencode-to-normalized.ts`, `src/translation/normalized-to-gigachat-v2.ts` | implemented | `tests/unit/opencode-to-normalized.test.ts`, `tests/unit/normalized-to-gigachat-v2.test.ts` (controlled errors: image part → PHASE 6, unknown tool_choice, missing model) |
| Response mapping (content fidelity via `contentParts`, usage+cached, finish_reason) | `src/translation/gigachat-v2-to-normalized.ts`, `src/translation/normalized-to-opencode.ts` | implemented | `tests/unit/gigachat-v2-to-normalized.test.ts`, `tests/unit/normalized-to-opencode.test.ts` |
| SSE parser (frames, incremental buffering, CRLF, multi-line data, EOF truncation) | `src/streaming/parser.ts` | implemented | `tests/unit/streaming-parser.test.ts` |
| SSE classification (`response.message.delta/done`, `tool.in_progress/completed`; unknown/malformed → controlled error) | `src/streaming/events.ts` | implemented | `tests/unit/streaming-state.test.ts` |
| SSE state machine (text/reasoning/tool_call/tool_completed/usage/done/error; duplicate & anomaly handling) | `src/streaming/state.ts` | implemented | `tests/unit/streaming-state.test.ts` |
| OpenAI chunk emission + terminating `[DONE]` for the OpenCode surface | `src/streaming/opencode.ts` | implemented | `tests/unit/streaming-opencode.test.ts` |

## Live API contract verification (2026-09-15)

Verified against `https://api.giga.chat/v2/chat/completions` (OAuth scope `GIGACHAT_API_PERS`, model `GigaChat-2-Max`); raw evidence and exact API quotes in `docs/LIVE_API_OBSERVATIONS.md`. Where the spec and the live API disagree, **the live contract is the working truth** for the wire format (spec anomalies documented in the observations doc).

| Contract point | Spec says | Live API (verified) | Fixed in |
|---|---|---|---|
| Request role for tool results | `function` (FunctionMessage) | `function`; `tool` → 400 | `types.ts` (`V2RequestMessageRole`), `normalized-to-gigachat-v2.ts` |
| Request state token | `tools_state_id` | `functions_state_id` on assistant messages | `types.ts`, `normalized-to-gigachat-v2.ts` |
| `function_call.arguments` | string | **object**; a JSON string → 400 `"Your request contains invalid JSON syntax."` | request mapper emits objects; `parseToolArguments` tolerates strings at the response boundary |
| Response state token | `tools_state_id` (plural) | `tool_state_id` (singular) | `gigachat-v2-to-normalized.ts` (both read) |
| `function_call.id` in responses | absent | always present (UUID); accepted on requests | response mapper preserves it |
| SSE payload shape | flat V2 object example | full response JSON with message nested under `messages:[...]`; `created_at` numeric; tools `function_call` arrives only inside `done.messages` | `streaming/events.ts` unwrap, `streaming/state.ts` done-content handling |
| Function name pattern | Latin letters, no leading digit (no pattern in spec) | `[A-Za-z][A-Za-z0-9_.-]*` (hyphen/dot allowed; else 422) | `gigachat/v2/tools/normalize.ts` |
| `thread_id` in responses | optional field | never returned | stays optional; documented anomaly |
| `finish_reason: "error"` | spec SSE example | not reproduced; absent from enum | documented anomaly |

## PHASE 4 evidence: tools & session-scoped state

| Capability | Module | Status | Evidence |
|---|---|---|---|
| Function-name validation (Latin letters/digits/`_`/`-`/`.`, no leading digit — `CustomFunction.name`; live 422 text quoted in the error) | `src/gigachat/v2/tools/normalize.ts` | implemented | `tests/unit/tools-normalize.test.ts` |
| Session-scoped alias registry (replaces legacy global `toolRegistry`; deterministic `tool_N`, reverse lookup, passthrough for spec-valid names, per-instance isolation) | `src/gigachat/v2/tools/normalize.ts` | implemented | `tests/unit/tools-normalize.test.ts` (scope isolation between registries) |
| `CustomFunction` shaping (`name`+`parameters` spec-required; controlled errors instead of guessed defaults) | `src/gigachat/v2/tools/function.ts`, wired via `toV2Tools` | implemented | `tests/unit/tools-function.test.ts` |
| Builtin tool wire entries (`image_generate`, `model_3d_generate`; unknown id → controlled error) | `src/gigachat/v2/tools/builtin.ts`, wired via `toV2Tools` | implemented | `tests/unit/tools-builtin.test.ts` |
| Parallel tool-call linkage (`tool_1 → result_1` invariant; orphan/duplicate → controlled error; missing → informational) | `src/gigachat/v2/tools/parallel.ts`, wired into request mapping (`toV2Message`) | implemented | `tests/unit/tools-parallel.test.ts` (1/2/5/10 tools, reorder, mixed, duplicates, orphans) |
| Session-scoped `tools_state_id` store (lifecycle response→extract→store→next request; session isolation; interleaved captures; no global mutable state) | `src/gigachat/v2/tools/state.ts` | implemented | `tests/unit/tools-state.test.ts` (sequential state, A≠B, concurrency-style interleave, independent stores) |
| SSE capture of `tools_state_id` from `response.message.done` | `src/streaming/state.ts` (`lastToolsStateId`) | implemented | `tests/unit/streaming-state.test.ts` |

## PHASE 9/§22 evidence: thin plugin integration (runtime wiring)

| Capability | Module | Status | Evidence |
|---|---|---|---|
| V2 pipeline factory (composes mapping + streaming modules; owns the session-scoped store; plugin stays thin) | `src/translation/v2-pipeline.ts` | implemented | `tests/unit/v2-pipeline.test.ts` |
| Request flow: OpenAI body → NormalizedRequest → V2 wire (session `tools_state_id` injected) | `createV2Pipeline.chatRequest` | implemented | pipeline tests: V2 body shape, state injection, session isolation (A≠B) |
| JSON flow: V2 HTTP body → OpenAI completion; session state captured; non-2xx → OpenAI error envelope; parse failure → 502 proxy error | `createV2Pipeline.jsonResponse` / `jsonResponseFromUpstream` | implemented | pipeline tests: 2xx translate+capture, 429 envelope, unparseable → 502 |
| SSE flow: V2 SSE → OpenAI SSE; `[DONE]` synthesised; state captured at flush; malformed frames → `onSseError` | `createV2Pipeline.streamingResponse` | implemented | pipeline tests: text stream, tool stream (stable call ids), state capture at flush, malformed stream, empty body |
| Opt-in routing in plugin hooks (`options.v2`); legacy V1 path untouched; chat-only response translation in V2 mode (files/direct pass through) | `src/v2/plugin.ts` | implemented (wired) | plugin diff: V2 branch in `http.request`/`http.response`; legacy `else` branches byte-identical |
| V2 chat completions endpoint + host rewrite for `api.gigachat.local` | `src/v2/constants.ts` (`GIGACHAT_V2_COMPLETIONS_URL`), `src/v2/hosts.ts` (`targetV2UrlFor`) | implemented | — |
| Per-session store keying via OpenCode `event.sessionID` (fallback key when absent) | `src/v2/plugin.ts` (`sessionKey`) | implemented | documented in module header |

**Note**: the mapping layer, tools/state modules, and the §22 plugin wiring are implemented and unit-tested. Live-API verification of the wired path was completed 2026-09-15 (see the section above and `docs/LIVE_API_OBSERVATIONS.md`); the wire-format bugs it found are fixed (commits `5ed6e4a`, `f670b68`, `ecdb948`, `82812fd`).

## Next Steps
1. Verify each row against live API (where possible) using test credentials.
2. For every capability marked `UNSUPPORTED` or `MIGRATE`, create a test fixture in `tests/gigachat-v2/` showing:
   - Input (OpenAI request)
   - Expected V2 request (after mapping)
   - Fake V2 response
   - Expected OpenAI response (after mapping)
3. Implement changes incrementally following the atomic‑commit rule (agents.md §32).
4. After each commit, run `bun run typecheck`, `bun run build`, and any new tests.
5. Update this matrix as statuses change (only to `SUPPORTED`/`PARTIAL` after evidence).

---
*Last updated: 2026-09-15 (PHASE 0–4 + PHASE 9/§22 + live-API verification: V2 contract, mapping layer, SSE state machine, tools & session-scoped state, thin plugin wiring; wire-format bugs found by live probes fixed in `5ed6e4a`..`82812fd`).*