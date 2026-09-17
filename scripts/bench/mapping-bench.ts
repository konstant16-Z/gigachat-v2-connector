#!/usr/bin/env bun
/**
 * PHASE 12 §33 — offline mapping-overhead benchmark.
 *
 * Measures the CPU/time cost of the two translation layers *without any
 * network*: the legacy V1 connector (`src/v2/**`) vs the V2 mapping pipeline
 * (`src/translation/**`). This isolates the "request overhead" the plan asks
 * for and is the only fully reproducible part of §33 in a sandbox.
 *
 * The live half of §33 (TTFT, total latency, tokens/sec against the real API,
 * plus gpt2giga) is driven by `scripts/bench/run-live-perf.sh` from a terminal
 * with GigaChat network access; see `docs/PERFORMANCE.md`.
 *
 * Usage:
 *   bun scripts/bench/mapping-bench.ts [--iterations N] [--json PATH]
 *
 * Env:
 *   BENCH_JSON   output path (default logs/mapping-bench.json)
 *
 * No secrets are read or printed. No request/response bodies are logged.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ChatCompletionV2Response } from "../../src/gigachat/v2/types";
import { createV2Pipeline } from "../../src/translation/v2-pipeline";
import type { GigaChatResponse, OpenAiChatBody } from "../../src/types/gigachat";
import { translateGigaChatToOpenAi, translateStreamingResponse } from "../../src/v2/response";
import { translateOpenAiToGigaChat } from "../../src/v2/translator";

// ─── CLI ────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const ITERATION_SCALE = Number(argValue("--iterations") ?? "1");
const JSON_PATH = resolve(argValue("--json") ?? process.env.BENCH_JSON ?? "logs/mapping-bench.json");

const scale = (n: number): number => Math.max(1, Math.round(n * ITERATION_SCALE));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LARGE_TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(900); // ~40 KB

const TOOLS: NonNullable<OpenAiChatBody["tools"]> = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_docs",
      description: "Search the project documentation",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  },
];

function simpleBody(): OpenAiChatBody {
  return {
    model: "GigaChat-2-Max",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  };
}

function largePromptBody(): OpenAiChatBody {
  return {
    model: "GigaChat-2-Max",
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: `Summarize the following text in one line:\n${LARGE_TEXT}` },
    ],
  };
}

function toolCallBody(): OpenAiChatBody {
  return {
    model: "GigaChat-2-Max",
    tools: TOOLS,
    messages: [
      { role: "user", content: "What is the weather in Moscow?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temp_c":7,"sky":"cloudy"}' },
      { role: "user", content: "Thanks. Now summarize." },
    ],
  };
}

function parallelToolsBody(): OpenAiChatBody {
  const calls = ["get_weather", "search_docs", "get_weather", "search_docs", "get_weather"].map(
    (name, i) => ({
      id: `call_${i + 1}`,
      type: "function" as const,
      function: {
        name,
        arguments: name === "get_weather" ? `{"city":"City${i + 1}"}` : `{"query":"q${i + 1}"}`,
      },
    }),
  );
  const results = calls.map((c) => ({
    role: "tool" as const,
    tool_call_id: c.id,
    content: '{"ok":true}',
  }));
  return {
    model: "GigaChat-2-Max",
    tools: TOOLS,
    messages: [
      { role: "user", content: "Gather everything at once." },
      { role: "assistant", content: null, tool_calls: calls },
      ...results,
    ],
  };
}

function v1Response(): GigaChatResponse {
  return {
    id: "cmpl-1",
    created: 1_700_000_000,
    model: "GigaChat-2-Max",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello there." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function v2Response(): ChatCompletionV2Response {
  return {
    model: "GigaChat-2-Max",
    created_at: 1_700_000_000,
    finish_reason: "stop",
    messages: [{ role: "assistant", content: [{ text: "Hello there." }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

const STREAM_FRAMES = 200;

function v1SseBody(): Uint8Array {
  const encoder = new TextEncoder();
  let out = "";
  for (let i = 0; i < STREAM_FRAMES; i++) {
    out += `data: ${JSON.stringify({
      id: "cmpl-1",
      model: "GigaChat-2-Max",
      choices: [{ index: 0, delta: { content: `token${i} ` } }],
    })}\n\n`;
  }
  out += "data: [DONE]\n\n";
  return encoder.encode(out);
}

function v2SseBody(): Uint8Array {
  const encoder = new TextEncoder();
  let out = "";
  for (let i = 0; i < STREAM_FRAMES; i++) {
    out += `event: response.message.delta\ndata: ${JSON.stringify({
      messages: [{ role: "assistant", content: [{ text: `token${i} ` }] }],
    })}\n\n`;
  }
  out += `event: response.message.done\ndata: ${JSON.stringify({
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: STREAM_FRAMES, total_tokens: 10 + STREAM_FRAMES },
  })}\n\n`;
  return encoder.encode(out);
}

// ─── Harness ────────────────────────────────────────────────────────────────

interface Stats {
  meanUs: number;
  trimmedMeanUs: number;
  medianUs: number;
  p95Us: number;
  minUs: number;
  maxUs: number;
  opsPerSec: number;
}

interface Row {
  group: string;
  scenario: string;
  engine: "v1" | "v2";
  iterations: number;
  stats: Stats;
  cpuUserUsPerOp: number;
  cpuSystemUsPerOp: number;
  heapDeltaBytes: number;
}

function summarize(samplesMs: number[]): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const meanMs = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
  // Trim 1% from each tail so a handful of GC pauses do not dominate the
  // headline number (medians and the raw mean are kept in the JSON).
  const trim = Math.floor(sorted.length * 0.01);
  const kept = sorted.slice(trim, sorted.length - trim);
  const trimmedMeanMs = kept.reduce((a, b) => a + b, 0) / kept.length;
  return {
    meanUs: meanMs * 1000,
    trimmedMeanUs: trimmedMeanMs * 1000,
    medianUs: sorted[Math.floor(sorted.length / 2)] * 1000,
    p95Us: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 1000,
    minUs: sorted[0] * 1000,
    maxUs: sorted[sorted.length - 1] * 1000,
    opsPerSec: trimmedMeanMs > 0 ? 1000 / trimmedMeanMs : Number.POSITIVE_INFINITY,
  };
}

async function measure(
  group: string,
  scenario: string,
  engine: "v1" | "v2",
  iterations: number,
  fn: () => unknown | Promise<unknown>,
): Promise<Row> {
  const warmup = Math.max(5, Math.round(iterations * 0.2));
  for (let i = 0; i < warmup; i++) await fn();

  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const cpu = process.cpuUsage(cpuBefore);
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;

  return {
    group,
    scenario,
    engine,
    iterations,
    stats: summarize(samples),
    cpuUserUsPerOp: cpu.user / iterations,
    cpuSystemUsPerOp: cpu.system / iterations,
    heapDeltaBytes: heapDelta,
  };
}

async function drain(response: Response): Promise<number> {
  const body = response.body;
  if (body === null) return 0;
  const reader = body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.byteLength ?? 0;
  }
  return bytes;
}

// ─── Benchmarks ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pipeline = createV2Pipeline({ onSseError: () => {} });
  // Steady-state sessions (state is overwritten per response, not accumulated).
  const v1Session = "bench-v1";
  const v2Session = "bench-v2";
  const token = "bench-token";
  const rows: Row[] = [];

  const requestScenarios: Array<{ name: string; body: OpenAiChatBody }> = [
    { name: "simple-chat", body: simpleBody() },
    { name: "large-prompt", body: largePromptBody() },
    { name: "tool-call", body: toolCallBody() },
    { name: "5-parallel-tools", body: parallelToolsBody() },
  ];

  for (const { name, body } of requestScenarios) {
    const iterations = scale(name === "large-prompt" ? 200 : 500);
    rows.push(
      await measure("request", name, "v1", iterations, () =>
        translateOpenAiToGigaChat(body, token, true, ""),
      ),
    );
    rows.push(
      await measure("request", name, "v2", iterations, () =>
        pipeline.chatRequest(body, v2Session),
      ),
    );
  }

  // JSON response mapping (same scenarios, single synthetic response).
  for (const name of ["simple-chat", "tool-call"]) {
    const iterations = scale(500);
    rows.push(
      await measure("response-json", name, "v1", iterations, () =>
        translateGigaChatToOpenAi(v1Response()),
      ),
    );
    rows.push(
      await measure("response-json", name, "v2", iterations, () => pipeline.jsonResponse(v2Response(), v2Session)),
    );
  }

  // Streaming: full Response construction + drain of STREAM_FRAMES chunks.
  const streamIterations = scale(60);
  const v1Bytes = v1SseBody();
  const v2Bytes = v2SseBody();
  rows.push(
    await measure("stream", `long-stream-${STREAM_FRAMES}-frames`, "v1", streamIterations, async () => {
      const response = await translateStreamingResponse(new Response(v1Bytes.slice()));
      return drain(response);
    }),
  );
  rows.push(
    await measure("stream", `long-stream-${STREAM_FRAMES}-frames`, "v2", streamIterations, async () => {
      const response = pipeline.streamingResponse(new Response(v2Bytes.slice()), v2Session);
      return drain(response);
    }),
  );

  // ─── Report ───────────────────────────────────────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: {
      bun: typeof Bun !== "undefined" ? Bun.version : "unknown",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    iterations: ITERATION_SCALE,
    rows,
  };
  mkdirSync(dirname(JSON_PATH), { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);

  printMarkdown(rows);
  console.log(`\n>> JSON written: ${JSON_PATH}`);
}

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "∞";
  return n.toFixed(digits);
}

function printMarkdown(rows: Row[]): void {
  console.log("# Offline mapping overhead (plan §33)\n");
  const groups = [...new Set(rows.map((r) => r.group))];
  for (const group of groups) {
    console.log(`\n## ${group}\n`);
    console.log(
      "| Scenario | Engine | iters | mean µs | trim µs | median µs | p95 µs | max µs | ops/s | cpu µs/op |",
    );
    console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const row of rows.filter((r) => r.group === group)) {
      const s = row.stats;
      console.log(
        `| ${row.scenario} | ${row.engine} | ${row.iterations} | ${fmt(s.meanUs)} | ${fmt(
          s.trimmedMeanUs,
        )} | ${fmt(s.medianUs)} | ${fmt(s.p95Us)} | ${fmt(s.maxUs)} | ${fmt(
          s.opsPerSec,
          0,
        )} | ${fmt(row.cpuUserUsPerOp + row.cpuSystemUsPerOp)} |`,
      );
    }
  }
}

await main();
