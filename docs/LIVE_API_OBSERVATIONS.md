# Live API Observations — GigaChat V2 (`api.giga.chat`)

Дата: 2026-09-15
Среда: WSL (Linux), bun, axios.
Учётка: GigaChat API, scope `GIGACHAT_API_PERS`.
Base URL: `https://api.giga.chat/v2/chat/completions` (OpenAPI servers: `https://api.giga.chat` + path `/v2/chat/completions`).
OAuth: `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` (см. `GIGACHAT_OAUTH_URL`).
Модель в зондах: `GigaChat-2-Max` (в ответе — `"GigaChat-2-Max:2.0.30.01"`, т.е. модель эхом возвращается с суффиксом версии).
Инструменты зондов: `scripts/live-api-check.ts`, разовые probe-скрипты (`scripts/probe-*.ts`; untracked, утилиты).
Документ фиксирует **сырые наблюдения** живого API и их влияние на нашу реализацию; источник истины контракта — `docs/external/gigachat-api.yml`, но **в спорных местах live API имеет приоритет для исполнения** (аномалии задокументированы ниже и в `docs/COMPATIBILITY.md`).

---

## 1. OAuth и сеть

- OAuth `POST /api/v2/oauth` с Basic-креденшелами работает; выдаёт Bearer-токен.
- TLS: `api.giga.chat` и `ngw.devices.sberbank.ru:9443` не проходят валидацию стандартным root-набором (`curl` → `unable to get local issuer certificate` / `self-signed certificate in certificate chain`). Плагин решает это CA-бандлом `~/.config/opencode/certs/russian_trusted_root_ca.pem` (и встроенным `BUILTIN_CA_BUNDLE` в `src/v2/net.ts`).
- Схема ошибок:
  - **400** `{"status":400,"message":"Your request contains invalid JSON syntax."}` — невалидная *форма* (семантика схемы запроса), напр. `role:"tool"`, `function_call.arguments` строкой, `function_result` без `name`.
  - **422** `{"status":422,"message":"Invalid params: <детали>"}` — валидация *значений/связности*, напр. недопустимое имя функции, «every assistant function result must have an assistant function call in history».
  - **401/403** — не проверялось (токен получен корректно).

---

## 2. Запрос — подтверждённый live-формат

```json
{
  "model": "GigaChat-2-Max",
  "messages": [
    { "role": "user", "content": [{ "text": "..." }] },
    {
      "role": "assistant",
      "content": [{ "function_call": { "name": "get_weather", "arguments": { "city": "Москва" } } }],
      "functions_state_id": "01a0a66b-dcbc-7089-983a-33f2a2b36d33"
    },
    { "role": "function", "content": [{ "function_result": { "name": "get_weather", "result": "{\"city\":\"Moscow\"}" } }] }
  ],
  "tools": [
    { "functions": { "specifications": [
      { "name": "get_weather", "description": "...", "parameters": { "type": "object", "properties": {...}, "required": [...] } }
    ] } }
  ],
  "stream": false
}
```

Проверенные факты:

| Факт | Результат | Статус |
|---|---|---|
| `role` для результата функции | **`function`** (не `tool`); `role:"tool"` → 400 | критично |
| text content у user/assistant | массив `[{text}]` принимается (200) | ок для нашего маппера |
| `function_call.arguments` | **только объект** (JSON-объект); строка → 400 | критично |
| `function_call.id` на request | **необязателен**: и с id, и без id → 200 | ок |
| `functions_state_id` | принимается; реальный `tool_state_id` из ответа turn1 работает (200); синтетический UUID тоже 200; **не обязателен** — turn-2 без state + объект-arguments → 200 (зонд `probe-state-mandatory.ts`) | ок |
| `function_result` | массив `[{function_result:{name,result}}]` → 200; без `name` → 400 | ок (name обязателен) |
| «строгий» FunctionMessage (content строкой) | 400 | спека не совпадает с live |

