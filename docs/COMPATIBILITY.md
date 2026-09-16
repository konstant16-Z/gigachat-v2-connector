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
| Chat (non‑stream) | `POST /api/v1/chat/completions` | `POST /v2/chat/completions` | `SUPPORTED` | Endpoint/host mapping (`GIGACHAT_V2_COMPLETIONS_URL`, `targetV2UrlFor`) + pipeline wired in `plugin.ts` (§22); live 200 through the mapper end-to-end (`scripts/probe-live-roundtrip.ts`). |
| Streaming (SSE) | SSE via `makeSseTransformer` (passthrough malformed, `[DONE]` passthrough) | SSE with events `response.message.delta`, `response.message.done`, `response.tool.in_progress`, `response.tool.completed`; no `[DONE]` | `SUPPORTED` | Live-verified 2026-09-15: payloads nest the message under `messages:[...]`, `created_at` numeric, tools `function_call` arrives in `done.messages` — handled (`ecdb948`). `response.tool.*` lifecycle events: classification + `tool_completed` unit-tested; not yet live-observed (no builtin-tool probe). |
| Function tools | `functions` + `function_call` (top‑level) | `tools` array (oneOf) + `tool_config.mode` + `functions` inside `ToolsFunctions`; results use role `function`; `function_call.arguments` is an object | `SUPPORTED` | Live-verified: `role:"tool"` → 400 and string `arguments` → 400; mapper emits role `function` + object arguments (`5ed6e4a`); two-turn round-trip through the mapper → 200/stop. |
| Parallel tools | `pendingCalls` pairs (assistant + function) | Same semantics (V2 does not forbid parallel tool calls) – relies on correct pairing via `tool_state_id`/`message.id` | `SUPPORTED` (`current`) | The fix for parallel tool calls is already in the connector (see `translator.ts`). No V2 change required for pairing logic. |
| Tool state | `functions_state_id` (verbatim passthrough) | request: `functions_state_id`; response: `tool_state_id` | `SUPPORTED` | Live-verified: response `tool_state_id` (spec `tools_state_id` fallback), request `functions_state_id` (also accepts `tool_state_id` alias), state **optional** for round-trip with object args (`d5f90ab`). Session store + SSE capture (PHASE 4). |
| Tool IDs | SSE: stable per‑stream IDs; JSON: fresh `call_<uuid>` | V2 `function_call` carries a live-returned `id` (spec: none); streaming assigns stable sequential ids (`call_1`, …) per stream; JSON keeps the live id and only generates one when absent; linking tool→result relies on `tool_state_id` | `SUPPORTED` | Live-verified: responses include `function_call.id` (preserved by mapper, `f670b68`); request id optional (`d5f90ab`). Identity invariance (`tool_1 → result_1`) enforced by `verifyToolLinkage` (PHASE 4). |
| Reasoning | `reasoning_effort`/`thinking` → CoT system prompt | No explicit reasoning field; reasoning controlled via model selection (e.g., `GigaChat-3-Ultra`). Streaming `reasoning_content` delta mapped. | `SUPPORTED` | Live/spec verified: V2 has no reasoning field; mapper drops request reasoning controls without corrupting the wire (`34911ba`); streaming `reasoning_content` maps to `reasoning_content` chunks. Legacy CoT prompt stays in V1 only. |
| Structured output | `response_format: {type:"json"|"json_schema"}` (only if no tools) | `model_options.response_format` with `type: "text" | "json_schema"` | `SUPPORTED` | Live-verified 2026-09-16 (`scripts/probe-response-format.ts`, `34911ba`): `text` and `json_schema` (with `schema`) return 200 / valid JSON; `strict: true` enforced; `json`/`json_object` and empty `schema` raise controlled errors per live rejection. |
| Vision (images) | base64 → upload to `/api/v2/files` → `attachments: [file_id]` | base64 data URL → upload to `/v1/files` (live) → `content.files` with `id`; HTTP(S) URLs not ingestible | `PARTIAL` | Live-verified 2026-09-16 (`scripts/probe-files-api.ts`): data-URL images auto-uploaded in the V2 pipeline (`uploadDataUrlsInRequest`) → `content.files` (`ddeed4e`); pre-uploaded `file.id` passes through; HTTP(S) URL images → controlled error (no silent URL-as-text downgrade). |
| Files (general) | `purpose: "general"` → `attachments: [file_id]` | `content.files` with `id` | `SUPPORTED` | Request-side placement implemented: `FilePart` → `content.files:[{id}]`; uploads use `/v1/files` with `purpose=general` (live-verified). |
| Web search (builtin) | – | `web_search` | `SUPPORTED` | Live-verified 2026-09-16 (`scripts/probe-builtin-tools.ts`): `tools:[{web_search:{}}]` + auto → server-side live search, result returned as plain text (no `function_call` round-trip). Registered in `tools/builtin.ts`. |
| URL extraction (builtin) | – | `url_content_extraction` | `SUPPORTED` | Live-verified: wire id is `url_content_extraction` (NOT `url_extraction` → live 404). Accepted by API; server-side fetch, result returned inline. Registered in `tools/builtin.ts`. |
| Code interpreter / image / 3D | – | P2 `code_interpreter`; P3 `image_generate`, `model_3d_generate` | `UNSUPPORTED` / `PARTIAL` | Live: `code_interpreter` → 422 «Tool code_interpreter is unavailable» (known but unavailable — deliberately NOT registered, sending guarantees 422). `image_generate`/`model_3d_generate` wire entries registered per spec; end-to-end tool execution not yet implemented. |
| MCP | not altered by plugin (passes through as `tool_calls`) | preserved | `PARTIAL` | No plugin changes needed; ensure tool names are not mangled incorrectly. |
| Auth OAuth2 | `POST /api/v2/oauth` (Basic, RqUID) | unchanged | `SUPPORTED` | Already V2; live OAuth round-trip verified 2026-09-15. 401 lifecycle (plan §20): `clearTokenCache()` + exactly one refreshed retry wired in the plugin response hook. |
| TLS | Built‑in Russian Trusted Root CA + external file | unchanged | `SUPPORTED` | No change needed; live TLS verified with the CA bundle. |
| Errors | JSON `error.message`, SSE passthrough | Structured error fields `{status, message}` | `SUPPORTED` | Live-verified: errors are JSON `{status, message}` (400 shape violations, 422 validations); non-2xx JSON → OpenAI error envelope (`jsonResponseFromUpstream`, 429 test). Classification via `src/gigachat/v2/errors.ts` (`classifyUpstreamError`, `isRetryableStatus`); credentials/secret headers never leak into messages. |
| Retry | none (except implicit 401 → refresh + retry once) | 429/5xx with backoff + jitter, 400/403 no retry, 401 refresh + exactly one retry | `SUPPORTED` | Implemented per plan §19 (`src/v2/retry.ts` + errors.ts classification, wired in plugin response hook; chat only — files/direct are non-idempotent). Config: `GIGACHAT_MAX_RETRIES`(3), `GIGACHAT_BACKOFF_BASE_MS`, `GIGACHAT_BACKOFF_MAX_MS`, `GIGACHAT_TIMEOUT`. Unit-tested (`tests/unit/retry.test.ts`); live 429 not forced by design (would consume rate-limit budget). |
| Capabilities (map) | – | `getModelCapabilities(model)` (plan §17); filtering enforced at boundaries | `SUPPORTED` (`PARTIAL`) | Live-verified defaults for all supported models; unknown-model fallback keeps verified set. Boundary checks reject unsupported: unknown builtins / `code_interpreter` (live 422), HTTP image URLs, `json_object` formats. Map module + unit tests (`tests/unit/capabilities.test.ts`). |
| Cancellation | `reader.cancel` in SSE transformer | supported (same) | `SUPPORTED` | Current implementation already respects cancellation. |
| Concurrency | OAuth refresh de‑duplicated (`refreshPromise`); `toolRegistry` global counter | `tool_state_id` scoped per conversation; `toolRegistry` must be session‑scoped or replaced | `SUPPORTED` (V2 path) | Session‑scoped `ToolNameRegistry` + `SessionToolStateStore` delivered and used by the V2 pipeline (§22); legacy global maps untouched (V1 path only). |
| Logs / observability | `log/warn/error` via `constants.ts` (debug‑gated) | Should add request‑ID, latency, etc. (see agents.md observability) | `UNSUPPORTED` | Enhance logging per agents.md. |

