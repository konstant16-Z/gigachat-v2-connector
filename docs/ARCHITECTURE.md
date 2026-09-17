# Architecture

> **Статус.** Разделы 1–6 описывают **исходную** архитектуру на момент начала
> миграции (PHASE 0 / рекогносцировка) и сохранены как исторический baseline.
> Раздел 7 («Целевая архитектура») **реализован** — V2 pipeline доступен по
> опции `"v2": true`; см. [`GIGACHAT-V2.md`](GIGACHAT-V2.md) и
> [`COMPATIBILITY.md`](COMPATIBILITY.md). Номера строк в таблице §2 относятся к
> исходному срезу и с тех пор сдвинулись.

Документ фиксирует **фактическую архитектуру** `gigachat-v2-connector` на момент начала миграции (PHASE 0 / рекогносцировка). Runtime-изменений на этом этапе не вносилось.

## 1. Суть

Это **нативный OpenCode-плагин-перехватчик**, а не proxy: он не запускает свой HTTP-сервер, а через хуки OpenCode (`session.hook`, `tool.hook`) переписывает исходящий запрос OpenAI-формата в формат GigaChat и обратно преобразует ответ.

```text
OpenCode 2.x (модель gigachat, baseURL → api.gigachat.local или Сбер-хост)
      │  http.request
      ▼
gigachat-v2-connector (plugin.setup)
      │  rewrite URL + auth headers (Bearer, RqUID)
      │  translateOpenAiToGigaChat(body)
      ▼
GigaChat API (V1 chat/completions, V2 oauth/files)
      │  http.response
      ▼
gigachat-v2-connector
      │  translateJsonResponse / translateStreamingResponse (SSE)
      ▼
OpenCode 2.x (OpenAI-совместимый поток)
```

## 2. Точки входа

| Хук | Модуль | Назначение |
|---|---|---|
| `session.hook("http.request")` | `src/v2/plugin.ts:154` | Обнаружение Giga-трафика, подмена URL/headers, трансляция тела запроса |
| `session.hook("http.response")` | `src/v2/plugin.ts:220` | Трансляция ответа (JSON или SSE) обратно в OpenAI-вид |
| `tool.hook("execute.before")` | `src/v2/plugin.ts:239` | Логирование исполнения инструментов (только debug) |

Экспортируемая поверхность — `src/v2/index.ts` (совпадает с продакшн-бандлом): `plugin` (default), `getHttpsAgent`, `authManager`, `getToolAlias`, `gigaHosts`, `resolveGigaConnection`, `translateOpenAiToGigaChat`, `translate*Response`.

## 3. Модули и зоны ответственности

| Модуль | Ответственность | V1-связность |
|---|---|---|
| `plugin.ts` | OpenCode-адаптер: хуки, опции, credentials из интеграций, добавление endpoint | н/д |
| `translator.ts` | OpenAiBody → GigaChatBody: система, сообщения, изображения (upload), tool-calls, `functions`/`function_call`, `response_format`, reasoning→CoT, `functions_state_id` | **высокая** |
| `response.ts` | GigaChat → OpenAI: JSON, SSE (state machine через `makeSseTransformer`), `translateStreamChunk`, `validateMessagePayload` (128K лимит) | высокая |
| `auth.ts` | OAuth2: `GigaCodeAuthManager`, кэш JWT, `REFRESH_BUFFER_SECONDS=300`, защита от гонки refresh (`refreshPromise`) | низкая (v2 oauth уже) |
| `hosts.ts` | `gigaHosts` (set), `registerGigaEndpoint`, `isGigaProvider`, `tryHost`, `targetUrlFor` (dev → prod rewrite) | средняя |
| `net.ts` | HTTPS-agent с Russian Trusted Root CA (встроенный PEM + внешний файл), `sanitizeError` | низкая |
| `toolRegistry.ts` | алиасы `tool_N` ↔ оригинальное имя (GigaChat требует латинские имена) | низкая |
| `constants.ts` | URL, пути, `REFRESH_BUFFER_SECONDS`, log/warn/error (debug-гейт `GIGACHAT_DEBUG`) | высокая |
| `types/gigachat.ts` | общие типы, смешивают OpenAI- и GigaChat-формы | высокая |
| `utils/converter.ts` | `parseArgumentsToObject`, `stringifyArguments`, `sanitizeFunctionParameters` | низкая |

## 4. Основные потоки данных

