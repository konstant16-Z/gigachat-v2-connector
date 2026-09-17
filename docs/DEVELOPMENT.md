# Development

Сборка, тесты, гейты и соглашения репозитория.

## Предпосылки

- [Bun](https://bun.sh) (проект использует `bun test`, `bun build`).
- Node.js с поддержкой ESM.
- Для live-проверок — доступ к `api.giga.chat` и валидные credentials.

## Структура

```text
src/
├── core/            нормализованная модель (content, tools, request, response, capabilities)
├── gigachat/v2/     типы и логика GigaChat API V2 (errors, finish-reason, tools/*)
├── translation/     OpenAI ↔ Normalized ↔ GigaChat V2 (v2-pipeline — композиция)
├── streaming/       SSE: parser, events, state, opencode-emitter
├── types/           общие/легаси типы
├── utils/           мелкие утилиты конвертации
└── v2/              OpenCode-адаптер + legacy V1 (plugin, translator, response, auth,
                     hosts, net, files, retry, toolRegistry, constants)
tests/
├── unit/            модульные тесты
├── gigachat-v2/     зоны совместимости V2 (chat, tools, streaming, state, …)
├── regression/      паритет с V1 (files, mcp, oauth, reasoning, streaming, tools, vision)
└── fixtures/        входные/выходные фикстуры
docs/                документация (этот набор)
scripts/             probes, smoke, bench (вне lint/tsc-скоупа)
fixtures/            demo-проект для smoke/E2E
```

## Ежедневные гейты

Перед коммитом все четыре должны быть зелёными:

```bash
npx tsc --noEmit        # типы (strict), include: src/** + tests/**
bun test                # unit + regression + compat (offline)
npx biome check .       # линт + формат (без --write)
bun run build           # dist/index.js
```

Запустить через npm-скрипты: `bun run typecheck`, `bun test`, `bun run lint`,
`bun run build`.

## Правила кода

- **TypeScript strict**, `any` запрещён в скоупе
  (`src/gigachat/**`, `src/translation/**`, `src/core/**`, `src/streaming/**`,
  `src/types/**`, `tests/**`).
- Biome-скоуп совпадает с `tsconfig.include` (`src/**`, `tests/**`).
  `src/v2/**` и `src/utils/**` вне строгого скоупа, но `src/v2/**` — это
  каркас/legacy и **не меняется по поведению** без крайней необходимости
  (особенно `src/v2/translator.ts` и `src/v2/response.ts`).
- Никаких искусственных оптимизаций маппинга в ущерб корректности состояния
  (см. [`PERFORMANCE.md`](PERFORMANCE.md)).
- Секреты (Authorization, access_token, client_secret, credentials, тела
  файлов/промптов/ответов) **никогда** не логируются вне явного безопасного
  debug-режима; каждая debug-строка проходит через `redactSecrets`
  ([`SECURITY.md`](SECURITY.md), [`OBSERVABILITY.md`](OBSERVABILITY.md)).

## Тесты

```bash
bun test                              # всё
bun test tests/unit/observability.test.ts
bun test tests/gigachat-v2/           # зоны совместимости
bun test tests/regression/            # паритет V1
```

Правила:

- каждый статус `SUPPORTED` в [`COMPATIBILITY.md`](COMPATIBILITY.md) должен
  иметь тест или живую проверку;
- новые фикстуры кладите в `tests/fixtures/` рядом с существующими;
- регрессия V1 и V2 должна сохраняться одновременно;
- offline-тесты не ходят в сеть.

Длинная сессия (24 тура, детерминированно, CI-совместимо) —
`tests/unit/long-session.test.ts`; живой harness —
`scripts/smoke/run-long-session.sh`
([`LONG_SESSION.md`](LONG_SESSION.md)).

## Live-проверки (терминал с доступом к GigaChat)

В песочнице агента `api.giga.chat` недоступен, поэтому live-прогоны
выполняются на стороне пользователя:

```bash
# сквозной smoke (6 сценариев, изолированная XDG, секреты не печатаются)
scripts/smoke/run-smoke.sh --keep

# длинная сессия
scripts/smoke/run-long-session.sh --keep

# производительность: V1 vs V2 vs gpt2giga
scripts/bench/run-live-perf.sh --mode v2 --mode v1 --repeat 3
```

Все harness'ы читают credentials из живого `opencode.json`
(`SMOKE_SOURCE_CONFIG` / `PERF_SOURCE_CONFIG`, по умолчанию
`/mnt/c/OpnCod_Proj/opencode/local/config/opencode/opencode.json`) и работают в
отдельной XDG-директории, не трогая рабочую конфигурацию.

## Офлайн-бенчмарк

```bash
bun scripts/bench/mapping-bench.ts            # logs/mapping-bench.json
```

Сравнивает маппинг V1 и V2 (request / response-json / 200-кадровый стрим).
`scripts/**` вне `tsconfig.include` и biome-скоупа, поэтому не проверяется
`tsc`/`biome`; запуск — вручную. Методика и числа —
[`PERFORMANCE.md`](PERFORMANCE.md).

## Probes

`scripts/probe-*.ts` и `scripts/live-api-check.ts` — точечные проверки живого
API (response_format, files, builtin tools, состояние, стриминг). Они читают
credentials из `~/.config/opencode/opencode.json` (переопределяется
`GIGACHAT_OPENCODE_CONFIG`) и **не** печатают секреты. Запускать только из
терминала с доступом к GigaChat.

## Коммиты

- Атомарные коммиты: одна задача — один коммит, с префиксом
  `feat(...)/fix(...)/test(...)/docs(...)/perf(...)` и ссылкой на раздел плана
  (`§NN`).
- Не коммитить: `agents.md`, `планГигачат_переработанный.md`, `logs/`,
  `node_modules/`, `dist/`-артефакты, секреты.
  Проверьте `git status --short` перед коммитом.
- После каждого коммита — гейты (см. выше).
- Пуш выполняет владелец репозитория из своего терминала (в среде агента нет
  GitHub-аутентификации).

## Отладка

```bash
GIGACHAT_DEBUG=true        # [GigaCode] логи (секреты редактируются)
GIGACHAT_OBSERVABILITY=false   # выключить [OBS] при необходимости
```

Legacy-путь включается/выключается опцией `v2` (rollback) —
[`CONFIGURATION.md`](CONFIGURATION.md).
