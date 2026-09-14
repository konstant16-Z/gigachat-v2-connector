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
| Streaming (SSE) | SSE via `makeSseTransformer` (passthrough malformed, `[DONE]` passthrough) | SSE with events `response.message.delta`, `response.message.done`, `response.tool.in_progress`, `response.tool.completed`; no `[DONE]` | `PARTIAL` | Current parser works but must translate event types and drop `[DONE]` handling. |
| Function tools | `functions` + `function_call` (top‑level) | `tools` array (oneOf) + `tool_config.mode` + `functions` inside `ToolsFunctions` | `MIGRATE` | Structure changed; need to wrap/declare functions differently. |
| Parallel tools | `pendingCalls` pairs (assistant + function) | Same semantics (V2 does not forbid parallel tool calls) – relies on correct pairing via `tool_state_id`/`message.id` | `SUPPORTED` (current) | The fix for parallel tool calls is already in the connector (see `translator.ts`). No V2 change required for pairing logic. |
| Tool state | `functions_state_id` (verbatim passthrough) | `tool_state_id` (on request & response messages) | `MIGRATE` | Rename and move from top‑level field to `message.tool_state_id`; must store per‑conversation. |
| Tool IDs | SSE: stable per‑stream IDs; JSON: fresh `call_<uuid>` | Same approach (stable IDs in SSE, fresh IDs in JSON) but IDs now tied to `message.id`? spec shows `message_id` in response; need to verify. | `PARTIAL` | Current behavior likely acceptable; need to confirm V2 expects stable IDs in SSE and mapping to `message.id`. |
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
| Concurrency | OAuth refresh de‑duplicated (`refreshPromise`); `toolRegistry` global counter | `tool_state_id` scoped per conversation; `toolRegistry` must be session‑scoped or replaced | `MIGRATE` | `toolRegistry` uses global maps – potential cross‑talk. Need to scope to session or use per‑conversation state. |
| Logs / observability | `log/warn/error` via `constants.ts` (debug‑gated) | Should add request‑ID, latency, etc. (see agents.md observability) | `UNSUPPORTED` | Enhance logging per agents.md. |

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
*Last updated: 2026-09-15 (after PHASE 0 reconnaissance and PHASE 1 V2 contract fixation).*