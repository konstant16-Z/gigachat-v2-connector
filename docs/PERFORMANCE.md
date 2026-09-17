# Performance — plan §33

Date: 2026-09-17
Scope: compare the **current connector (V1)** vs **connector V2** vs
**gpt2giga** on: TTFT, total latency, tokens/sec, request overhead, memory, CPU
for the scenarios *simple chat, large prompt, tool call, 5 parallel tools, long
stream*.

Split, because the sandbox has no `api.giga.chat` access and no GitHub push:

| Part | Where | Status |
|------|-------|--------|
| **A. Mapping overhead** (CPU/time of the translation layers, no network) | reproducible anywhere | measured (below) |
| **B. Live latency / tokens·s⁻¹** (real GigaChat, OpenCode, memory/CPU) | terminal with GigaChat access | measured 2026-09-17, combined v1+v2+gpt2giga (below); peak RSS not captured |
| **C. gpt2giga comparison** | terminal with the gpt2giga proxy | measured 2026-09-17 in the combined run (Part B table) |

All four code gates stay green: `npx tsc --noEmit`, `bun test` (314 tests),
`npx biome check .`, `bun run build`.

---

## A. Offline mapping overhead

Command:

```bash
bun scripts/bench/mapping-bench.ts            # prints the tables, writes logs/mapping-bench.json
bun scripts/bench/mapping-bench.ts --iterations 2   # more samples
```

Harness: `scripts/bench/mapping-bench.ts` — feeds the same request/response/SSE
fixtures through the V1 functions (`src/v2/translator.ts`, `src/v2/response.ts`)
and the V2 pipeline (`src/translation/v2-pipeline.ts`), warmup + timed loop,
injected per-op CPU via `process.cpuUsage()`. `trim` = 1%-trimmed mean (a few GC
pauses otherwise skew the mean; `mean`/`median`/`max` are in the JSON).

Environment: Bun 1.4.2, Node v26.3.0, linux/x64.

### Request mapping (OpenAI body → wire body) — µs per call

| Scenario | Engine | iters | trim | median | p95 | max | cpu |
|---|---|---:|---:|---:|---:|---:|---:|
| simple chat | V1 | 500 | 1.9 | 1.3 | 5.6 | 3485 | 12.6 |
| simple chat | **V2** | 500 | 7.6 | 6.1 | 18.4 | 133 | 20.6 |
| large prompt (~40 KB) | V1 | 200 | 3.3 | 2.4 | 9.2 | 55 | 28.0 |
| large prompt (~40 KB) | **V2** | 200 | 8.9 | 6.9 | 23.3 | 79 | 30.1 |
| tool call | V1 | 500 | 9.6 | 8.5 | 20.3 | 148 | 33.1 |
| tool call | **V2** | 500 | 11.3 | 8.4 | 29.7 | 3824 | 84.6 |
| 5 parallel tools | V1 | 500 | 8.5 | 7.5 | 19.9 | 10994 | 45.1 |
| 5 parallel tools | **V2** | 500 | 21.5 | 17.0 | 67.0 | 3517 | 67.5 |

### Response JSON mapping (GigaChat → OpenAI) — µs per call

| Scenario | Engine | iters | trim | median | p95 | max | cpu |
|---|---|---:|---:|---:|---:|---:|---:|
| simple chat | V1 | 500 | 0.5 | 0.4 | 1.0 | 35 | 1.1 |
| simple chat | **V2** | 500 | 2.3 | 1.9 | 4.8 | 55 | 6.4 |
| tool call | V1 | 500 | 0.6 | 0.5 | 1.4 | 1801 | 9.6 |
| tool call | **V2** | 500 | 2.5 | 2.0 | 5.6 | 50 | 10.7 |

### Long stream (200 SSE frames, construct + drain) — ms per stream

| Scenario | Engine | iters | trim ms | median ms | p95 ms | max ms | cpu µs/frame |
|---|---|---:|---:|---:|---:|---:|---:|
| 200 frames | V1 | 60 | 0.62 | 0.38 | 3.23 | 5.10 | 5.0 |
| 200 frames | **V2** | 60 | 1.21 | 0.87 | 3.42 | 7.65 | 12.1 |

