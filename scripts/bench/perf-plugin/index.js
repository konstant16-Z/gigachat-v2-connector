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

/** rquid -> { t, model } for requests awaiting a response. */
const started = new Map();

function looksLikeGiga(url) {
  return typeof url === "string" && /giga|sberbank/i.test(url);
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
        const rquid = req?.headers?.get("RqUID") ?? `${started.size}-${Math.random()}`;
        started.set(rquid, { t: performance.now(), model, url });
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
        const rquid = req?.headers?.get("RqUID") ?? "";
        const start = started.get(rquid);
        if (!start) return;
        started.delete(rquid);

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
