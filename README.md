# gigachat-v2-connector

**Порт на OpenCode V2** плагина
[opencode-gigachat-plugin v1.0.0](https://github.com/Overman775/opencode-gigachat-plugin/releases/tag/v1.0.0)
(автор — [Overman775](https://github.com/Overman775)) — интеграция GigaChat/GigaCode
экосистемы Сбера для [OpenCode](https://github.com/anomalyco/opencode).

Оригинал — плагин для **OpenCode V1** (поставляется как собранный JS-бандл,
`~/.opencode/v1-plugins/gigachat-plugin.js`). Данный репозиторий — читаемые
TypeScript-исходники его **порта на OpenCode V2**: код реконструирован из
бандла 1:1 и адаптирован под контракт плагинов V2 (хуки `http.request` /
`http.response` / `tool.execute.before`), без изменения поведения, включая
**фикс параллельных tool-calls** (спаривание `assistant function_call` +
`function` по `call-id`).

Оригинал: <https://github.com/Overman775/opencode-gigachat-plugin>

## Возможности (наследуются от оригинала v1.0.0)

- **Трансляция протоколов OpenAI ↔ GigaChat**: перехват запросов к GigaChat,
  вырезание несовместимых параметров, преобразование `reasoning_effort` /
  `thinking` в текстовые системные инструкции (Chain-of-Thought);
- **Гибридный TLS**: встроенный PEM-бандл российского корневого CA (Минцифры)
  + внешний файл `~/.config/opencode/certs/russian_trusted_root_ca.pem`;
- **Мультимедиа**: base64 `image_url` → upload в `/files` → `file_id` как
  `attachment` (Vision/модели Pro/Max);
- **OAuth 2.0**: кэш JWT, превентивное обновление токена за 5 минут до
  истечения 30-минутного лимита, семафор от параллельных обновлений;
- **1-Tool Constraint**: адаптация массива `tools` под ограничение GigaChat
  «одна функция за запрос»;
- **Режим V2**: собранный бандл под V2-плагины (`~/.opencode/v2-plugins/...`).

## Структура

```
gigachat-v2-connector/
├── package.json          # build: bun build ./src/v2/index.ts --outfile=./dist/index.js --target=bun
├── tsconfig.json
└── src/
    ├── types/gigachat.ts       # типы запросов/ответов OpenAI и GigaChat
    ├── utils/converter.ts      # parseArgumentsToObject, stringifyArguments, sanitizeFunctionParameters
    └── v2/
        ├── index.ts            # точка входа; экспорты = экспортам бандла
        ├── plugin.ts           # плагин OpenCode V2: хуки http.request / http.response / tool.execute.before
        ├── translator.ts       # translateOpenAiToGigaChat + uploadBase64File (ключевой файл, см. ниже)
        ├── response.ts         # translateStreamChunk, translateGigaChatToOpenAi, SSE-трансформер
        ├── auth.ts             # GigaCodeAuthManager: OAuth2 токены (scope, RqUID, кэш)
        ├── hosts.ts            # gigaHosts, registerGigaEndpoint, isGigaProvider, targetUrlFor
        ├── net.ts              # getHttpsAgent (Russian Trusted Root CA), sanitizeError
        ├── toolRegistry.ts     # алиасы имён инструментов: tool_N <-> original name
        └── constants.ts        # URL, пути, REFRESH_BUFFER_SECONDS, log/warn/error
```

## Фикс параллельных tool-calls (`src/v2/translator.ts`)

GigaChat требует строгую историю вида:

```
user
assistant { function_call }
function  { name, content }
assistant { function_call }   <- второй (и следующие) параллельные вызовы
function  { name, content }
```

OpenAI-совместимый клиент шлёт одно сообщение assistant сразу с N
`tool_calls` и потом N сообщений `tool` с `tool_call_id`. Без фикса бандл
передавал только первый вызов, а остальные результаты становились
«осиротевшими» → ошибка «every assistant function result must have an
assistant function in history» / HTTP 422.

Как работает фикс (`translateOneMessage` + `pendingCalls`):

1. Если у сообщения assistant больше одного `tool_calls` — первое
   сообщение переводится как обычно (`function_call` + `arguments`),
   остальные вызовы складываются в массив `pendingCalls` (id, алиас имени,
   аргументы).
2. Когда приходит `tool`/`function` результат, чей `tool_call_id`/`name`
   совпадает с отложенным вызовом — перед результатом вставляется
   недостающее сообщение `assistant { function_call }`, и пара
   (вызов → результат) уходит в GigaChat в правильном порядке.
3. Несовпавшие по id результаты (например, от других инструментов)
   проходят как раньше.

Дополнительно: `toolCallIdToName` — сквозной индекс call-id → имя инструмента
для случаев, когда у результата нет `name`, а только `tool_call_id`.

## Сборка и деплой

```bash
bun install          # зависимости: axios, form-data, uuid
bun run typecheck    # tsc --noEmit
bun run build        # соберёт dist/index.js (бандл, совместимый с загрузчиком плагинов OpenCode V2)
```

Развёртывание (замена живого бандла):

```bash
cp ~/.opencode/v2-plugins/gigachat-plugin/index.js ~/.opencode/v2-plugins/gigachat-plugin/index.js.bak
cp dist/index.js ~/.opencode/v2-plugins/gigachat-plugin/index.js
```

То же для V1-шима: `~/.opencode/v1-plugins/gigachat-plugin.js`.
OpenCode подхватывает изменения бандла без перезапуска демона (hot reload
по изменению файла).

## Конфигурация (opencode.json)

Провайдер должен указывать на GigaChat-совместимый endpoint
(например `https://api.giga.chat/v1`), модель `GigaChat-3-Ultra`.
Плагин перехватывает запросы к зарегистрированным хостам
(`gigaHosts` + `registerGigaEndpoint` через option `baseURL`) и транслирует
тело запроса/ответа между OpenAI-совместимым форматом и API GigaChat.
TLS: Russian Trusted Root CA через `NODE_EXTRA_CA_CERTS` либо
`verifySsl`/`caBundle` опции плагина.

Креденшелы: option `credentials` плагина (Base64 Basic из ключа и секрета)
или `GIGACHAT_CREDENTIALS` + `GIGACHAT_SCOPE` в окружении.

## Проверка

`/tmp/opencode/smoke-test.mjs` прогоняет трансляцию сценария с двумя
параллельными вызовами и проверяет инвариант спаривания:
2 `assistant function_call` и 0 «осиротевших» `function`-результатов.