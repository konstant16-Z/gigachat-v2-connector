# Troubleshooting

Типовые сбои коннектора и что делать. Сначала включите диагностику:

```bash
GIGACHAT_DEBUG=true        # debug-логи [GigaCode] (без контента, с редакцией секретов)
# [GigaCode] [OBS] строки включены по умолчанию (GIGACHAT_OBSERVABILITY=false — выключить)
```

Строка `[GigaCode] [OBS]` содержит `request_id`, `endpoint`, `model`,
`latency_ms`, `retries`, `status`, `stream`, `tool`/`call_id`, `error` —
этого достаточно, чтобы отличить локальную ошибку маппинга от ошибки API.
Формат — [`OBSERVABILITY.md`](OBSERVABILITY.md).

## Credentials не найдены

```text
GigaChat credentials are not configured. Provide 'credentials' via the gigacode
plugin options in opencode.json, or set the GIGACHAT_CREDENTIALS environment variable.
```

Проверьте по порядку: `options.credentials` → `GIGACHAT_CREDENTIALS` →
активная integration-connection `gigachat`. Подробности —
[`CONFIGURATION.md`](CONFIGURATION.md).

## 401 Unauthorized (токен протух / отозван)

Коннектор сам инвалидирует кэш токена (`clearTokenCache`) и делает **ровно
один** повтор после refresh. Если 401 повторяется:

- проверьте корректность Base64 Basic (`Client ID:Client Secret`);
- проверьте scope (`GIGACHAT_API_PERS` / `B2B` / `CORP` соответствует
  аккаунту);
- проверьте системное время (OAuth чувствителен к расхождению часов).

## 429 / 403 (rate limit / квота)

- 429 → backoff+jitter, до `GIGACHAT_MAX_RETRIES` повторов (по умолчанию 3).
- 403 → повторов нет (квота/биллинг); аккаунт помечается в логе.
- Реальный `429` намеренно не форсируется в тестах (тратит бюджет лимита).

Настройка: `GIGACHAT_MAX_RETRIES`, `GIGACHAT_BACKOFF_BASE_MS`,
`GIGACHAT_BACKOFF_MAX_MS`, `GIGACHAT_TIMEOUT`.

## TLS / сертификат

```text
unable to verify the first certificate / self-signed certificate in certificate chain
```

Russian Trusted Root CA нужен и Node, и плагину:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/russian_trusted_root_ca.pem
# или
"options": { "caBundle": "/path/to/russian_trusted_root_ca.pem" }
```

Если файл не найден/нечитаем — используется встроенный CA, а в лог пишется
`warn`. `verifySsl: false` — только для отладки, не для продакшена.

## 400 «invalid JSON syntax» на chat

Историческая ошибка: V2-мапленное тело уходило на V1 endpoint. Сейчас
`targetV2UrlFor` при `v2: true` направляет `/chat/completions` на
`https://api.giga.chat/v2/chat/completions`. Проверьте в `[OBS]`:
`endpoint=api.giga.chat`. Также встречается при строковых
`function_call.arguments` — коннектор шлёт **объект**.

## 400 «invalid function result … JSON parse error»

Результат инструмента должен быть JSON-строкой. Коннектор оборачивает
результат автоматически (`function_result.result`); если ошибка осталась —
вероятно, результат не является сериализуемым значением. См.
[`TOOLS.md`](TOOLS.md).

## 422 «every assistant function result must have an assistant function in history»

Нарушено pairing параллельных вызовов. Коннектор вставляет недостающие
`assistant { function_call }` и проверяет `tool_N → result_N`. Если вы видите
это в V2-режиме — приложите `[OBS]` (`tool`, `call_id`) и проверьте, что
результаты приходят с корректным `tool_call_id`. Тесты —
`tests/unit/tools-parallel.test.ts`.

## 422 по имени функции

Имя не соответствует `[A-Za-z][A-Za-z0-9_.-]*`. Легаси/небезопасные имена
алиасятся в `tool_1`, `tool_2`, … автоматически; ошибка означает имя, которое
не удалось ни пропустить, ни алиасить. См. [`TOOLS.md`](TOOLS.md).

## 422 «Tool code_interpreter is unavailable»

`code_interpreter` намеренно **не** регистрируется: живой API его отвергает.
Не отправляйте его. Аналогично — `image_generate`/`model_3d_generate`
принимаются, но end-to-end не исполняются.

## 404 при URL extraction

Wire-id — `url_content_extraction` (не `url_extraction`). Используйте
зарегистрированный builtin. См. [`TOOLS.md`](TOOLS.md).

## Запрос не перехватывается (уходит без токена)

```text
Refusing to intercept a request to unrecognised host "…": GigaChat credentials
are only sent to known GigaChat hosts (register a custom endpoint via the plugin
`baseURL` option).
```

Это защита от SSRF (§31). Хост должен быть в allowlist или зарегистрирован
опцией `baseURL`. См. [`CONFIGURATION.md`](CONFIGURATION.md),
[`SECURITY.md`](SECURITY.md).

## Стрим «зависает» или нет `[DONE]`

- `[DONE]` синтезируется коннектором в конце стрима; его отсутствие может
  означать оборванный upstream.
- malformed-кадры не ломают вывод: ошибка классифицируется, состояние
  сохраняется, стрим корректно завершается/отменяется
  (`docs/COMPATIBILITY.md`, §24/§29).
- Отмена клиента пробрасывается в upstream (abort), pending-запросы
  очищаются.

## V2-состояние «потерялось» между вызовами

`tool_state_id` привязан к `sessionID`. Если OpenCode не передаёт
`event.sessionID`, используется ключ `default-session`; в этом случае
состояние не изолируется между «безымянными» сессиями. Проверьте `[OBS]`
`request_id` и сессию.

## Проверка «что ушло на wire»

Smoke-harness пишет финальный исходящий запрос отдельным capture-плагином:
`scripts/smoke/run-smoke.sh` → `logs/outbound-dump.log`
(`REQ url=https://api.giga.chat/v2/chat/completions`). Прогон изолирован
собственной XDG-средой и не печатает секреты.

## Куда смотреть дальше

- [`CONFIGURATION.md`](CONFIGURATION.md) — опции и env.
- [`COMPATIBILITY.md`](COMPATIBILITY.md) — что поддержано и чем доказано.
- [`LIVE_API_OBSERVATIONS.md`](LIVE_API_OBSERVATIONS.md) — расхождения с
  спецификацией.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — как воспроизвести и прогнать тесты.
