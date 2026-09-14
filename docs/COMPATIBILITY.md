# Compatibility Matrix (Initial)

Первичная версия матрицы — статусы отражают **фактическое текущее состояние** (V1-трансляция). Целевой столбец «V2» заполняется только после фиксации официального контракта (PHASE 1, шаг «Official V2 contract»).

Статусы: `SUPPORTED` · `PARTIAL` · `MIGRATE` · `LEGACY` · `UNSUPPORTED` · `BLOCKED`.

Правило: **зелёный статус запрещён без теста или подтверждённого API contract.** Ниже V2-статусы не проставлены — это незавершённый блок, а не «поддержано».

| Capability | Current (V1-translation) | Target | Status | Evidence |
|---|---|---|---|---|
| Chat (non-stream) | `POST /api/v1/chat/completions`, OpenAI→GigaChat | V2 endpoint | `SUPPORTED` (current) | translator.ts; работает в проде |
| Streaming (SSE) | SSE через `makeSseTransformer`, passthrough malformed | V2 SSE | `PARTIAL` (current) | response.ts — без formal state machine |
| Function tools | `functions` + `function_call` | V2 `tools` | `MIGRATE` | translator.ts:306-346 |
| Parallel tools | `pendingCalls` пары (assistant+function) | V2 | `SUPPORTED` (current, только unit-артефакт, тестов в репо нет) | translator.ts:260-297 |
| Tool state | `functions_state_id` verbatim passthrough | `tools_state_id` | `MIGRATE` | translator.ts:244-246; response.ts |
| Tool IDs | SSE: стабильные per-stream; JSON: новые `call_<uuid>` | V2 | `PARTIAL` (current) | response.ts:54-58, 111 |
| Reasoning | CoT system prompt (`reasoning_effort`/`thinking`) | V2 `model_options` | `MIGRATE` | translator.ts:104-145 |
| Structured output | `response_format` json/json_schema (только без tools) | V2 | `PARTIAL` (current) | translator.ts:349-367 |
| Vision | base64 image → upload `/api/v2/files` → attachments | V2 content | `PARTIAL` (current) | translator.ts:41-83 |
| Files | `purpose: general`, Attachments | V2 | `MIGRATE` | translator.ts:60-78 |
| Web search (builtin) | — | V2 builtin (P1) | `UNSUPPORTED` (current); TBD (target) | нет кода |
| URL extraction (builtin) | — | V2 builtin (P1) | `UNSUPPORTED` (current); TBD (target) | нет кода |
| Code interpreter / image / 3D | — | P2/P3 | `UNSUPPORTED` | нет кода |
| MCP | не затронут плагином (инструменты проходят как tool_calls) | preserved | `PARTIAL` (current) | toolRegistry.ts aliases |
| Auth OAuth2 | `POST /api/v2/oauth`, Basic, RqUID, кэш+буфер 300 s, anti-race | V2 (уже) | `SUPPORTED` | auth.ts |
| TLS | встроенный CA Минцифры + внешний pem, `rejectUnauthorized` | keep | `SUPPORTED` | net.ts |
| Errors | JSON `error.message`, SSE passthrough | V2 normalized | `PARTIAL` (current) | response.ts:233-268 |
| Retry | нет (кроме 1 попытки после 401-инвалидации — нет) | b.b. `429/5xx backoff` | `UNSUPPORTED` (current) | нет кода |
| Cancellation | `reader.cancel` в SSE transformer | V2 | `PARTIAL` (current) | response.ts:211-215 |
| Concurrency | refresh дедуплицируется; toolRegistry — глобальный counter | scoped | `PARTIAL` (current) | auth.ts:117-121; toolRegistry.ts |

## Требуемые доказательства перед изменением статусов

1. Официальный V2 contract (endpoint, schema, SSE-события) — источник истины.
2. Тесты: `tests/gigachat-v2/*` с фикстурами Input → Expected V2 request → Fake response → Expected OpenCode.
3. Интеграционные проверки (`GIGACHAT_INTEGRATION=1`).

Матрица будет обновляться на каждом этапе миграции, статусы — только с evidence.