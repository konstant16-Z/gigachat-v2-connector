# Long-session test (§27)

PHASE 12 §27 проверяет коннектор на **длинной сессии**: 20–30 tool-интеракций в
одном разговоре, а не в изолированных одношаговых сценариях §26.
Плановая последовательность:

```text
inspect repository → find files → modify 3 files → run tests
→ inspect failure → fix → run tests → review diff
```

Проверяются: tool IDs, tool state, context, streaming, reasoning, errors,
token usage, concurrency, cancellation.

Тест существует в двух слоях:

| Слой | Файл | Сеть | Запускается |
|---|---|---|---|
| Offline (детерминированный) | `tests/unit/long-session.test.ts` | не нужна | `bun test` (CI) |
| Live E2E (реальный OpenCode + GigaChat) | `scripts/smoke/run-long-session.sh` | нужна | вручную, где доступен `api.giga.chat` |

## 1. Offline-слой

`tests/unit/long-session.test.ts` прогоняет **24 последовательных тура**
(~27 tool-интеракций) через настоящий `createV2Pipeline`, без сети:

```text
chatRequest (history → V2 wire) → upstream V2 response → jsonResponse
(V2 → OpenCode) → assistant + tool results в историю → следующий тур
```

Покрытие чек-листа:

| Пункт | Как проверяется |
|---|---|
| tool IDs | id с провода сохраняются, `call_<n>` последовательны и уникальны в сессии |
| tool state | `tool_state_id` → `functions_state_id` инъектится в следующий запрос (натуральный round-trip) |
| context | каждое сообщение истории доходит до провода, в порядке; история растёт |
| streaming | SSE-тур: reasoning + text + два tool_call + `[DONE]`, state захвачен на flush |
| reasoning | `reasoning_content` из SSE отражается в OpenCode-чанке |
| errors | malformed-ответ — контролируемая ошибка, state не портится |
| token usage | usage монотонно накапливается по турам |
| concurrency | одно assistant-сообщение с двумя параллельными tool_call |
| cancellation | отмена стрима пробрасывается в источник и не ломает сессию |

Запуск:

```bash
bun test tests/unit/long-session.test.ts
```

## 2. Live-слой

`scripts/smoke/run-long-session.sh` гоняет **одну** сессию OpenCode
(`opencode run --session <id>`) по шагам плана, изолированно от личного
конфига (`/tmp/opencode/gigachat-smoke-long`), и завершает анализом
`scripts/smoke/lib/analyze-long-session.py`.

### Предусловия

- сетевой доступ к `api.giga.chat` (там же, где обычно идёт §26 smoke);
- live-конфиг с `credentials` — путь по умолчанию
  `/mnt/c/OpnCod_Proj/opencode/local/config/opencode/opencode.json`;
- CA-бандл — по умолчанию
  `/mnt/c/OpnCod_Proj/opencode/local/config/opencode/certs/russian_trusted_root_ca.pem`;
- `opencode`, `bun`, `python3`, `git` в `PATH`.

### Запуск

```bash
cd /mnt/c/OpnCod_Proj/gigachat-v2-connector
scripts/smoke/run-long-session.sh          # полный прогон (~10 туров) + анализ
scripts/smoke/run-long-session.sh --keep   # оставить scratch для разбора
scripts/smoke/run-long-session.sh --analyze-only   # только анализ (root уже есть)
```

Переменные окружения: `SMOKE_ROOT`, `SMOKE_SOURCE_CONFIG`, `SMOKE_CA_PEM`,
`SMOKE_MODEL` (по умолчанию `gigachat/GigaChat-2-Max`), `SMOKE_MIN_TOOLS`.

### Что делает скрипт

1. билдит плагин (`bun run build`), готовит scratch XDG-изоляцию;
2. копирует фикстуру `fixtures/opencode-project` в scratch и делает `git init`
   (чтобы шаг «review diff» был осмысленным; репо-фикстура не трогается);
3. прогоняет ~10 шагов **в одной сессии** (первый — создаёт её, дальше
   `--session <id>`): inspect / read / write tests / run / inspect failure /
   fix factorial / fix isEven / review diff / parallel tools / final review;
4. проверяет, что `bun test` в фикстуре зелёный (retry один раз с чистой
   копии при апстрим-флаке);
5. запускает анализатор и (best-effort) cancellation-пробу с `SIGINT`.

