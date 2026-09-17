# Tools

Как коннектор обрабатывает инструменты (function calling), состояние между
вызовами и параллельные вызовы.

## Function tools

OpenCode отдаёт инструменты в OpenAI-формате (`tools` / `tool_choice`).
Коннектор переводит их в V2:

| OpenAI | GigaChat V2 |
|---|---|
| `tools: [{type:"function", function:{name, description, parameters}}]` | `tools` c `oneOf`-описанием |
| `tool_choice: "auto"\|"none"\|"required"` | `tool_config.mode` |
| `tool_choice: {type:"function", function:{name}}` | `tool_config.mode` на конкретную функцию |
| результат `role:"tool"`, `tool_call_id` | `role:"function"`, `function_result` |

Контролируемые ошибки (не угадываем значения): неизвестный `tool_choice`,
HTTP(S)-URL изображения, `json_object` в `response_format`, невалидные имена
функций.

## Имена функций

GigaChat требует `CustomFunction.name` по шаблону
`[A-Za-z][A-Za-z0-9_.-]*` (иначе HTTP 422). Легаси-имена вне шаблона
нормализуются в детерминированные алиасы `tool_N`:

- `src/gigachat/v2/tools/normalize.ts` — валидация + `ToolNameRegistry`;
- реестр **сессионный** (не глобальный): у каждой сессии своё пространство
  алиасов, параллельные сессии изолированы;
- валидное по спецификации имя проходит без изменений;
- `getToolAlias` / `getOriginalToolName` — прямой и обратный маппинг
  (экспортируются из `src/v2/index.ts` для совместимости с бандлом).

## Параллельные вызовы

OpenAI-клиент шлёт одно assistant-сообщение сразу с N `tool_calls`, затем N
результатов с `tool_call_id`. Коннектор:

1. первый вызов переводит штатно (`function_call` + аргументы);
2. остальные складывает в `pendingCalls` и вставляет недостающие пары
   `assistant { function_call }` → результат при появлении соответствующего
   `tool_call_id`/`name`;
3. проверяет инвариант `tool_N → result_N` (`verifyToolLinkage`):
   осиротевший/дублированный результат → controlled error, отсутствующий —
   информационное сообщение.

Покрытие тестами: `tests/unit/tools-parallel.test.ts` (1/2/5/10 инструментов,
переупорядочивание, смешанные и дублирующиеся id, сироты), плюс реальный
smoke-сценарий `05-parallel-tools` (`scripts/smoke/run-smoke.sh`).

## Состояние между вызовами

GigaChat требует передавать токен состояния (`tool_state_id`), иначе
многошаговый tool-диалог может потерять контекст вызова.

```text
ответ (JSON/SSE) ──tool_state_id──▶ SessionToolStateStore (по sessionID)
                                          │
следующий запрос ◀──functions_state_id───┘
```

- `src/gigachat/v2/tools/state.ts` — store по сессии;
- SSE: состояние ловится на `response.message.done` и пишется при flush
  (`src/streaming/state.ts`, `lastToolsStateId`);
- изоляция: состояние сессии A не попадает в сессию B; store не использует
  глобальный mutable state;
- состояние **опционально** для round-trip с объектными аргументами
  (живая проверка).

Тесты: `tests/unit/tools-state.test.ts` (последовательные состояния, A≠B,
чередование, независимые store).

## Builtin tools

Регистрируются в `src/gigachat/v2/tools/builtin.ts`:

| Wire id | Статус | Поведение |
|---|---|---|
| `web_search` | живьём подтверждён | серверный поиск, результат как текст (без function round-trip) |
| `url_content_extraction` | живьём подтверждён | серверный fetch, результат inline |
| `image_generate` | wire-запись | end-to-end исполнение не реализовано |
| `model_3d_generate` | wire-запись | end-to-end исполнение не реализовано |
| `code_interpreter` | **не регистрируется** | живой API отвечает 422 «unavailable» |

Неизвестный builtin id → controlled error. Модельные ограничения берутся из
`getModelCapabilities(model)` (`src/core/capabilities.ts`,
`src/gigachat/v2/capabilities.ts`) и проверяются на границах маппинга.

## Добавление нового инструмента

1. Функциональные инструменты OpenCode работают без изменений кода — они
   приходят в `tools` и маппятся автоматически.
2. Серверный (builtin) инструмент: добавьте wire-запись в
   `src/gigachat/v2/tools/builtin.ts` и ветку в `toV2Tools`, затем тест в
   `tests/unit/tools-builtin.test.ts`.
3. Если инструмент недоступен на живом API — не регистрируйте его (как
   `code_interpreter`), иначе гарантирован 422.

См. также [`MCP.md`](MCP.md) (MCP-инструменты приходят как обычные функции),
[`COMPATIBILITY.md`](COMPATIBILITY.md) (статусы и доказательства).