### Reading

- **The V2 layers are cheap in absolute terms.** Per request the V2 pipeline
  adds single-digit microseconds (simple chat ≈ +5 µs, 5 parallel tools
  ≈ +10 µs) and per response ≈ +1.5 µs. For a 200-frame stream V2 costs
  ≈ +0.5 ms end-to-end, i.e. ≈ +2.4 µs/frame.
- **Against network time this is noise.** Real GigaChat round-trips are
  hundreds of ms (see §26 live observations); a few µs of mapping cannot move
  TTFT or total latency. The V2 state/`tool_state_id` layers are the intended
  cost and are explicitly *not* optimized away (plan §33).
- **Variance is scheduler/GC, not algorithmic.** Occasional multi-ms `max`
  values appear on both engines (JIT/GC/`Bun.gc`); the trimmed mean and median
  are the stable comparison. The stream benchmark is the noisiest and should be
  read as an order of magnitude.
- **Memory**: the harness records `heapDeltaBytes` per batch in
  `logs/mapping-bench.json`; deltas are dominated by GC timing, so no per-op
  allocation claim is made here. Live memory/CPU belongs to Part B.

**Conclusion (plan §33):** the V2 mapping/state layers are within a few µs of
V1 per operation. No artificial latency optimization is required or attempted.

---

## B. Live latency / tokens·s⁻¹ / memory / CPU

Harness: `scripts/bench/run-live-perf.sh` (isolated XDG, credentials copied
from the live config and never printed) + `scripts/bench/perf-plugin` (records
per-request TTFT, total, bytes, tokens, tokens/sec to JSONL) +
`scripts/bench/lib/analyze-perf.py` (percentile table → `logs/perf-analysis.json`).

```bash
# connector V2 vs current connector (V1), 3 repeats per scenario
scripts/bench/run-live-perf.sh --mode v2 --mode v1 --repeat 3

# one scenario, then inspect
scripts/bench/run-live-perf.sh --mode v2 --scenario long
scripts/bench/lib/analyze-perf.py /tmp/opencode/gigachat-combined.OfYsjm/work/logs/perf-v2.jsonl
```

Modes:

| Mode | Provider baseURL | Connector |
|------|------------------|-----------|
| `v1` | `https://api.giga.chat/v1` | `src/v2` (`v2:false`) |
| `v2` | `https://api.giga.chat/v1` | V2 pipeline (`v2:true`) |
| `gpt2giga` | `--gpt2giga-url` | none (proxy does mapping) |

Scenarios (read-only fixture, so repeats are stable): `simple`, `large`
(reads a generated ~40 KB file), `tool`, `parallel`, `long` (~800-word answer).

### Measurement definitions and limitations

- `ttft_ms` measures request-hook timestamp → first chunk read from the cloned
  response body. This is a first-byte proxy, **not time to first model token**;
  headers, role-only frames and buffering can affect it.
- `total_ms` measures the same request-hook timestamp → end of clone reading,
  including the wait before the first chunk. With a response body, non-streaming
  responses use the same reader; TTFT and total are not necessarily equal.
- `tokens_per_sec` = `out_tokens / total_ms × 1000`, not generation-only speed.
  `out_tokens` precedence: a real `usage` on the translated surface
  (`usage_source="upstream"`), then the optional non-streaming probe
  (`"probe"`, see the harness note below), then an estimate (`"estimate"`)
  computed as `round(chars / 4)` over **generated text only**
  (`delta.content`, `reasoning_content`, tool-call name+arguments), excluding
  SSE protocol frames; `estimate_tokens` is always recorded for transparency.
  Even the estimate is not a tokenizer — prefer `upstream`/`probe` when
  comparing modes. The 2026-09-17 combined-run numbers below predate this
  estimate change and the probe, so their `out tok`/`tok/s` still use the older
  whole-body `text.length / 4`.
- Percentiles select sorted element `round(p × (n−1))` (Python rounding), with
  no interpolation. For even sample sizes, reported p50 can differ from the
  conventional median (average of the two middle values).