### 4.1 Запрос (chat/completions)
1. `http.request` → проверка хоста/провайдера (`gigaHosts` ∪ `isGigaProvider`).
2. `authManager.getAccessToken()` — OAuth2 к `ngw.devices.sberbank.ru:9443/api/v2/oauth`, Basic-авторизация credentials.
3. URL: `targetUrlFor()` → `https://gigachat.devices.sberbank.ru/api/v1/chat/completions` (dev-хост `api.gigachat.local` → prod).
4. `translateOpenAiToGigaChat(body)`:
   - `model` (алиас `GigaChat-2-Lite` → `GigaChat-2`);
   - `messages`: system/developer собраны в один system-блок; tool/function → role `function`; tool_calls → `function_call`;
   - **parallel tool-calls fix**: `pendingCalls` — N>1 вызовов, перекладывание (assistant function_call + function) парами по `call-id`;
   - reasoning (`reasoning_effort`/`thinking`) → текстовые CoT-промпты в system;
   - изображения: base64 → upload в `/api/v2/files` (`purpose: general`), `attachments: [file_id]`; URL-изображения → текст `[Image URL: ...]`;
   - `tools`/`functions` → `functions` с `sanitizeFunctionParameters`; `tool_choice` → `function_call`;
   - `response_format` → `{type: "json"|"json_schema"}`; `stop`, `repetition_penalty`.
5. Новый `Request` → GigaChat, headers: `Authorization: Bearer`, `RqUID: uuid`, `Accept`, `Content-Type`.

### 4.2 Ответ (JSON)
`translateJsonResponse` → `translateGigaChatToOpenAi`: `choices[].message`, `function_call` → `tool_calls` (fresh `call_<uuid>` на каждый вызов!), `reasoning_content` passthrough, `functions_state_id` passthrough, `usage`. HTTP>=400 → `{error:{message:"GigaChat API Error: ...", code}}`.

### 4.3 Ответ (SSE)
`makeSseTransformer`: буферизация строк, парсинг `data:`-событий, `translateStreamChunk` на каждый chunk, стабильные id tool-call через per-stream `streamToolCallIds` map, `[DONE]` passthrough, malformed JSON → passthrough строки как есть (не перезаписывает вывод). Возможны «недостающие» tool_call_id в обратном направлении.

### 4.4 Auth lifecycle
`getAccessToken()`: кэш `expiresAt` − 300 s буфер → refresh при необходимости; `refreshPromise` дедуплицирует параллельные refresh; при 429/403 в `http.request` — `blockActiveAccount` (сейчас только логирует).

## 5. Модель данных (кратко)

- Вход: `OpenAiChatBody` (`model, messages, stream, temperature, top_p, max_tokens, stop, repetition_penalty, thinking, reasoning_effort, tools, functions, tool_choice, function_call, response_format`).
- Выход: `GigaChatRequestBody` (`model, messages, stream, temperature, top_p, max_tokens, functions, function_call, response_format, stop, repetition_penalty`).
- Сообщение GigaChat: `{role, content, name, function_call, attachments, functions_state_id}`.
- Ответ/чunks: `GigaChatResponse` (`id, created, model, choices[], usage`).

## 6. Текущие ограничения и риски (для миграции)

1. **Смешение ролей**: `plugin.ts` одновременно OAuth2, JSON mapping, tool mapping, file upload — против требования «тонкого адаптера».
2. **V1-имена контракта**: `functions`, `function_call`, `functions_state_id`, endpoint `/api/v1/chat/completions` — мишень PHASE 9 (legacy audit → MIGRATE).
3. **reasoning реализован промптами CoT**, а не native полем V2 (в V2 — `model_options`).
4. **Нет нормализованной внутренней модели** — `src/core/` отсутствует; types/gigachat.ts смешивают слои.
5. **Нет тестов** (см. BASELINE.md), нет синхронизации `functions_state_id` между запросами (передача только verbatim из запроса в запрос).
6. `tool_call_id` в не-SSE ответе генерируется заново (`call_<uuid>`) — может расходиться с ожиданиями OpenCode на идентичность id вызова.

## 7. Архитектура V2 (реализована)

Целевая схема доступна по `options.v2: true`; тонкий `plugin.ts` вызывает
`createV2Pipeline()`:

```text
OpenCode 2.x
   ↓  http.request
OpenCode adapter (тонкий plugin.ts)
   ↓
Normalized model (src/core)
   ↓
GigaChat V2 adapter (src/gigachat/v2, src/translation)
   ↓
GigaChat API V2 (JSON / SSE)
   ↓  http.response
V2 → Normalized → OpenCode events
   ↓
OpenCode 2.x
```

Слои и их модули:

| Слой | Модуль | Ответственность |
|---|---|---|
| Адаптер | `src/v2/plugin.ts` | хуки, опции, auth, выбор V1/V2, retry, observability |
| Композиция | `src/translation/v2-pipeline.ts` | сборка mapping + streaming, сессионный store |
| Normalized | `src/core/*` | content/tools/request/response/capabilities, нейтральный словарь |
| V2 wire | `src/gigachat/v2/*` | типы, ошибки, finish_reason, tools (normalize/function/builtin/parallel/state) |
| Mapping | `src/translation/*` | OpenAI ↔ Normalized ↔ V2 |
| Streaming | `src/streaming/*` | parser → events → state → OpenAI-чанки + `[DONE]` |

Legacy-путь (`"v2": false`) остаётся нетронутым и служит rollback (plan §37).
Точки входа, экспортируемая поверхность и данные — те же, что в §2/§4; V2
добавляет нормализованный слой и сессионное состояние поверх них.