Примечание: request `FunctionMessage.content` по спеке — `string`, по live — массив `[{function_result}]`. Live-вариант принят.

---

## 3. Ответ (JSON, не-stream)

```json
{
  "model": "GigaChat-2-Max:2.0.30.01",
  "created_at": 1789498329,
  "messages": [
    {
      "role": "assistant",
      "tool_state_id": "01a0a669-8b36-7cb0-acc2-384557f8f455",
      "content": [
        {
          "function_call": {
            "id": "3c1b6655-cba0-437d-973c-bd482b5ce421",
            "name": "get_weather",
            "arguments": { "city": "Москва" }
          }
        }
      ]
    }
  ],
  "finish_reason": "function_call",
  "usage": {
    "input_tokens": 69,
    "input_tokens_details": { "prompt_tokens": 69, "cached_tokens": 0 },
    "output_tokens": 34,
    "total_tokens": 103
  }
}
```

Аномалии ответа:

| Поле | Спека | Live | Влияние |
|---|---|---|---|
| `messages[].tool_state_id` | `tools_state_id` (мн.ч.) | **`tool_state_id`** (ед.ч.) | наш парсер читал `tools_state_id` → state терялся |
| `messages[].content[].function_call.id` | нет id в `FunctionCallArgs` | **UUID есть всегда** | наш нормалайзер выбрасывал id → терялся linkage для round-trip |
| `messages[].content[].function_call.arguments` | string | **объект** | парсер должен принимать объект (и строку для совместимости) |
| `created_at` | integer (unix) | **number** — совпадает | ок |
| `thread_id` | есть (string) | **не возвращается ни разу** | держать optional; документируем аномалию |
| `message_id` | есть в `MessageResponse` | **не приходит** | ок (optional) |

---

## 4. SSE (streaming)

Сырой пример (text, stream: true):

```
event: response.message.delta
data: {"model":"GigaChat-2-Max:2.0.30.01","created_at":1789498413,"messages":[{"role":"assistant","content":[{"text":"один, два, три"}]}]}

event: response.message.done
data: {"model":"GigaChat-2-Max:2.0.30.01","created_at":1789498413,"finish_reason":"stop","usage":{"input_tokens":36,"input_tokens_details":{"prompt_tokens":36,"cached_tokens":3},"output_tokens":7,"total_tokens":43}}

```

- События: `response.message.delta`, `response.message.done` (+ терминальный пустой кадр).
- **delta payload = полный JSON ответа**: `{model, created_at, messages:[{role, content:[...]}]}` — контент вложен в `messages`, а не плоско в payload. `message_id` отсутствует.
- **done payload**: `{model, created_at, finish_reason, usage}`; для tools-запроса в done приходит **`messages`** с assistant-сообщением (`tool_state_id`, `content:[{function_call}]`).
- `created_at` — number (в примерах спеки — строка; версия спеки устарела).
- `thread_id` — не приходит.
- Для text короткие ответы приходят **одним delta-кадром** (не токен-за-токеном). Множественных delta-кадров с частичным текстом пока не наблюдали — при длинных ответах, вероятно, будут; парсер должен конкатенировать.

Влияние: наш `asMessagePayload` в `src/streaming/events.ts` читал плоский `{message_id?, role?, content?}` → для live надо **разворачивать `messages`** и снимать `role/content` с вложенного сообщения.

---

## 5. Tools flow (two-turn)

Подтверждённый рабочий round-trip (JSON, stream: false):

1. **Turn 1** (без state): `tools` + user → 200; ответ = `finish_reason:"function_call"`, `assistant` с `tool_state_id` + `function_call {id, name, arguments: объект}`.
2. **Turn 2**: история `[user, assistant(content:[{function_call}], functions_state_id: <id из turn1>), function(content:[{function_result}]), user]` + те же `tools` → 200, `finish_reason:"stop"`.