- `errors` counts captured HTTP statuses ≥400 only. SSE errors under HTTP 200,
  interrupted reads and failures before capture are not represented reliably.
  The capture reader swallows read exceptions; `exit=0` and `errors=0` alone
  do not establish semantic completion of every scenario.
- Without `RqUID`, correlation uses a method+URL FIFO. Concurrent responses
  arriving out of order can be paired with the wrong request timestamp; a
  missing response can also leave a stale queue entry. These effects can bias
  latency percentiles, not just record attribution.
- Modes run sequentially, not interleaved or randomized. Even one combined
  invocation does not control upstream load, caching, request mix or tool loops.

Process memory/CPU was not captured here. `/usr/bin/time -v` or `ps` sampling
requires an explicit process scope; measuring the harness alone does not
establish the peak memory of the separate proxy and all OpenCode processes.

**V2 streaming usage (2026-09-17).** The V2 pipeline now emits a trailing
usage-only chunk (`choices: []`, the OpenAI `stream_options.include_usage`
shape) when the upstream `response.message.done` carries `usage` — see
`src/streaming/opencode.ts`. V1 streaming is unchanged and still omits it. The
result tables below come from runs **after** this change, so v2 `out tok`/`tok/s`
are usage-derived (`usage_source="upstream"`); v1 stays on the harness estimate
(or the optional `probe`).

The OpenCode client accepts the chunk: the E2E smoke re-run after this change
passed every scenario on attempt 1 (2026-09-17, 33 V2 requests). In the captured
records the `usage` payload is the OpenAI shape (`completion_tokens`/
`prompt_tokens`) emitted by `src/streaming/opencode.ts`, not the upstream V2
`input_tokens`/`output_tokens`, i.e. the harness observed the connector surface
itself.

**Harness token accounting (2026-09-17).** The capture plugin now has two
independent improvements (both benchmark-side; V1/connector behaviour is not
changed):

1. The fallback estimate counts generated text only, not the SSE protocol.
2. `scripts/bench/run-live-perf.sh --usage-probe` replays each streamed v1/v2
   chat request non-streaming over a raw `node:http(s)` connection (bypassing
   the session/connector hooks, so no double translation) and reads the raw
   upstream `usage` (`usage_source="probe"`). The replay starts **after** the
   stream finished (so it no longer competes with the measured request) and
   retries on 429/5xx with a small backoff. It still roughly doubles upstream
   requests — use it for a dedicated usage/`tok/s` reference run, **not** for
   the latency numbers. A first version ran the replay concurrently; a live run
   with it is recorded under «Usage-probe …» below.
3. Responses with HTTP status ≥400 are excluded from the latency / `tok/s` /
   `out tok` aggregates — their timing is a retry artifact and the connector
   never surfaced their tokens. They still count toward `n`/`errors`; the table
   also prints `ok` (non-error records).
4. Each record carries `run_id` (`mode-scenario-repeat`); the harness collects
   runs that hit `PERF_RUN_TIMEOUT` (`exit=124`) and passes them as
   `PERF_EXCLUDE_RUNS`, so an agent/tool loop never enters the aggregates.

Records carry `usage_source` (`upstream` | `probe` | `estimate`) and
`estimate_tokens`; the analyzer prints the per-group source breakdown (see the
result tables below).

### Usage-probe: exploratory live run — 2026-09-17

Separate from the canonical run below, a full combined run was executed **with**
the first, concurrent version of `--usage-probe` (before the post-stream/backoff
rework):

```bash
scripts/bench/run-live-perf.sh --mode v1 --mode v2 --mode gpt2giga \
  --gpt2giga-url http://127.0.0.1:8090/v2 --repeat 3 --usage-probe
```

What it established:

- **The probe works against the real upstream.** Raw `node:https` reaches
  `api.giga.chat` (CA via `PERF_CA_PEM`/`NODE_EXTRA_CA_CERTS`), bypasses the
  session hooks and returns real `usage` for v1, e.g. v1 `large`
  `{prompt: 14562, completion: 46}` with `usage_source="probe"`.
- **Coverage:** v1 25/45 `probe`, v2 38/40 `upstream`, gpt2giga 34/49
  `upstream`; the rest fell back to `estimate`.
