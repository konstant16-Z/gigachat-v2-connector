# gigachat-v2-connector

Подключение **OpenCode** к **GigaChat API V2** (экосистема GigaChat/GigaCode
Сбера) в виде нативного плагина.

> **This is a native OpenCode plugin, not a proxy.**
> Плагин не поднимает собственный HTTP-сервер. Он перехватывает исходящие
> запросы OpenCode через хуки (`http.request` / `http.response` /
> `tool.execute.before`) и на месте переводит тело и ответ между
> OpenAI-совместимым форматом и GigaChat V2.

```text
OpenCode
   ↓
gigachat-v2-connector
   ↓
GigaChat API V2
```

Репозиторий — читаемые TypeScript-исходники порта
[opencode-gigachat-plugin v1.0.0](https://github.com/Overman775/opencode-gigachat-plugin/releases/tag/v1.0.0)
(автор — [Overman775](https://github.com/Overman775)) на контракт плагинов
OpenCode V2. Поведение исходного бандла сохранено 1:1; сверху добавлены
нормализованная модель, полноценный маппинг GigaChat API V2, сессионное
состояние `tool_state_id`, retry/backoff, отмена, observability и guard'ы
безопасности.

## Возможности

| Область | Что сделано |
|---|---|
| Chat | `POST /v2/chat/completions`, JSON и SSE |
| Стриминг | `response.message.delta/done`, `response.tool.*` → OpenAI-чанки + `[DONE]` |
| Инструменты | `tools` → `functions`, `function_call` (объектные аргументы), результаты `function` |
| Параллельные вызовы | pairing `tool_N → result_N` по `tool_state_id` / `message.id` (фикс «осиротевших» результатов) |
| Состояние | сессионный `SessionToolStateStore` (`functions_state_id` ↔ `tool_state_id`) |
| Vision / файлы | base64 data-URL → upload → `content.files`; пре-загруженные `file.id` проходят как есть |
| Structured output | `response_format` → `model_options.response_format` (`text` / `json_schema`) |
| Builtin tools | `web_search`, `url_content_extraction`; `image_generate` / `model_3d_generate` |
| Retry | 429/5xx backoff+jitter; 401 → refresh токена + один retry; 400/403 без retry |
| Отмена / конкурентность | abort пробрасывается в upstream; изоляция параллельных запросов и стримов |
| Capabilities | `getModelCapabilities(model)` — единая карта ограничений модели |
| Наблюдаемость | одна безопасная строка `[GigaCode] [OBS]` на запрос (без контента) |
| Безопасность | токен только на allowlist-хосты, редакция секретов в логах, лимиты upload |

Подробности — в [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) и
[`docs/GIGACHAT-V2.md`](docs/GIGACHAT-V2.md).

## Как это работает

Два пути трансляции:

- **V1 (legacy, по умолчанию)** — исторический `translateOpenAiToGigaChat` +
  `translateJsonResponse`/`translateStreamingResponse` из `src/v2/`. Код
  и поведение совпадают с исходным бандлом; этот путь остаётся для rollback.
- **V2 pipeline (opt-in, `options.v2: true`)** — тонкий `plugin.ts` вызывает
  `createV2Pipeline()`: OpenAI → Normalized (`src/core/`) → GigaChat V2 wire
  (`src/gigachat/v2/`), обратно GigaChat V2 → Normalized → OpenAI
  (`src/translation/`). Только здесь работают сессионное состояние, retry и
  стриминговый state-machine V2.

```text
OpenCode 2.x
   ↓  http.request
plugin.ts (тонкий адаптер)
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

## Установка

```bash
bun install          # axios, form-data, uuid
bun run build        # соберёт dist/index.js (bundle для загрузчика плагинов V2)
```

Развёртывание (замена бандла) — пример:

```bash
cp ~/.opencode/v2-plugins/gigachat-plugin/index.js \
   ~/.opencode/v2-plugins/gigachat-plugin/index.js.bak   # бэкап
cp dist/index.js ~/.opencode/v2-plugins/gigachat-plugin/index.js
```

OpenCode подхватывает изменение бандла горячей перезагрузкой (без рестарта
демона).

## Быстрый старт

Провайдер должен указывать на GigaChat-совместимый endpoint. Ниже — рабочая
форма конфигурации (та же, что использует smoke-harness):

```jsonc
{
  "providers": {
    "gigachat": {
      "name": "GigaChat V2 (api.giga.chat)",
      "package": "@opencode/ai/providers/openai-compatible",
      "env": ["GIGACHAT_CREDENTIALS"],
      "settings": { "baseURL": "https://api.giga.chat/v1" },
      "models": {
        "GigaChat-2-Max": {
          "name": "GigaChat 2 Max",
          "limit": { "context": 128000, "output": 8192 },
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] }
        }
      }
    }
  },
  "plugins": [
    {
      "package": "/path/to/gigachat-v2-connector",
      "options": {
        "credentials": "<Base64 Basic-ключ GigaChat>",
        "scope": "GIGACHAT_API_PERS",
        "v2": true
      }
    }
  ]
}
```

- `credentials` — Base64 Basic из ключа и секрета. Альтернатива без записи в
  конфиг: env `GIGACHAT_CREDENTIALS` (+ `GIGACHAT_SCOPE`).
- `v2: true` включает V2 pipeline. Без него работает legacy V1-трансляция
  (rollback без правок кода).
- TLS: Russian Trusted Root CA через `NODE_EXTRA_CA_CERTS`, либо опции
  `verifySsl`/`caBundle` (`caBundlePath`).

Полный список опций и переменных окружения — в
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Документация

```text
docs/
├── ARCHITECTURE.md        архитектура (фактическая и целевая)
├── BASELINE.md            срез состояния до миграции
├── CONFIGURATION.md       опции плагина и переменные окружения
├── GIGACHAT-V2.md         обзор маппинга OpenAI ↔ GigaChat V2
├── V2-CONTRACT.md         официальный контракт GigaChat API V2
├── TOOLS.md               инструменты: функции, состояние, параллельность
├── MCP.md                 MCP-серверы как function tools
├── TROUBLESHOOTING.md     типовые сбои и их лечение
├── DEVELOPMENT.md         сборка, гейты, тесты, соглашения
├── MIGRATION.md           аудит V1-связностей (история миграции)
├── COMPATIBILITY.md       матрица совместимости V1 → V2 (evidence-backed)
├── LIVE_API_OBSERVATIONS.md  наблюдения живого API
├── LONG_SESSION.md        длинная сессия (20+ инструментов)
├── OBSERVABILITY.md       формат `[OBS]`-лога
├── PERFORMANCE.md         overhead маппинга + live-harness
├── SECURITY.md            аудит безопасности (§31)
└── RELEASE.md             release gate, rollback, финальный чеклист
```

## Разработка

```bash
npx tsc --noEmit        # типы
bun test                # unit + regression (offline)
npx biome check .       # линт/формат
bun run build           # сборка dist/index.js
```

Соглашения по коммитам, тестам и фикстурам — в
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) и `agents.md`.

## Статус и совместимость

Актуальная матрица — [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).
Живой контракт API имеет приоритет над спецификацией; найденные расхождения
зафиксированы в [`docs/LIVE_API_OBSERVATIONS.md`](docs/LIVE_API_OBSERVATIONS.md).
Не отметить `SUPPORTED` без теста/живой проверки — правило репозитория.

## Параллельные tool-calls (историческая справка)

Исходный бандл при N параллельных вызовах передавал только первый, а
остальные результаты становились «осиротевшими» → HTTP 422
`every assistant function result must have an assistant function in history`.

Как исправлено (`translateOneMessage` + `pendingCalls`, сохранено в V1 и V2):

1. Если у assistant-сообщения больше одного `tool_calls` — первый переводится
   как обычно (`function_call` + аргументы), остальные складываются в
   `pendingCalls` (id, алиас имени, аргументы).
2. Когда приходит результат `tool`/`function` с совпадающим
   `tool_call_id`/`name`, перед результатом вставляется недостающее
   `assistant { function_call }`, и пара уходит в правильном порядке.
3. Несовпавшие по id результаты проходят как раньше.
4. `toolCallIdToName` — сквозной индекс call-id → имя инструмента, когда у
   результата нет `name`.

## Лицензия и атрибуция

- Лицензия: MIT (см. [`LICENSE`](LICENSE)).
- Оригинал: [opencode-gigachat-plugin](https://github.com/Overman775/opencode-gigachat-plugin)
  (Overman775). Сторонние компоненты и ссылки — в
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
