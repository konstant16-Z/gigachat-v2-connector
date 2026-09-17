// PHASE 12 §33 — performance capture plugin.
//
// Registered AFTER the connector (or standalone for the `native` mode) so its
// http hooks observe the final outbound request/response. Writes one JSON line
// per outbound GigaChat request to $PERF_LOG:
//
//   {mode,url,model,status,sse,t_request,ttft_ms,total_ms,out_bytes,
//    out_tokens,usage,tokens_per_sec}
//
// Timings are relative to the request hook firing; TTFT is the arrival time of
// the first streamed byte (equal to total for non-streaming responses).
// No request/response content is written — only counts and timings.
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const LOG = process.env.PERF_LOG ?? "/tmp/opencode/perf.jsonl";
const MODE = process.env.PERF_MODE ?? "unknown";
const SCENARIO = process.env.PERF_SCENARIO ?? "unknown";
// Extra substring to capture requests that do not target GigaChat directly,
// e.g. a local gpt2giga proxy (http://127.0.0.1:8091/v2). Set by the harness
// for `--mode gpt2giga`; empty for v1/v2 (the /giga|sberbank/ match applies).
const MATCH = process.env.PERF_MATCH ?? "";

/**
 * Correlate requests with responses.
 *
 * The connector adds an `RqUID` request header, so that is the primary key.
 * When the perf plugin runs standalone (e.g. against a local gpt2giga proxy)
 * there is no RqUID, so fall back to a FIFO queue keyed by method+url. Under
 * concurrency (identical parallel requests) responses may be matched in a
 * different order, which only affects attribution between near-identical
 * records.
 */
const pending = new Map();

function corrKey(req, url) {
  const rquid = req?.headers?.get?.("RqUID");
  if (rquid) return `rquid:${rquid}`;
  return `url:${req?.method ?? "POST"} ${url}`;
}

function pendingPush(key, value) {
  const arr = pending.get(key);
  if (arr) arr.push(value);
  else pending.set(key, [value]);
}

function pendingShift(key) {
  const arr = pending.get(key);
  if (!arr || arr.length === 0) return undefined;
  const value = arr.shift();
  if (arr.length === 0) pending.delete(key);
  return value;
}

function looksLikeGiga(url) {
  if (typeof url !== "string") return false;
  if (/giga|sberbank/i.test(url)) return true;
  return MATCH.length > 0 && url.includes(MATCH);
}

function extractUsage(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const completion = num(/"completion_tokens"\s*:\s*(\d+)/);
  const output = num(/"output_tokens"\s*:\s*(\d+)/);
  const prompt = num(/"prompt_tokens"\s*:\s*(\d+)/) ?? num(/"input_tokens"\s*:\s*(\d+)/);
  const total = num(/"total_tokens"\s*:\s*(\d+)/);
  if (completion === undefined && output === undefined) return null;
  return { prompt, completion: completion ?? output, output, total };
}

function estimateTokens(text) {
  // Rough fallback when the upstream does not surface usage (bytes/4).
  return Math.max(0, Math.round(text.length / 4));
}

function write(record) {
  try {
    appendFileSync(LOG, `${JSON.stringify(record)}\n`);
  } catch {
    // never break a request for diagnostics
  }
}

const plugin = {
  id: "perf-capture",
  async setup(ctx) {
    const session = ctx?.session;
    await session.hook("http.request", async (event) => {
      try {
        const req = event?.request;
        const url = req?.url ?? "?";
        if (!looksLikeGiga(url)) return;
        let body = "";
        try {
          body = await req.clone().text();
        } catch {
          body = "";
        }
        let model = "?";
        try {
          model = JSON.parse(body)?.model ?? "?";
        } catch {
          model = "?";
        }
        const key = corrKey(req, url);
        pendingPush(key, { t: performance.now(), model, url });
      } catch {
        // ignore
      }
    });

    await session.hook("http.response", async (event) => {
      try {
        const req = event?.request;
        const resp = event?.response;
        if (!resp) return;
        const url = req?.url ?? "?";
        if (!looksLikeGiga(url)) return;
        const key = corrKey(req, url);
        const start = pendingShift(key);
        if (!start) return;

        const tHeaders = performance.now();
        const ctype = resp.headers?.get?.("Content-Type") ?? "";
        const isSse = ctype.includes("text/event-stream");
        const record = {
          mode: MODE,
          scenario: SCENARIO,
          url,
          model: start.model,
          status: resp.status,
          sse: isSse,
          t_request: start.t,
          ttft_ms: null,
          total_ms: null,
          out_bytes: 0,
          out_tokens: null,
          usage: null,
          tokens_per_sec: null,
        };

        const body = resp.body;
        if (!body) {
          record.ttft_ms = tHeaders - start.t;
          record.total_ms = tHeaders - start.t;
          write(record);
          return;
        }

        // Tee the body so OpenCode keeps its own copy; read ours in the
        // background to timestamp the first/last chunk without blocking.
        const clone = resp.clone();
        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        let firstAt = null;
        let bytes = 0;
        let text = "";
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                if (firstAt === null) firstAt = performance.now();
                bytes += value.byteLength;
                text += decoder.decode(value, { stream: true });
              }
            }
          } catch {
            // ignore read errors; report what we have
          }
          const tLast = performance.now();
          const usage = extractUsage(text);
          const tokens = usage?.completion ?? estimateTokens(text);
          record.ttft_ms = (firstAt ?? tLast) - start.t;
          record.total_ms = tLast - start.t;
          record.out_bytes = bytes;
          record.out_tokens = tokens;
          record.usage = usage;
          record.tokens_per_sec =
            record.total_ms > 0 ? (tokens / record.total_ms) * 1000 : null;
          write(record);
        })();
      } catch {
        // ignore
      }
    });
  },
};

export default plugin;