- **The concurrent replay triggers upstream rate limiting:** captured
  `status=429` in v1 ×3 and v2 ×2 (gpt2giga 0). The connector retried and every
  scenario completed, but the doubled load inflates this run's latency — TTFT
  p50 rose well above the non-probe combined run (e.g. v2 `simple` 1307 vs
  345 ms). **These are not valid latency numbers.**
- Real completion tokens are now plausible across modes (e.g. `long` main
  generation ≈1016–1230 for v2 and ≈1217–1274 for gpt2giga, small requests
  4–15), but v1's main `long` generation was not probed, so coverage is
  incomplete.

This is why the probe now runs after the stream with a 429/5xx backoff, and the
harness tags each record with a `run_id` so runs cut off by `PERF_RUN_TIMEOUT`
(`exit=124`) are dropped from the aggregates. The two follow-up runs below use
both changes.

### Result live-прогонов — 2026-09-17 (combined v1/v2/gpt2giga)

Два отдельных combined-прогона, по 5 сценариев × 3 повтора каждый; ни один
запуск не упёрся в кап (`exit=124` нет):

```bash
# 1) latency run — без probe (канонические latency)
scripts/bench/run-live-perf.sh --mode v1 --mode v2 --mode gpt2giga \
  --gpt2giga-url http://127.0.0.1:8090/v2 --repeat 3
# 2) usage-reference run — реальный upstream usage для v1
scripts/bench/run-live-perf.sh --mode v1 --mode v2 --mode gpt2giga \
  --gpt2giga-url http://127.0.0.1:8090/v2 --repeat 3 --usage-probe
```

Host: WSL2 (Linux 6.18.33.2-microsoft-standard-WSL2 x86_64) ·
Bun 1.4.2 · Node v22.22.1 · OpenCode v2.0.5 · plugin 2.0.0 ·
model `gigachat/GigaChat-2-Max`.

`n` — число перехваченных chat-запросов (агент делает больше одного на прогон),
не число повторов; `ok` — из них не ошибочные. См. ограничения выше: `exit=0`
и `errors=0` не доказывают семантическую полноту каждого стрима.

**Latency run (без probe).** Все ответы `status=200`. `usage src`: у v1 —
`estimate` (V1 streaming не несёт `usage`, probe здесь выключен), у v2/gpt2giga —
реальный upstream `usage`.

| Mode | Scenario | n | ok | sse | TTFT p50 ms | TTFT p95 ms | Total p50 ms | Total p95 ms | tok/s p50 | out tok p50 | errors | usage src |
|------|----------|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| v1 | simple | 6 | 6 | 6 | 585.7 | 1263.2 | 587.6 | 1269.1 | 0.8 | 1 | 0 | estimate:6 |
| v1 | large | 9 | 9 | 9 | 1705.6 | 1895.7 | 1706.7 | 1896.1 | 12.4 | 8 | 0 | estimate:9 |
| v1 | tool | 9 | 9 | 9 | 1848.7 | 3313.1 | 1849.1 | 3313.5 | 16.3 | 10 | 0 | estimate:9 |
| v1 | parallel | 15 | 15 | 15 | 1094.7 | 2874.6 | 1095.0 | 2884.2 | 7.6 | 8 | 0 | estimate:15 |
| v1 | long | 6 | 6 | 6 | 363.1 | 17342.9 | 364.8 | 18818.2 | 21.3 | 7 | 0 | estimate:6 |
| v2 | simple | 6 | 6 | 6 | 436.6 | 1883.8 | 439.6 | 1885.2 | 7.6 | 4 | 0 | upstream:6 |
| v2 | large | 9 | 9 | 9 | 1551.0 | 2945.0 | 1554.3 | 2949.0 | 18.7 | 27 | 0 | upstream:9 |
| v2 | tool | 9 | 9 | 9 | 1615.1 | 2643.1 | 1617.2 | 2652.1 | 23.2 | 36 | 0 | upstream:9 |
| v2 | parallel | 11 | 11 | 11 | 1590.3 | 3939.2 | 1596.8 | 3961.2 | 45.0 | 79 | 0 | upstream:11 |
| v2 | long | 6 | 6 | 6 | 421.8 | 16402.5 | 434.4 | 19622.6 | 29.1 | 10 | 0 | upstream:6 |
| gpt2giga | simple | 9 | 9 | 9 | 216.0 | 696.9 | 216.0 | 697.0 | 13.1 | 4 | 0 | estimate:3 upstream:6 |
| gpt2giga | large | 12 | 12 | 12 | 1067.4 | 1532.5 | 1067.9 | 1536.4 | 31.1 | 33 | 0 | estimate:3 upstream:9 |
| gpt2giga | tool | 11 | 11 | 11 | 1074.1 | 2526.5 | 1074.5 | 2536.5 | 31.4 | 36 | 0 | estimate:3 upstream:8 |
| gpt2giga | parallel | 19 | 19 | 19 | 2540.5 | 5245.1 | 2541.1 | 5266.6 | 43.2 | 132 | 0 | estimate:3 upstream:16 |
| gpt2giga | long | 9 | 9 | 9 | 294.3 | 14394.3 | 294.9 | 19859.3 | 32.0 | 10 | 0 | estimate:3 upstream:6 |

