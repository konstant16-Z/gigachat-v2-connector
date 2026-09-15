# External reference material (локальные копии источников)

Все материалы из интернета, которыми пользуется проект, сохраняются здесь, чтобы
контракт и ссылки не терялись при недоступности внешних ресурсов.

| Файл | Источник | Дата скачивания | Назначение |
|---|---|---|---|
| `gigachat-api.yml` | <https://developers.sber.ru/docs/files/openapi/gigachat/api.yml> | 2026-09-15 | Официальная OpenAPI-спека GigaChat API v3.1.1 (содержит и `/v1/chat/completions`, и `/v2/chat/completions`) |
| `gigachat-post-chat-v2-page.md` | <https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-chat-v-2> | 2026-09-15 | Страница «Сгенерировать ответ V2» (текст, коды ответов, ограничения) |

## Проверенные факты из спеки (2026-09-15)

- Endpoint V2: `POST /v2/chat/completions`, params: `model` (required), `messages` (required), `model_options`, `stream`, `disable_filter`, `ranker_options`, `user_info`, `tool_config`, `tools`.
- `Message.role` (V2 request): `user | system | assistant | tool` (нет `developer`, нет `function`).
- `Message.content` — массив **объектов без дискриминатора `type`**, каждый элемент может содержать ключи: `inline_data`, `text`, `files` (массив `{id}`), `function_result` (`{name, result}`, result — строка с JSON), `function_call` (`FunctionCallArgs`).
- `FunctionCallArgs`: `name` (string, required), `arguments` (string, required) — **аргументы — это строка с JSON**, а не объект.
- `Message.tool_state_id` (request) / `MessageResponse.tools_state_id` (response) — оба существуют.
- `MessageResponse.content` — части: `text`, `files` (`target: image|audio|3dmodel`, `id`, `mime`), `function_call`, `tool_execution` (`name`, `status: success|fail`, `seconds_left`, `censored`), `logprobs`, `inline_data` (`sources`, `images`).
- `finish_reason` (V2): `stop | length | function_call | function_call_error | blacklist | request_blacklist | request_whitelist | request_filter | response_blacklist`.
- `tool_config.mode`: `auto | none | forced`; `mode: auto` — по умолчанию при наличии `tools`; `forced` требует `tool_name` или `function_name`.
- SSE-события: `response.message.delta`, `response.message.done`, `response.tool.in_progress`, `response.tool.completed`; финального `[DONE]` нет.
- Модели (из примеров спеки): `GigaChat-2-Max`, `GigaChat-2-Pro`, `GigaChat-3-Ultra` и др.
- `model_options` **не содержит** поля `reasoning`.

## Открытые несоответствия в самой спеке (требуют проверки против live API)

1. Пример события `response.message.done` содержит `"finish_reason":"error"` — такого значения **нет** в enum `finish_reason`.
2. В примере `created_at` в done-событии — строка, а в схеме `created_at` — integer (unix timestamp).
3. Описание роли `tool`: «результаты в поле `content` в форме JSON-объекта, обернутого в строку» — а схема требует массив с частью `function_result` (строка `result` содержит JSON). Трактовка требует проверки.