Отказы (для протокола):

| Форма turn 2 | Результат |
|---|---|
| `role:"tool"` | 400 |
| `function_call` на верхнем уровне assistant + content `[{text}]`, без state | 422 «every assistant function result must have an assistant function call in history» |
| `function_call.arguments` строкой | 400 (всегда) |
| `function_result` без `name` | 400 |

Открытые вопросы — **закрыты зондом 2026-09-15** (`scripts/probe-state-mandatory.ts`):

| Вопрос | Результат |
|---|---|
| Обязателен ли `functions_state_id` на turn-2 при объектных `arguments`? | **Нет**: turn-2 без state-поля + объект-arguments → 200, `finish_reason:"stop"` |
| Обязателен ли `function_call.id`? | **Нет**: без id + объект → 200 |
| Принимает ли request-поле `tool_state_id` как алиас `functions_state_id`? | **Да**: эквивалентно → 200 |

Т.е. state-токен — это (опциональный) усилитель связности, а не обязательное условие round-trip; объектные `arguments` достаточны. Маппер всё равно передаёт `functions_state_id`, когда state есть (консервативно, и это не мешает).

**End-to-end (сквозь наш маппер):** `scripts/probe-live-roundtrip.ts` гоняет OpenAI-тело через `openCodeToNormalized → normalizedToGigaChatV2` → live → `gigachatV2ToNormalized` → turn-2 из нормализованного ответа. Подтверждено: `tool_state_id`→`stateId`, `function_call.id` сохраняется, объект-arguments парсится, роли turn-2 `user,assistant,function,user`, ответ 200 `finish="stop"`.

---

## 6. Валидация имён функций

Запрос с `name: "Плохое_Имя"` (кириллица) → **422**:

```
"Invalid params: Invalid function names. Only Latin letters (A-Z or a-z), underscore (_), hyphen (-), dot (.) and digits (not leading) are allowed.: [Плохое_Имя]"
```

Live-паттерн: `^[A-Za-z][A-Za-z0-9_.-]*$` (**допускает `-` и `.`**; первая цифра запрещена). В спеке паттерна для `CustomFunction.name` нет.

Влияние: наш `V2_FUNCTION_NAME_PATTERN` в `src/gigachat/v2/tools/normalize.ts` был строже (`/^[A-Za-z][A-Za-z0-9_]*$/`) → расширить, обновить сообщение об ошибке и логику алиасов.

---

## 7. Невоспроизведённое

| Гипотеза | Итог |
|---|---|
| SSE `finish_reason:"error"` | ни разу не наблюдался; в JSON-энмуме его нет (только в примерах спеки). Считаем устаревшим примером; документируем. |
| `thread_id` в ответе | не приходит (поле optional в типах). |
| `input_tokens_details.cached_tokens` | приходит (0 или >0). |

---

## 8. Сводка багов, найденных live-зондами (→ фиксы)

1. `V2MessageRole` — request: `"function"` вместо `"tool"` (типы + маппер). `src/gigachat/v2/types.ts`, `src/translation/normalized-to-gigachat-v2.ts`.
2. Request state-поле: `functions_state_id` вместо `tool_state_id` (типы + маппер).
3. Request `function_call.arguments` — объект, не строка (`stringifyArguments`).
4. Response `tool_state_id` (ед.ч.) — парсер читал `tools_state_id`.
5. Response `function_call.id` — сохранять и пробрасывать (linkage).
6. SSE: разворачивать `messages` в delta/done; state брать из `done.messages[0].tool_state_id`.
7. Валидатор имён: расширить паттерн (`-`, `.`).
8. (Документация) Аномалии спеки: `tools_state_id`→`tool_state_id`, `FunctionCallArgs.id`, `arguments` string→object, FunctionMessage content array, UserMessage content array, SSE examples устарели, `thread_id` отсутствует в live.

---