**Usage-reference run (`--usage-probe`).** Здесь у v1 реальный upstream `usage`:
28/28 перехваченных запросов `probe` (0 `estimate`). На `simple`/`tool`/`parallel`
probe и контентная оценка согласуются (`out tok` 7–38 при `estimate` 7–8), а на
`long` этот прогон случайно попал на короткие ответы модели (все три повтора
~10 токенов, `out_bytes` ≈ 730), поэтому v1 `long` там нерепрезентативен —
берите latency-run оценку. v2 — 38/38 `upstream`, gpt2giga — 37 `upstream` +
15 `estimate`. См. вставку про probe выше: replay — это отдельная
не-стриминговая генерация, а не точный пересчёт стрима.

#### Чтение

- **V2 в пределах апстрим-шума V1.** По TTFT p50 (latency run) V2 сопоставим на
  `large` (1551 vs 1706), `tool` (1615 vs 1849) и `long` (422 vs 363), ниже на
  `simple` (437 vs 586), выше на `parallel` (1590 vs 1095). Разброс апстрима на
  порядок больше µs-вклада маппинга (Part A), поэтому это не выделяет V2 как
  систематически «медленнее» или «быстрее».
- **`tok/s` / `out tok` теперь usage-derived у v2/gpt2giga** (`upstream`), у v1 —
  контентная оценка (V1 streaming не несёт `usage`; в usage-run v1 покрыт
  `probe`). Но `out tok p50`/`tok/s p50` смешивают служебные и основные запросы
  внутри сценария: на `long` p50 ≈ 10, тогда как max `out tok` — **1388** (v1,
  estimate), **1177** (v2, upstream), **1282** (gpt2giga, upstream). Для основной
  генерации смотрите max, а не p50.
- **p95 ломают апстрим-столлы, не коннектор.** `long` p95: 17.3 s (v1),
  16.4 s (v2), 14.4 s (gpt2giga); Total p95 до 19.9 s. Это зависания апстрима
  на отдельных повторах.
- **`parallel` — нестабильный для агента сценарий.** В части прогонов
  2026-09-17 агент уходил на этом промпте в петлю — причём **и у v2, и у
  gpt2giga**, а не только у V2 (до сотен одинаковых запросов); запуск резался
  `PERF_RUN_TIMEOUT` (300 с, `exit=124`). Это поведение агента/модели, а не
  коннектора (воспроизводится без V2), и такие запуски теперь автоматически
  исключаются по `run_id`. В этой latency-таблице петли нет (v2 n=11,
  gpt2giga n=19).
- **Usage-reference run:** v1 28/28 `probe`, v2 38/38 `upstream`, gpt2giga
  37 `upstream` + 15 `estimate`. Реальные `completion_tokens` подтверждают
  порядок величин; см. оговорку про replay выше.
- **Один `exit=1`:** `v1/large #3` (agent-level), при этом все перехваченные
  запросы `status=200`; на latency-таблицу не влияет.
- **Peak RSS не снимался** (см. ограничения выше); метод — `/usr/bin/time -v`
  либо сэмплирование `ps` с явным указанием процессов.

