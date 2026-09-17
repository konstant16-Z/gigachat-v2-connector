# Observability — plan §32

Date: 2026-09-17
Scope: the V2 plugin request lifecycle (`src/v2/plugin.ts`) and the stream
pipelines (`src/translation/v2-pipeline.ts`, `src/v2/response.ts`), built on
`src/core/observability.ts`.

Goal: emit **minimal, safe** metadata for every request — and never request or
response content by default.

All four gates stay green: `npx tsc --noEmit`, `bun test` (314 tests),
`npx biome check .`, `bun run build`.

---

## 1. Fields

One line per lifecycle event, stable order, machine-greppable:

| Field | Source | Notes |
|-------|--------|-------|
| `request_id` | `RqUID` generated in the request hook | One ID per outbound GigaChat request (chat, files and direct proxy). |
| `endpoint` | `endpointOf(resolvedTarget)` | **Path only** (`/v2/chat/completions`). A malformed URL yields `?`; the raw value is never echoed (it could carry credentials). |
| `model` | OpenAI body `model` | Chat only; omitted for files/direct. |
| `latency_ms` | request hook → completion | Measured from observation creation to `finish`. Rounded, ≥ 0. |
| `retries` | retry loop (§19) | Incremented once per actual retry attempt; omitted when 0. |
| `status` | upstream/final response | HTTP status of the returned envelope. |
| `stream` | `onEnd` hook | `completed` at flush, `cancelled` on consumer abort. Omitted for non-streaming. |
| `tool` / `call_id` | `tool.execute.before` | Tool name and OpenCode call ID; separate line, no request ID. |
| `error` | `normalizeErrorCategory` | Normalized category (below); only on failures. |

## 2. Line format

```text
[GigaCode] [OBS] request_id=<id> endpoint=<path> model=<m> latency_ms=<n> retries=<n> status=<s> stream=completed|error=<category>
```

Examples:

```text
[GigaCode] [OBS] request_id=8f2c… endpoint=/v2/chat/completions model=GigaChat-2-Max latency_ms=412 status=200 stream=completed
[GigaCode] [OBS] request_id=8f2c… endpoint=/v2/chat/completions model=GigaChat-2-Max latency_ms=95 status=429 error=rate_limit
[GigaCode] [OBS] tool=get_weather call_id=call_1
```

## 3. Normalized error categories

| Category | Trigger examples |
|----------|------------------|
| `auth` | HTTP 401 / 403 |
| `rate_limit` | HTTP 429 |
| `timeout` | HTTP 408 / 504, `TimeoutError`, `ECONNABORTED`, "timed out" |
| `network` | `ECONNREFUSED`/`ECONNRESET`/`ENOTFOUND`/…, "fetch failed" |
| `client_error` | other HTTP 4xx (400/404/409/413/422…) |
| `server_error` | HTTP 5xx (except 504) |
| `malformed` | malformed upstream payload/arguments |
| `cancelled` | `AbortError`, "abort"/"cancel" |
| `config` | unsupported/missing/invalid settings (e.g. tool_choice) |
| `unknown` | anything else, or no response |

## 4. What is never logged

By construction, only the fields above are emitted. Defense in depth: every line
is passed through `redactSecrets` (`src/core/redact.ts`, §31) before it reaches
the console, so even a credential that accidentally lands in a metadata field is
masked. Request/response bodies, prompts, headers, `Authorization`,
`access_token`, `client_secret` and uploaded file contents are never emitted.

Content-level debugging remains separate and opt-in via `GIGACHAT_DEBUG` /
`OPENCODE_DEBUG` (`src/v2/constants.ts`).

## 5. Controls

| Variable | Default | Effect |
|----------|---------|--------|
| `GIGACHAT_OBSERVABILITY` | on | `false` / `0` / `off` / `no` disables OBS lines. |
| `GIGACHAT_DEBUG` / `OPENCODE_DEBUG` | off | Enables verbose `[INFO]` diagnostics (still redacted). |

## 6. Lifecycle & hygiene

- **Request hook** creates a `RequestObservation` (keyed by `RqUID`) before the
  token fetch, then reuses the same `RqUID` for the outbound request.
- **Response hook** `finish`es exactly once — JSON completion, SSE `onEnd`
  (`completed`/`cancelled`), files/direct pass-through, or the error path.
- A request-hook failure emits `error=<category>` and drops the entry.
- `finish` is single-fire; an SSE end racing a fallback cannot double-report.
- The plugin `unload` cleanup clears both the pending-request and observation
  registries. `pendingObservationCount()` exposes the registry size in tests.

## 7. Evidence

`tests/unit/observability.test.ts` (28 tests): category mapping, endpoint
safety, format/redaction, kill-switch, latency/retry snapshot, single-fire
completion, V1 + V2 stream-end hooks (completed vs cancelled), and plugin
wiring (one line per request, no body content, no registry leak, unknown host
never observed).
