# Release gate, rollback & final checklist

Результаты release-гейта (plan §36), процедура rollback (§37) и финальная
сверка (§39). Часть гейтов воспроизводима в песочнице, часть требует живого
доступа к GigaChat и выполняется владельцем репозитория.

## Сводка

| Гейт | Где проверяется | Результат |
|---|---|---|
| Clean install | песочница (изолированная копия) | **PASS** |
| Static checks (`lint`, `typecheck`, `build`) | песочница | **PASS** |
| Unit / regression | песочница | **PASS** (314/0) |
| Integration | живой GigaChat | ⏳ user |
| OpenCode E2E | живой GigaChat | ⏳ user |
| Long session (20–30+ инструментов) | offline 24 тура + live harness | offline **PASS**, live ⏳ user |
| Security (logs / temp files / секреты) | песочница | **PASS** |
| Final compatibility matrix | [`COMPATIBILITY.md`](COMPATIBILITY.md) | поддерживается |
| Rollback (offline) | регрессия V1 | **PASS**, live ⏳ user |

## Clean install (§36)

Изолированная копия дерева без `node_modules`/`dist`/`logs`:

```bash
mkdir -p /tmp/opencode/release-check
tar --exclude=./node_modules --exclude=./.git --exclude=./dist \
    --exclude=./logs -cf - . | (cd /tmp/opencode/release-check && tar -xf -)
cd /tmp/opencode/release-check
bun install --frozen-lockfile     # 35 packages, ok
```

Чистая установка по lockfile проходит (`bun install --frozen-lockfile`).

## Static checks (§36)

```bash
npm run lint        # biome check .  → 76 files, no fixes
npm run typecheck   # tsc --noEmit   → ok
npm run build       # dist/index.js  → 0.58 MB (entry point)
```

## Unit / regression (§36)

```bash
npm test            # 314 pass / 0 fail / 1513 expect (39 files)
```

## Integration / OpenCode E2E / Long session (§36) — user

В репозитории нет suite, гейтируемого `GIGACHAT_INTEGRATION`; интеграция и E2E
реализованы как живые harness'ы, работающие в изолированной XDG-среде:

```bash
# OpenCode E2E: 6 сценариев (chat, fix+test, add tests, run, parallel tools, MCP)
scripts/smoke/run-smoke.sh --keep

# Long session: 20-30+ tool interactions
scripts/smoke/run-long-session.sh --keep

# Производительность (V1 / V2 / gpt2giga)
scripts/bench/run-live-perf.sh --mode v2 --mode v1 --repeat 3
```

Критерии приёмки и шаблон результатов — в
[`LONG_SESSION.md`](LONG_SESSION.md) и [`PERFORMANCE.md`](PERFORMANCE.md).
Offline-эквивалент длинной сессии (детерминированный, CI) —
`tests/unit/long-session.test.ts` (24 тура) — зелёный.

## Security (§36)

- `.gitignore`: `node_modules/`, `dist/`, `*.log`, `logs/` — генеративные
  артефакты и логи не коммитятся.
- Среди отслеживаемых файлов нет `secret`/`credential`/`.env`/`token`-файлов.
- Сканирование git-tracked файлов на захардкоженные Base64 Basic-креды и
  `access_token`-литералы: единственное совпадение — **пример токена в
  официальной OpenAPI-спеке** [`docs/external/gigachat-api.yml`](external/gigachat-api.yml)
  (публичный пример из документации Сбера, не живой секрет).
- Live-харнессы (`scripts/smoke/*`, `scripts/bench/*`) копируют credentials в
  изолированную XDG-конфигурацию программно и **никогда** не печатают их;
  perf-плагин пишет только тайминги/счётчики.
- `[GigaCode] [OBS]` не содержит контента (тел, промптов, заголовков) и
  дополнительно проходит через `redactSecrets`; см. [`OBSERVABILITY.md`](OBSERVABILITY.md)
  и [`SECURITY.md`](SECURITY.md).

## Rollback (§37)

Эквивалент `GIGACHAT_API_VERSION=v2` — опция `v2` в `plugins[].options`:

```jsonc
"options": { "v2": true }    // V2 pipeline
"options": { "v2": false }   // legacy V1 (rollback)
```

Гарантии:

- **Практически проверен (offline).** V1-ветка `plugin.ts` не менялась по
  поведению; паритет V1 зафиксирован регрессионным набором
  (`tests/regression/**`, `tests/unit/*`) — 314 тестов зелёные.
- **Без ручного патчинга.** Переключение — одна опция конфигурации; бандл не
  правится.
- **Credentials не ломаются.** Источники и OAuth-логика общие для V1 и V2;
  повторного ввода ключа не требуется.
- **Состояние не смешивается.** `SessionToolStateStore` (`tool_state_id`)
  используется только V2-путём; legacy `functions_state_id` идёт verbatim.
  При `v2:false` V2-store не читается и не пишется.
- **Legacy-код сохраняется** до подтверждения V2 живым E2E (plan §38 RULE 15);
  удаление V1 не выполняется.

Живая проверка rollback — за пользователем.

## Final compatibility matrix (§39)

Источник истины — [`COMPATIBILITY.md`](COMPATIBILITY.md). Правило: статус
`SUPPORTED`/`PARTIAL` ставится только при наличии теста или живой проверки.

Известные открытые строки (не блокеры релиза, задокументированы):

- 3D / image generation — wire-записи есть, end-to-end не реализовано;
- HTTP(S)-URL изображения — не ингестятся (только data URL / `file.id`);
- `code_interpreter` — намеренно не регистрируется (живой 422);
- MCP — `PARTIAL`, изменений в плагине не требуется (см. [`MCP.md`](MCP.md)).

## Остаётся на стороне пользователя

1. **Пуш**: `cd /mnt/c/OpnCod_Proj/gigachat-v2-connector && git push origin main`
   (в среде агента нет GitHub-аутентификации).
2. **Live-прогоны**: `run-smoke.sh`, `run-long-session.sh`,
   `run-live-perf.sh` — вписать результаты в
   [`LONG_SESSION.md`](LONG_SESSION.md) / [`PERFORMANCE.md`](PERFORMANCE.md).
3. **Ротация секретов** (closeout): перевыпустить base64-`credentials` и
   старый PAT; после ротации повторить live-смок.
4. **Живая проверка rollback** (`v2:false`) и повторный E2E.
