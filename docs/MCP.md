# MCP

MCP-инструменты (Model Context Protocol) **не требуют специальной поддержки** в
коннекторе: OpenCode отдаёт их на OpenAI-совместимый surface как обычные
function tools, а коннектор маппит их так же, как любые другие функции.

## Как это выглядит

Имена MCP-инструментов обычно имеют вид `mcp__<server>__<tool>` (например
`mcp__filesystem__read_file`). Результаты приходят как сообщения
`role:"tool"` с `tool_call_id`; связывание результата с вызовом выполняется
по `tool_call_id`, даже если у сообщения нет `name`
(легаси-механизм `toolCallIdToName`).

```text
OpenCode ── MCP server (fs) ──▶ tool `mcp__fs__read_file`
    │
    ▼  OpenAI tool_calls
gigachat-v2-connector
    │  tools → functions; result → function_result (JSON-строка)
    ▼
GigaChat V2
```

## Конфигурация MCP в OpenCode

```jsonc
{
  "mcp": {
    "servers": {
      "fs": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/abs/path"]
      }
    }
  }
}
```

Коннектор ничего не добавляет к этой секции — она полностью на стороне
OpenCode.

## Имена и алиасы

- Спец-валидное имя (`mcp__filesystem__read_file`) проходит на wire без
  изменений.
- Имя вне шаблона `[A-Za-z][A-Za-z0-9_.-]*` (например `mcp server` с
  пробелом) получает детерминированный алиас `tool_1` и остаётся обратимым
  через `getOriginalToolName`.
- Принудительный `tool_choice`: для builtin используется `tool_name`, для
  custom-функции — `function_name`.

## Ограничения и ошибки

- **Осиротевший результат** (неизвестный `tool_call_id`) — controlled error:
  `tool result without a resolvable function name (tool_call_id=…)`, а не
  молчаливая потеря.
- Результат оборачивается в JSON-строку (`function_result.result`), как
  требует живой V2-контракт (иначе 400).
- Параллельные MCP-вызовы работают через общий механизм pairing
  (см. [`TOOLS.md`](TOOLS.md)).

## Проверка

- Offline: [`tests/regression/mcp/mcp.test.ts`](../tests/regression/mcp/mcp.test.ts) —
  объявления, алиасы, forced choice, резолв по `tool_call_id`, сироты,
  JSON-обёртка результата.
- Live smoke: сценарий `06-mcp-fs` в
  [`scripts/smoke/run-smoke.sh`](../scripts/smoke/run-smoke.sh) — реальный
  MCP-сервер `fs` читает `README.md` в изолированной XDG-среде.

Статус в матрице совместимости — `PARTIAL`:
[`COMPATIBILITY.md`](COMPATIBILITY.md) (изменения в плагине не нужны; важно не
исказить имена инструментов).
