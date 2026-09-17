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
  Where `usage` is absent, the implementation uses `round(text.length / 4)` on
  the **entire decoded SSE text**, including protocol fields. This is neither
  a byte count nor a reliable completion-token estimate; do not compare it with
  usage-derived token throughput.
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

### Result live-прогона — 2026-09-17 (combined v1/v2/gpt2giga)

Host: WSL2 (Linux 6.18.33.2-microsoft-standard-WSL2 x86_64) ·
Bun 1.4.2 · Node v22.22.1 · OpenCode v2.0.5 · plugin 2.0.0 ·
model `gigachat/GigaChat-2-Max` · 3 повтора на сценарий.

```bash
# все три режима в одной сессии, 5 сценариев × 3 повтора (45 запусков)
scripts/bench/run-live-perf.sh --mode v1 --mode v2 --mode gpt2giga \
  --gpt2giga-url http://127.0.0.1:8090/v2 --repeat 3
```

`n` в таблице — число перехваченных chat-запросов (агент может сделать больше
одного на прогон), не число повторов. Все 45 запусков `exit=0`; все
перехваченные ответы `status=200`. См. ограничения измерений выше — `exit=0` и
`errors=0` не доказывают семантическую полноту каждого стрима.

| Mode | Scenario | n | sse | TTFT p50 ms | TTFT p95 ms | Total p50 ms | Total p95 ms | tok/s p50 | out tok p50 | errors |
|------|----------|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 | simple | 5 | 5 | 836.6 | 1447.5 | 838.2 | 1448.3 | 165.8 | 139 | 0 |
| v1 | large | 8 | 8 | 1950.7 | 4081.9 | 1951.2 | 4082.3 | 96.7 | 164 | 0 |
| v1 | tool | 8 | 8 | 1870.1 | 4494.1 | 1870.4 | 4513.5 | 336.8 | 185 | 0 |
| v1 | parallel | 15 | 15 | 1384.2 | 2788.9 | 1384.7 | 2795.7 | 110.0 | 122 | 0 |
| v1 | long | 6 | 6 | 1739.5 | 50721.0 | 1741.2 | 52875.4 | 259.2 | 185 | 0 |
| v2 | simple | 6 | 6 | 345.0 | 1601.9 | 346.7 | 1603.5 | 84.7 | 116 | 0 |
| v2 | large | 8 | 8 | 1865.7 | 2490.4 | 1867.0 | 2492.4 | 133.3 | 181 | 0 |
| v2 | tool | 9 | 9 | 1893.3 | 6283.3 | 1897.1 | 6289.3 | 293.8 | 181 | 0 |
| v2 | parallel | 9 | 9 | 1901.2 | 4106.2 | 1911.5 | 4107.6 | 391.9 | 259 | 0 |
| v2 | long | 6 | 6 | 415.1 | 23000.0 | 417.4 | 29442.9 | 338.4 | 181 | 0 |
| gpt2giga | simple | 9 | 9 | 405.7 | 1351.1 | 405.8 | 1356.2 | 17.8 | 9 | 0 |
| gpt2giga | large | 11 | 11 | 1191.3 | 2345.3 | 1192.1 | 2346.3 | 27.3 | 30 | 0 |
| gpt2giga | tool | 10 | 10 | 1426.3 | 2185.2 | 1432.6 | 2185.6 | 25.0 | 36 | 0 |
| gpt2giga | parallel | 9 | 9 | 1733.3 | 3704.4 | 1740.8 | 3704.8 | 47.7 | 83 | 0 |
| gpt2giga | long | 8 | 8 | 322.8 | 25808.3 | 322.8 | 29243.8 | 49.2 | 30 | 0 |

#### Чтение

- **V2 в пределах апстрим-шума V1.** По TTFT p50 V2 ниже на `simple`
  (345 vs 837) и `long` (415 vs 1740), сопоставим на `large` (1866 vs 1951),
  `tool` (1893 vs 1870) и `parallel` (1901 vs 1384). Разброс апстрима на
  порядок больше µs-вклада маппинга (Part A), поэтому это не выделяет V2 как
  систематически «медленнее» или «быстрее».
- **p95 ломают апстрим-столлы, не коннектор.** `long` p95: 50.7 s (v1),
  23.0 s (v2), 25.8 s (gpt2giga); Total p95 до 52.9 s. Это зависания апстрима
  на отдельных повторах.
- **`parallel` в этом прогоне сопоставим.** n=15/9/9 (в предыдущем отдельном
  прогоне v2 уходил в петлю, n=142); все запросы вернулись `200`.
- **`tok/s` и `out tok` между режимами не сравнимы.** У v1/v2 `usage` не было
  ни в одной записи (0/42 и 0/38) → плагин считал `round(text.length/4)` по
  всему SSE, включая протокол; у gpt2giga `usage` был в 33/47 записей → реальные
  `completion_tokens`. Значения 139 vs 9 отражают разные методы, а не разную
  длину ответов.
- **Без run-level сбоев:** 45/45 `exit=0`, в отличие от предыдущей отдельной
  сессии, где `v1/large #2` упал на OAuth `fetchToken` timeout.
- **Peak RSS не снимался** (см. ограничения выше); метод — `/usr/bin/time -v`
  либо сэмплирование `ps` с явным указанием процессов.

**Вывод (plan §33):** в одном combined-прогоне медианы V2 и gpt2giga лежат в
диапазоне апстрим-шума V1; дополнительный state/mapping-слой V2 стоит единицы µs
(Part A) и не требует искусственной оптимизации latency. Сравнение режимов
индикативное: прогон последовательный, не interleaved, и ограничения выше
применяются.

---

## C. gpt2giga comparison

**Статус: измерено 2026-09-17 в том же combined-прогоне, что Part B**
(`--mode v1 --mode v2 --mode gpt2giga`). gpt2giga `0.3.0` — отдельный
Python-прокси на `127.0.0.1:8090` с теми же GigaChat-кредами; форвардит на
`https://api.giga.chat/v2/chat/completions`. Строки `gpt2giga` — в таблице
Part B; ниже сведены TTFT p50 по сценариям.

| Scenario | v1 | v2 | gpt2giga |
|---|---:|---:|---:|
| simple | 836.6 | 345.0 | 405.7 |
| large | 1950.7 | 1865.7 | 1191.3 |
| tool | 1870.1 | 1893.3 | 1426.3 |
| parallel | 1384.2 | 1901.2 | 1733.3 |
| long | 1739.5 | 415.1 | 322.8 |

### Чтение

- **Порядок величины один у всех трёх режимов.** Разница между режимами
  (десятки–сотни мс) меньше вклада апстрима и его столов; µs-уровень маппинга
  (Part A) в этих числах не виден. gpt2giga ниже на `large`/`tool`/`long`, v2 —
  на `simple`, но прогон последовательный (не interleaved), поэтому разницу
  нельзя приписать исключительно прокси или коннектору.
- **`tok/s` / `out tok` не сравнимы:** у v1/v2 `usage` отсутствовал (fallback
  по всему SSE), у gpt2giga `usage` был в большинстве записей; см. ограничения
  в Part B.
- **gpt2giga — валидная benchmark-цель.** Все перехваченные ответы `200`,
  9–11 запросов на сценарий; код gpt2giga не копировался
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
