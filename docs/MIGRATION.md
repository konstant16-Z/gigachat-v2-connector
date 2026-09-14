# Migration Audit: места, завязанные на V1 API

Инвентаризация точек, которые требуется перенести с V1-семантики GigaChat на V2. Классификация дана по правилам PHASE 9 (`KEEP` / `MIGRATE` / `LEGACY` / `REMOVE`); порог удаления — после регрессионных/интеграционных тестов (RULE 15).

## 1. Endpoints (constants.ts)

| Константа | Текущее значение | Оценка |
|---|---|---|
| `GIGACHAT_COMPLETIONS_URL` | `https://gigachat.devices.sberbank.ru/api/v1/chat/completions` | **MIGRATE** — V1 path; заменить на V2 после фиксации контракта |
| `GIGACHAT_OAUTH_URL` | `https://ngw.devices.sberbank.ru:9443/api/v2/oauth` | KEEP (уже V2) |
| `GIGACHAT_FILES_URL` | `https://ngw.devices.sberbank.ru:9443/api/v2/files` | KEEP/MIGRATE — проверить V2-формат `purpose` и ответа |

## 2. Имена полей контракта (translator.ts / response.ts / types)

| V1-имя | Где | Оценка |
|---|---|---|
| `functions` (декларация) | translator.ts:306-346 | **MIGRATE** → V2 `tools` |
| `function_call` (запрос tool_choice) | translator.ts:312-345 | **MIGRATE** → V2 `tool_choice`/`tool_config` |
| `function_call` (в сообщениях) | translator.ts:233-243, 273-291 | **MIGRATE** → V2 tool-call форма |
| `functions_state_id` | translator.ts:244-246, response.ts:44-46,120-122; types/gigachat.ts | **MIGRATE** → `tools_state_id` (+ session-scoped state store — сейчас verbatim только) |
| `response_format` json/json_schema | translator.ts:349-367 | MIGRATE — проверить V2 (structured output) |
| `reasoning_content` passthrough | response.ts:41-43, 105-107 | KEEP/MIGRATE — проверить V2-streaming формат reasoning |
| `repetition_penalty`, `top_p` etc. | translator.ts:99-101, 373 | KEEP — проверить в V2 |

## 3. SSE-предположения (response.ts)

- `makeSseTransformer` рассчитан на V1 chunky: `delta.content`, `delta.reasoning_content`, `delta.function_call{name,arguments}`, `finish_reason: "function_call"`.
- Малфинформ-JSON просто прокидывается строкой (RULE: «не глотать молча» — сейчас не перезаписывает поток, но и не даёт controlled error).
- Отсутствует отдельная state machine (TextDelta / ReasoningDelta / ToolCallDelta / ToolCompleted / Usage / Done / Error).
- `[DONE]` passthrough как есть — проверить формат завершения V2.

## 4. Auth (auth.ts)

- OAuth2 уже на V2-пути (`/api/v2/oauth`) → **KEEP**.
- Проверить по V2: поля токен-ответа (`access_token`, `expires_at`/`exp`), поведение при 401/403 и `blockActiveAccount` (сейчас только логирует).

## 5. Файлы/uploads (translator.ts)

- `purpose: "general"` и ответ `{id}` — проверить V2-контракт файлов и способ прикрепления (`attachments` vs content parts).
- `uploadBase64File` — транспорт завязан на axios+form-data; план: transport отделить от message mapping (PHASE 6, шаг 15).

## 6. Reasoning (translator.ts)

- `reasoning_effort`/`thinking.budget_tokens` → **CoT system prompt** (промпты HIGH/MEDIUM).
- V2: `model_options` (если подтверждено контрактом) — замена промптов native-полем; CoT-промпты — `LEGACY` убрать после перехода.

## 7. Прочее

- `plugin.ts`: вся бизнес-логика в одном файле (OAuth + JSON + tools + URL-rewriting + file handling не здесь, но трансляция вызвана рядом) — цель PHASE 9: тонкий адаптер.
- `toolRegistry.ts`: глобальный `toolCounter` и два Map — potential session-конфликты (PHASE 11, шаг 30 concurrency).
- `hosts.ts` `targetUrlFor`: dev-хост `api.gigachat.local` → `ngw.devices.sberbank.ru:9443` (для chat равно `/api/v1`), после миграции — адаптировать для V2.
- README упоминает `/tmp/opencode/smoke-test.mjs`, который отсутствует — обновить документацию (PHASE 13).

## Стратегия удаления

Ничего из V1-кода не удаляется на этом этапе. Порядок:

```text
фиксировать V2 contract → реализовать V2 path → regression-тесты бывшего поведения → integration → только потом REMOVE/LEGACY-маркировка
```

Rollback-механизм (PHASE 13, шаг 37): feature flag `GIGACHAT_API_VERSION=v2` с дефолтом `v1` до полного E2E.