## 9. `model_options.response_format` — live-проверка (2026-09-16, `scripts/probe-response-format.ts`)

Зонд: по одному запросу (`GigaChat-2-Max`) на вариант, `content` как массив keyed-объектов; статус + текст ответа записаны.

| Вариант `response_format` | Статус | Комментарий |
|---|---|---|
| нет `model_options` (baseline) | 200 | обычный текст |
| `model_options.temperature` only | 200 | обычный текст |
| `{type:"text"}` | 200 | спека-валиден |
| `{type:"json"}` | **400** | `Unknown type "json" in response_format` |
| `{type:"json_object"}` | **400** | `Unknown type "json_object" in response_format` |
| `{type:"json_schema", schema:{...}}` | 200 | ответ — JSON; без `strict` модель добавляет свои поля (`"type":"word","_content":...`) |
| `{type:"json_schema"}` без `schema` | **400** | `Empty schema with json format type is not supported` |
| `{type:"json_schema", schema, strict:true}` | 200 | строгое соответствие схеме |
| `{type:"xml"}` | **400** | `Unknown type "xml" in response_format` |

Выводы (wire-формат решается live-API):

- V2 принимает в `model_options.response_format` ровно два типа: **`text`** и **`json_schema`** (совпадает со спекой, дискриминатор `ChatResponseFormat`; `json`/`json_object` — **не поддерживаются**, 400).
- `json_schema` **требует `schema`** (400 без неё) — маппер должен кидать контролируемую ошибку вместо того, чтобы слать без схемы.
- Прежнее отображение `json_object → {type:"json"}` в маппере — **неверно** (400); либо контролируемая ошибка, либо клиент должен использовать `json_schema`.
- `strict:true` работает как в спеке (требует `required` в схеме).
- Косвенное подтверждение: request `content` должен быть **массивом keyed-объектов**; строка → 400 `Your request contains invalid JSON syntax` (generic-сообщение валидатора — энвольвер на любое нарушение тела).

Противоречие плану: план §13 заявлял поддержку `json_object` — live показывает, что его нет в V2 (`Unknown type "json_object" in response_format`).

---

## 10. Files API — live-проверка (2026-09-16, `scripts/probe-files-api.ts`)

Зонд: загрузка 1x1 PNG через `multipart/form-data` + использование `file.id` в chat completion.

| Endpoint | Upload | Chat completion с `file.id` |
|---|---|---|
| `https://api.giga.chat/v1/files` | **200** ✅ | **200** ✅ (модель вернула описание изображения) |
| `https://api.giga.chat/v2/files` | **403** Forbidden (nginx) | — |
| `https://ngw.devices.sberbank.ru:9443/api/v2/files` | **400** Bad Request (SynGX) | — |

Выводы (live-формат решается API):

- Files API доступен **только на `/v1/files`** (домен `api.giga.chat`). Путь `/v2/files` на том же домене отдаёт 403; legacy-домен `ngw.devices.sberbank.ru:9443/api/v2/files` — 400.
- Загрузка: `POST /v1/files` с `multipart/form-data` (`file` + `purpose=general`) → возвращает JSON с `id` (UUID), `object: "file"`, `bytes`, `purpose`, `modalities`.
- Использование в чате: `messages[].content` принимает `{ files: [{ id: "<file-id>" }] }` — модель получает содержимое файла.
- V2 chat completion endpoint (`/v2/chat/completions`) **работает с file.id из `/v1/files`** — нет разрыва версий.
- План §15 / translator.ts: legacy `uploadBase64File` целится в `GIGACHAT_FILES_URL = ngw.../api/v2/files` — нужно переключить на `https://api.giga.chat/v1/files`.
- Форматы: PNG (1x1) прошёл; спека декларирует text/image/audio с лимитами (15 Мб image, 35 Мб audio, 40 Мб text).
- `content.files` в request — это keyed-объект `{ id: string }`, соответствует спеке.