**Вывод (plan §33):** в combined-прогонах медианы V2 и gpt2giga лежат в
диапазоне апстрим-шума V1; дополнительный state/mapping-слой V2 стоит единицы µs
(Part A) и не требует искусственной оптимизации latency. Токены у v2/gpt2giga
теперь usage-derived, у v1 — реальные на `probe`-прогоне и оценка на
latency-прогоне. Сравнение индикативное: прогоны последовательные, не
interleaved, и ограничения выше применяются.

---

## C. gpt2giga comparison

**Статус: измерено 2026-09-17 (latency run, тот же, что Part B)**
(`--mode v1 --mode v2 --mode gpt2giga`). gpt2giga `0.3.0` — отдельный
Python-прокси на `127.0.0.1:8090` с теми же GigaChat-кредами; форвардит на
`https://api.giga.chat/v2/chat/completions`. Строки `gpt2giga` — в таблице
Part B; ниже сведены TTFT p50 по сценариям.

| Scenario | v1 | v2 | gpt2giga |
|---|---:|---:|---:|
| simple | 585.7 | 436.6 | 216.0 |
| large | 1705.6 | 1551.0 | 1067.4 |
| tool | 1848.7 | 1615.1 | 1074.1 |
| parallel | 1094.7 | 1590.3 | 2540.5 |
| long | 363.1 | 421.8 | 294.3 |

### Чтение

- **Порядок величины один у всех трёх режимов.** Разница между режимами
  (десятки–сотни мс) меньше вклада апстрима и его столов; µs-уровень маппинга
  (Part A) в этих числах не виден. gpt2giga ниже почти везде (`simple`,
  `large`, `tool`, `long`), но выше на `parallel`; прогон последовательный
  (не interleaved), поэтому разницу нельзя приписать исключительно прокси или
  коннектору.
- **`tok/s` / `out tok` теперь usage-derived:** у gpt2giga и v2 — реальный
  upstream `usage`, у v1 — контентная оценка (в usage-run — реальный `probe`).
  Основную генерацию `long` (max `out tok`) сравнивать можно: 1177 (v2) против
  1282 (gpt2giga) при оценке v1 1388.
- **gpt2giga — валидная benchmark-цель.** Все перехваченные ответы `200`,
  9–19 запросов на сценарий; код gpt2giga не копировался
  (см. [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)).

### Prerequisites / pitfalls (для повторного прогона)

- Прокси должен читать `.env` **явно**: `gpt2giga --env-path "$HOME/gpt2giga-bench/.env"`.
  Pydantic-settings читает `.env` в свой конфиг и **не** экспортирует переменные
  в окружение процесса, поэтому проверка `/proc/<pid>/environ` на
  `GIGACHAT_CA_BUNDLE_FILE` ничего не доказывает.
- GigaChat из WSL требует российский Trusted Root CA. Без
  `GIGACHAT_CA_BUNDLE_FILE=<russian_trusted_root_ca.pem>` прокси падает с
  `ConnectError: [SSL: CERTIFICATE_VERIFY_FAILED]`. Файл CA — тот же, что у
  Node: `local/config/opencode/certs/russian_trusted_root_ca.pem`.
- Capture в harness для режима `gpt2giga` требует фикса `f8656a0`: плагин
  матчит URL прокси через `PERF_MATCH` (раньше только `/giga|sberbank/`) и
  сопоставляет запрос/ответ по FIFO `method+url`, когда нет заголовка `RqUID`
  (коннектор не загружен).

---

## D. Reproduce / evidence

```text
A. bun scripts/bench/mapping-bench.ts                              # logs/mapping-bench.json
B. scripts/bench/run-live-perf.sh --mode v1 --mode v2 --mode gpt2giga \
     --gpt2giga-url http://127.0.0.1:8090/v2 --repeat 3            # combined: perf-{v1,v2,gpt2giga}.jsonl + logs/perf-analysis.json
   # evidence (2026-09-17): /tmp/opencode/gigachat-combined.OfYsjm/{run.log,combined-analysis.json,work/logs}
C. # requires a running gpt2giga proxy started with an explicit --env-path
   # that includes GIGACHAT_CA_BUNDLE_FILE (see Part C pitfalls)
```