### Анализатор: источники улик

- `data/opencode/opencode.db` — `session_v2` (токен-счётчики) и
  `session_message` (assistant tool-части: `id`, `name`, `time.streamed`);
- `logs/outbound-dump.log` — строки capture-плагина:
  `REQ … model=… fstate=<yes|no> tools=<n> msgs=<n>` и
  `RESP … ctype=… sse=<yes|no> reasoning=<yes|no> usage=<yes|no>`.

### Проверки анализатора

| Проверка | Уровень | Улика |
|---|---|---|
| tool interactions ≥ `--min-tools` | hard | число tool-частей в сессии |
| tool IDs (`call_<n>`, последовательны) | hard | `content[].id` по сообщениям |
| streaming | hard | `time.streamed` и/или `sse=yes` |
| context accumulation | hard | рост `bytes=` в REQ-строках |
| V2 route на каждом запросе | hard | `url=…/v2/chat/completions` |
| все ответы 200 | hard | `RESP status=` |
| tool state round-trip | soft | `fstate=yes` в ≥2 запросах |
| concurrency (≥2 tool_call) | soft | max tool-частей в одном сообщении |
| reasoning | soft | `reasoning=yes` |
| usage | soft | `usage=yes` |

`soft` не валит прогон (`--strict` делает их жёсткими): модель/апстрим может
законно не прислать reasoning или usage в конкретном прогоне.

### Артефакты

- `logs/NN-<step>.log` — stdout каждого тура;
- `logs/final-fixture-bun-test.log` — финальный `bun test`;
- `logs/outbound-dump.log` — маршрут + флаги улик;
- `logs/long-session-analysis.json` — машинный итог (counts + checks);
- `logs/cancel-probe.log`, `logs/cancel-recovery.log` — cancellation-проба.

### Cancellation

Детерминированно проверяется в offline-слое (проброс отмены + выживание
сессии). Live-проба делает `SIGINT` длинной генерации через `timeout -s INT`
и затем контрольный тур; она **не фатальна** — тайминг зависит от окружения.

## Результат live-прогона

Прогон: 2026-09-17, `scripts/smoke/run-long-session.sh --keep`,
модель `gigachat/GigaChat-2-Max`.

```text
Сессия:            ses_f51d1fbf3ffeNs2UibjUKCLstx (одна сессия, 10 шагов)
Туры / tool calls: 10 / 22
Параллельные тулы: max 1 в одном шаге (WARN)
Streaming:         32/32 assistant msgs streamed, 33 SSE resp
State round-trip:  22 запроса несли functions_state_id
Context:           first=2555 → max=207923 bytes
V2 route:          33/33 → /v2/chat/completions
Статусы:           33/33 200
Reasoning/usage:   0/33 / 0/33 (WARN)
Cancellation:      probe rc=0, recovery rc=0
Fixture tests:     PASS
Анализатор:        hard FAIL 0, soft WARN 3
Итог:              PASS
```

Шаги: `inspect-repo → read-modules → write-tests → run-tests →
inspect-failure → fix-factorial → fix-iseven → review-diff → parallel-tools →
final-review` — все `exit=0`.

### Разбор soft WARN

| WARN | Наблюдение | Причина и где покрыто |
|---|---|---|
| concurrency | в этой сессии max 1 tool-call на шаг | модель не выпустила параллельные тулы; §26 smoke сценарий 05 даёт 3 параллельных `tool_call` (200), offline `long-session.test.ts` — 2 в одном сообщении |
| reasoning | 0/33 ответов с `reasoning_content` | `GigaChat-2-Max` его не отдавал; `capabilities.reasoning` включается выбором reasoning-модели. Offline-тур проверяет проброс `reasoning_content` из SSE |
| usage | 0/33 ответов с `usage` | live-апстрим не прислал `usage` ни в одном SSE-кадре (capture читал тела 562–762 байт, совпадений нет), поэтому и счётчики сессии `in=0 out=0`. Offline-тур проверяет монотонный рост usage |

Все три — `soft` по замыслу (§27): модель/апстрим может законно не отдать
конкретное поле в конкретном прогоне; `--strict` переводит их в жёсткие.

См. также `docs/LIVE_API_OBSERVATIONS.md` §12 (§26 smoke) — long-session
дополняет его, не заменяя.
