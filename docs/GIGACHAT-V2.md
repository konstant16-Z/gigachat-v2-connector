# GigaChat API V2 — маппинг

Обзор того, как коннектор переводит OpenAI-совместимый контракт OpenCode в
GigaChat API V2 и обратно. Официальный контракт — в
[`V2-CONTRACT.md`](V2-CONTRACT.md); где живой API расходится со спецификацией,
правдой считается живой API ([`LIVE_API_OBSERVATIONS.md`](LIVE_API_OBSERVATIONS.md)).

## Конвейер

```text
OpenAI body (OpenCode)
   ↓  translation/opencode-to-normalized.ts
NormalizedRequest (core/types.ts)
   ↓  translation/normalized-to-gigachat-v2.ts   (+ session tool_state_id)
V2 wire body
   ↓  HTTP POST /v2/chat/completions
V2 JSON / SSE
   ↓  translation/gigachat-v2-to-normalized.ts    (+ capture tool_state_id)
NormalizedResponse
   ↓  translation/normalized-to-opencode.ts
OpenAI JSON / SSE (+ [DONE])
```

Все типы V2 — в `src/gigachat/v2/types.ts`; сессионное состояние —
`src/gigachat/v2/tools/state.ts`. Единая точка сборки — `createV2Pipeline()`
(`src/translation/v2-pipeline.ts`), вызывающий только `src/v2/plugin.ts`.

## Endpoint

| Назначение | URL |
|---|---|
| Chat completions (V2) | `https://api.giga.chat/v2/chat/completions` |
| Files | `https://api.giga.chat/v1/files` (`/v2/files` → 403) |
| OAuth | `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` |

Dev-хост `api.gigachat.local` переписывается на реальные endpoint'ы
(`targetUrlFor` / `targetV2UrlFor`).

## Маппинг запроса

| OpenAI / Normalized | GigaChat V2 wire | Примечание |
|---|---|---|
| `messages[].content` (text) | keyed content items | структура вложена |
| `messages[]` с несколькими `tool_calls` | последовательные `function_call` | pairing `tool_N → result_N` |
| роль результата инструмента | `function` | роль `tool` → HTTP 400 |
| `tool_calls[].function.arguments` (строка JSON) | `function_call.arguments` (**объект**) | строка → 400 `invalid JSON syntax` |
| результат инструмента | `function_result.result` | JSON, обёрнутый в строку; сырой текст → 400 |
| `functions` / `tools` | `tools` (oneOf) | имена по `[A-Za-z][A-Za-z0-9_.-]*` |
| `tool_choice` | `tool_config.mode` | недопустимое значение → controlled error |
| `response_format` | `model_options.response_format` | `text` \| `json_schema`; `json_object` отвергается |
| изображения base64 (data URL) | upload → `content.files:[{id}]` | HTTP(S)-URL изображения → controlled error |
| состояние инструментов | `functions_state_id` | из сессии; алиас `tool_state_id` тоже принимается |
| `reasoning_effort` / `thinking` | — | V2 не имеет поля; контролируется выбором модели |

## Маппинг ответа

| GigaChat V2 | OpenAI / OpenCode | Примечание |
|---|---|---|
| `choices[].message.content` | `choices[].message.content` | через `contentParts` (текст + вложения) |
| `function_call` | `tool_calls` | `id` сохраняется; если нет — генерируется |
| `function_call.arguments` (объект или строка) | строка JSON | `parseToolArguments` терпит оба вида |
| `tool_state_id` | сессионный store | спец-фолбэк `tools_state_id` |
| `usage` (+ cached) | `usage` | |
| `finish_reason` | `finish_reason` | маппинг в `gigachat/v2/finish-reason.ts` |
| HTTP ≥ 400 `{status,message}` | OpenAI error envelope | `jsonResponseFromUpstream`; непарсимое → 502 |

## Стриминг (SSE)

События V2: `response.message.delta`, `response.message.done`,
`response.tool.in_progress`, `response.tool.completed`.

- `src/streaming/parser.ts` — кадры, инкрементальная буферизация, CRLF,
  многострочные `data:`, обрезанный EOF.
- `src/streaming/events.ts` — классификация; неизвестное/битое → controlled error.
- `src/streaming/state.ts` — state machine (текст/reasoning/tool_call/
  tool_completed/usage/done/error), дубликаты и аномалии.
- `src/streaming/opencode.ts` — OpenAI-чанки + терминальный `[DONE]`.

Важное отличие от спецификации: `function_call` в стриме приходит **только
внутри `done.messages`**, сообщение вложено под `messages:[...]`, `created_at`
числовой. `[DONE]` синтезируется коннектором.

## Отличия от legacy V1

| Аспект | V1 (legacy) | V2 pipeline |
|---|---|---|
| Endpoint | `/v1/chat/completions` | `/v2/chat/completions` |
| Внутренняя модель | нет | Normalized (`src/core`) |
| Состояние | `functions_state_id` verbatim | сессионный store (+ `tool_state_id`) |
| Structured output | `response_format` | `model_options.response_format` |
| Retry/backoff | нет (кроме 401) | 429/5xx + 401 (§19) |
| Observability | debug-логи | `[OBS]`-строка на запрос (§32) |
| Параллельные tools | pairing в translator | pairing с валидацией linkage |

V1-путь не меняется по поведению и служит rollback (`"v2": false`).

## Ограничения

- 3D / image generation: wire-записи зарегистрированы, исполнение не
  реализовано end-to-end.
- `code_interpreter` живой API отвергает 422 — намеренно не регистрируется.
- HTTP(S)-URL изображения не ингестятся (только data URL / `file.id`).
- MCP проходит как обычные function tools (см. [`MCP.md`](MCP.md)).

Актуальные статусы и доказательства — [`COMPATIBILITY.md`](COMPATIBILITY.md).
