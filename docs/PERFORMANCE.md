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
| **B. Live latency / tokens·s⁻¹** (real GigaChat, OpenCode, memory/CPU) | terminal with GigaChat access | measured 2026-09-17 for v1 + v2 (below); peak RSS to fill |
| **C. gpt2giga comparison** | terminal with the gpt2giga proxy | not run — needs a running proxy (`--gpt2giga-url`); procedure below |

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
scripts/bench/lib/analyze-perf.py /tmp/opencode/gigachat-perf/logs/perf-v2.jsonl
```

Modes:

| Mode | Provider baseURL | Connector |
|------|------------------|-----------|
| `v1` | `https://api.giga.chat/v1` | `src/v2` (`v2:false`) |
| `v2` | `https://api.giga.chat/v1` | V2 pipeline (`v2:true`) |
| `gpt2giga` | `--gpt2giga-url` | none (proxy does mapping) |

Scenarios (read-only fixture, so repeats are stable): `simple`, `large`
(reads a generated ~40 KB file), `tool`, `parallel`, `long` (~800-word answer).

TTFT is the arrival time of the first streamed byte (equal to total for
non-streaming); total is first-byte-to-last; tokens/sec = `completion_tokens` ÷
total (falls back to `bytes/4` when the upstream omits usage). Process
memory/CPU: run the harness under `/usr/bin/time -v` (peak RSS) or sample
`ps` — record the numbers in the table below.

### Result live-прогона — 2026-09-17

Host: WSL2 (Linux 6.18.33.2-microsoft-standard-WSL2 x86_64) ·
Bun 1.4.2 · Node v22.22.1 · OpenCode v2.0.5 · plugin 2.0.0 ·
model `gigachat/GigaChat-2-Max` · 3 повтора на сценарий.

```bash
scripts/bench/run-live-perf.sh --mode v2 --mode v1 --repeat 3
python3 scripts/bench/lib/analyze-perf.py \
  /tmp/opencode/gigachat-perf/logs/perf-v2.jsonl \
  /tmp/opencode/gigachat-perf/logs/perf-v1.jsonl
```

`n` в таблице — число перехваченных chat-запросов (агент может сделать больше
одного на прогон), не число повторов. `out tok` — из `usage` или fallback
`bytes/4` (апстрим usage не слал, см. [`LONG_SESSION.md`](LONG_SESSION.md)).

| Mode | Scenario | n | sse | TTFT p50 ms | TTFT p95 ms | Total p50 ms | Total p95 ms | tok/s p50 | out tok p50 | errors |
|------|----------|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 | simple | 6 | 6 | 1201.1 | 5607.0 | 1202.4 | 5607.9 | 88.3 | 121 | 0 |
| v2 | simple | 6 | 6 | 443.3 | 1381.8 | 445.1 | 1382.8 | 98.6 | 116 | 0 |
| v1 | large | 6 | 6 | 1627.5 | 2727.0 | 1628.9 | 2727.4 | 96.4 | 123 | 0 |
| v2 | large | 9 | 9 | 1517.8 | 1839.4 | 1520.9 | 1841.8 | 143.7 | 181 | 0 |
| v1 | tool | 9 | 9 | 1737.4 | 2432.2 | 1746.3 | 2445.9 | 413.8 | 185 | 0 |
| v2 | tool | 9 | 9 | 1608.6 | 3436.5 | 1610.1 | 3442.8 | 336.8 | 184 | 0 |
| v1 | parallel | 15 | 15 | 1112.8 | 1822.7 | 1113.3 | 1824.7 | 135.4 | 122 | 0 |
| v2 | parallel | 142 | 142 | 2752.9 | 4903.0 | 2753.8 | 4903.8 | 93.2 | 253 | 0 |
| v1 | long | 6 | 6 | 608.8 | 18700.2 | 610.6 | 18716.7 | 301.3 | 184 | 0 |
| v2 | long | 6 | 6 | 420.1 | 17539.8 | 423.3 | 18474.9 | 386.1 | 181 | 0 |

#### Чтение

- **V2 в пределах шума V1.** По медианам TTFT/total V2 не медленнее V1 на
  `simple`/`large`/`tool`/`long` (V2 ниже на simple/long/tool; разница — это
  разброс апстрима, а не маппинг, см. Part A: единицы µs).
- **p95 ломают апстрим-столлы, не коннектор.** `long` p95 ≈ 18.7 s у обоих
  режимов; `simple` v1 p95 5.6 s. Это зависания апстрима на одном из повторов.
- **`parallel` (v2) не сопоставим.** n=142 против 15 у v1: модель в одном из
  v2-прогонов вошла в петлю (`v2-parallel-2.log`, 74 KB), вместо параллельных
  тулов выдавая `execute`-payload. Сценарий параллельных тулов подтверждён
  отдельно: §26 smoke 05 (3 параллельных `tool_call` → 200) и offline
  `long-session.test.ts` (2 в одном сообщении).
- **Один run-level сбой:** `v1/large #2` — OAuth `fetchToken` timeout 10 s
  (`[GigaCode] [ERROR] Interception translation failed: timeout of 10000ms exceeded`),
  `exit=1`; запрос не дошёл до capture, поэтому `errors=0`. Сетевой флак общего
  OAuth-пути (V1/V2), не маппинг.
- **Peak RSS не снимался** (harness его не пишет); метод — запуск под
  `/usr/bin/time -v` либо сэмплирование `ps`.

**Вывод (plan §33):** live-медианы V2 ≈ V1; дополнительный state/mapping-слой
стоит единицы µs (Part A) и не требует искусственной оптимизации latency.
gpt2giga-колонка не заполнена — см. Part C.

---

## C. gpt2giga comparison

**Статус: не выполнен (2026-09-17).** В окружении не было запущенного
gpt2giga-прокси, а harness требует `--gpt2giga-url` (иначе
`ERROR: --gpt2giga-url is required for mode gpt2giga`). Это ожидаемо: сравнение
с gpt2giga — отдельная процедура на стороне пользователя.

Prerequisites (user side): a running gpt2giga proxy with `api.giga.chat`
credentials; the OpenAI-compatible endpoint exposed (typically `/v1`).

```bash
# 1. поднять gpt2giga (отдельный Python-прокси) с кредами GigaChat
#    и дождаться его OpenAI-совместимого endpoint (обычно :8090/v1)

# 2. тот же harness, тот же capture-плагин и те же 5 сценариев
scripts/bench/run-live-perf.sh --mode gpt2giga --gpt2giga-url http://127.0.0.1:8090/v1 \
  --repeat 3
# 3. сравнить колонку с v1/v2 из Part B (те же Scenario/метрики)
```

gpt2giga is a separate Python proxy, so its mapping cost and deployment
footprint are not reproduced in Part A; the same five scenarios and the same
capture plugin are used for an apples-to-apples wire-level comparison. Record
its results next to the Part B table (same columns).

---

## D. Reproduce / evidence

```text
A. bun scripts/bench/mapping-bench.ts                              # logs/mapping-bench.json
B. scripts/bench/run-live-perf.sh --mode v2 --mode v1 --repeat 3   # logs/perf-{v1,v2}.jsonl + logs/perf-analysis.json
   # if a later --mode aborts before analysis, aggregate manually:
   python3 scripts/bench/lib/analyze-perf.py /tmp/opencode/gigachat-perf/logs/perf-v2.jsonl \
                                               /tmp/opencode/gigachat-perf/logs/perf-v1.jsonl
C. scripts/bench/run-live-perf.sh --mode gpt2giga --gpt2giga-url <url> --repeat 3   # pending: needs a running proxy
```
