# Configuration

All configuration lives in two places: the **plugin `options`** block in
`opencode.json` and **environment variables**. Options win over environment
variables where both apply (credentials from an active integration connection
override both, see below).

> Никогда не коммитьте `credentials`/секреты. В примерах ниже — только
> плейсхолдеры.

## Plugin options

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/gigachat-v2-connector",
      "options": {
        "baseURL": "https://api.giga.chat/v1",
        "credentials": "<Base64 Basic-ключ>",
        "scope": "GIGACHAT_API_PERS",
        "v2": true,
        "verifySsl": true,
        "caBundle": "/path/to/russian_trusted_root_ca.pem"
      }
    }
  ]
}
```

| Option | Тип | По умолчанию | Назначение |
|---|---|---|---|
| `baseURL` | `string` | — | Регистрирует дополнительный GigaChat-совместимый хост в allowlist (`registerGigaEndpoint`). Нужен для кастомных/локальных endpoint'ов. |
| `credentials` | `string` | — | Base64 Basic из Client ID и Client Secret для OAuth. |
| `scope` | `string` | `GIGACHAT_API_PERS` | `GIGACHAT_API_PERS` \| `GIGACHAT_API_B2B` \| `GIGACHAT_API_CORP`. Иное значение игнорируется (падает в `PERS`). |
| `v2` | `boolean` | `false` | Включает V2 pipeline. `false` — legacy V1-трансляция (rollback). |
| `verifySsl` | `boolean` | `true` | Проверять TLS-сертификат. `false` только для отладки. |
| `verifySSL` | `boolean` | — | Алиас `verifySsl` (совместимость). |
| `caBundle` | `string` | встроенный CA | Путь к PEM с Russian Trusted Root CA. |
| `caBundlePath` | `string` | — | Алиас `caBundle`. |

Источники credentials, в порядке применения:

1. `options.credentials` (plugin options);
2. env `GIGACHAT_CREDENTIALS` (+ `GIGACHAT_SCOPE`);
3. активное integration-connection `gigachat` в OpenCode
   (`resolveGigaConnection`) — если найдено, **перекрывает** предыдущие.

Если credentials не найдены нигде, первый же запрос падает с понятной ошибкой
(«GigaChat credentials are not configured …»).

## Environment variables

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `GIGACHAT_CREDENTIALS` | — | Base64 Basic-ключ (альтернатива `options.credentials`). |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` | Scope OAuth. |
| `GIGACHAT_VERIFY_SSL` | `true` | `false`/`0`/`off`/`no` отключают проверку TLS. |
| `GIGACHAT_CA_BUNDLE_FILE` | `~/.config/opencode/certs/russian_trusted_root_ca.pem` | Путь к PEM с CA. |
| `NODE_EXTRA_CA_CERTS` | — | CA для самого OpenCode/Node (TLS до GigaChat). |
| `GIGACHAT_DEBUG` | `false` | `true` — debug-логи `[GigaCode]` (без контента, с редакцией секретов). |
| `OPENCODE_DEBUG` | `false` | Включает debug-логи плагина тоже. |
| `GIGACHAT_OBSERVABILITY` | `true` | `false` — выключает строки `[GigaCode] [OBS]`. |
| `GIGACHAT_MAX_RETRIES` | `3` | Число повторов после первой попытки (только chat). |
| `GIGACHAT_BACKOFF_BASE_MS` | `500` | База экспоненциального backoff. |
| `GIGACHAT_BACKOFF_MAX_MS` | `30000` | Верхняя граница задержки. |
| `GIGACHAT_TIMEOUT` | `120000` | Таймаут одного запроса, мс (`0` — без таймаута). |

## Провайдер в `opencode.json`

Плагин перехватывает запросы провайдера, чей `settings.baseURL` указывает на
GigaChat-хост из allowlist. Рабочая форма:

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
  }
}
```

Allowlist-хосты (`gigaHosts`):

```text
api.gigachat.local            # dev-алиас, переписывается на реальный endpoint
api.giga.chat                 # реальный V2 хост
ngw.devices.sberbank.ru:9443  # OAuth
gigachat.devices.sberbank.ru  # legacy V1 completions
```

Кастомный хост добавляется опцией `baseURL`; до этого запрос к нему
**не** получит `Authorization` (guard §31, см. `docs/SECURITY.md`).

## V2 vs V1 (rollback)

```jsonc
// V2 pipeline (рекомендуется)
"options": { "v2": true }

// Rollback на legacy-трансляцию без правок кода
"options": { "v2": false }
```

V2-состояние (`tool_state_id`) хранится по сессии и не смешивается с legacy
состоянием. Отключение `v2` не ломает credentials и не требует ручного
патчинга бандла — это и есть процедура rollback (plan §37).

## TLS

Порядок выбора CA:

1. `options.caBundle` / `caBundlePath`;
2. env `GIGACHAT_CA_BUNDLE_FILE`;
3. `~/.config/opencode/certs/russian_trusted_root_ca.pem`;
4. встроенный в плагин Russian Trusted Root CA (`BUILTIN_CA_BUNDLE`).

Проверка TLS включается, если `verifySsl`/`verifySSL` не заданы и
`GIGACHAT_VERIFY_SSL` не равен `false`/`0`/`off`/`no`. Валидный PEM
дополняет системные корни, а не заменяет их.

## Какие запросы перехватываются

- хост запроса в allowlist **или** provider-id похож на GigaChat
  (широкий селектор-кандидат), **и**
- итоговый target-хост тоже в allowlist (иначе запрос пропускается без
  токена — защита от SSRF).

`/chat/completions` проходит трансляцию; `/files` и прочие прямые вызовы —
proxy с подстановкой токена. В V2-режиме трансляция ответа выполняется только
для chat (files/direct идут как есть).

## Связанные документы

- [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — что делать при 401/429/TLS.
- [`docs/SECURITY.md`](SECURITY.md) — allowlist, редакция секретов, лимиты.
- [`docs/OBSERVABILITY.md`](OBSERVABILITY.md) — формат `[OBS]`-строк.
- [`docs/PERFORMANCE.md`](PERFORMANCE.md) — влияние retry/timeout на latency.