## Mapping implementation status (PHASE 2/3, evidence-backed)

| Layer | Module | Status | Evidence |
|---|---|---|---|
| Normalized model (content/tools/request/response/capabilities, neutral vocabulary) | `src/core/*` | implemented | fixtures `tests/fixtures/{requests,responses}/*` + unit tests |
| V2 wire types (keyed content items, `function_call.arguments` object per live API with string tolerated, no invented `ImagePart`) | `src/gigachat/v2/types.ts` | implemented | spec + live-verified fixtures (`tests/fixtures/responses/v2.ts`); live observations in `docs/LIVE_API_OBSERVATIONS.md` |
| Request mapping (`tool_calls`→`function_call`, tool result→`function_result`, `tool_choice`→`tool_config.mode`, `response_format`→`model_options`) | `src/translation/opencode-to-normalized.ts`, `src/translation/normalized-to-gigachat-v2.ts` | implemented | `tests/unit/opencode-to-normalized.test.ts`, `tests/unit/normalized-to-gigachat-v2.test.ts` (controlled errors: HTTP image URL, unknown tool_choice, missing model); files upload `tests/unit/files.test.ts` |
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
1. ✅ Live verification of the wired V2 path completed 2026-09-15/16 (chat, streaming, tools, state, tool ids, errors) — statuses above reflect it; probes preserved under `scripts/`.
2. Remaining `UNSUPPORTED`/`MIGRATE`/`PARTIAL` rows need implementation (observability, 3D; vision HTTP-URL images; MCP; code_interpreter unavailable per live 422). Implement alongside fixtures in `tests/gigachat-v2/` showing:
   - Input (OpenAI request)
   - Expected V2 request (after mapping)
   - Fake V2 response
   - Expected OpenAI response (after mapping)
3. Implement changes incrementally following the atomic‑commit rule (agents.md §32).
4. After each commit, run `bun run typecheck`, `bun run build`, and any new tests.
5. Update this matrix as statuses change (only to `SUPPORTED`/`PARTIAL` after evidence).

---

*Last updated: 2026-09-16 (PHASE 0–4 + PHASE 9/§22 + live-API verification: wire-format bugs fixed in `5ed6e4a`..`82812fd`; live round-trip probes `d5f90ab`, `4250e11`; statuses for live-confirmed rows raised to `SUPPORTED`).*