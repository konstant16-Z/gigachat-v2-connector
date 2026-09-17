// PHASE 12 §33 — performance capture plugin.
//
// Registered AFTER the connector (or standalone for the `native` mode) so its
// http hooks observe the final outbound request/response. Writes one JSON line
// per outbound GigaChat request to $PERF_LOG:
//
//   {mode,scenario,run_id,url,model,status,sse,t_request,ttft_ms,total_ms,
//    out_bytes,out_tokens,usage,usage_source,estimate_tokens,probe_usage,
//    tokens_per_sec}
// `run_id` (PERF_RUN_ID, mode-scenario-repeat) lets the analyzer drop records
// from a run that hit the harness wall-clock cap.
//
// Timings are relative to the request hook firing; TTFT is the arrival time of
// the first streamed byte (equal to total for non-streaming responses).
// No request/response content is written — only counts and timings.
//
// Token accounting:
//   usage_source="upstream"  the surface carried a real `usage` object.
//   usage_source="probe"     the optional non-streaming probe returned usage
//                            (see PERF_USAGE_PROBE below).
//   usage_source="estimate"  fallback: generated content only (delta.content /
//                            reasoning_content / tool-call name+arguments),
//                            rounded chars/4. The SSE protocol frames are NOT
//                            counted, unlike the earlier whole-body length/4.
//   `estimate_tokens` is always recorded for transparency, even when a real
//   usage value is used.
//
// PERF_USAGE_PROBE=1 (Option 1): for each streaming chat request, replay the
// already-translated GigaChat request with `stream: false` over a raw
// node:http(s) connection so the raw upstream `usage` can be read. The replay
// bypasses the session fetch hooks (no double translation, no extra capture
// record), runs only after the stream completed (so it never competes with the
// request being measured) and backs off on 429/5xx. It still roughly doubles
// upstream requests, so it is intended for a dedicated reference run, not for
// the latency numbers. Credentials are only replayed in memory and never
// logged.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

const LOG = process.env.PERF_LOG ?? "/tmp/opencode/perf.jsonl";
const MODE = process.env.PERF_MODE ?? "unknown";
const SCENARIO = process.env.PERF_SCENARIO ?? "unknown";
// Identifies one harness run (mode-scenario-repeat) so the analyzer can drop
// records from runs that hit the wall-clock cap (an agent/tool loop).
const RUN_ID = process.env.PERF_RUN_ID ?? null;
// Extra substring to capture requests that do not target GigaChat directly,
// e.g. a local gpt2giga proxy (http://127.0.0.1:8091/v2). Set by the harness
// for `--mode gpt2giga`; empty for v1/v2 (the /giga|sberbank/ match applies).
const MATCH = process.env.PERF_MATCH ?? "";
// Option 1: opt-in non-streaming usage probe (see the header comment).
const USAGE_PROBE = process.env.PERF_USAGE_PROBE === "1";
const CA_PEM = process.env.PERF_CA_PEM ?? process.env.NODE_EXTRA_CA_CERTS ?? "";
const PROBE_TIMEOUT_MS = Number(process.env.PERF_PROBE_TIMEOUT_MS ?? "120000");

let cachedCa;
/** Read the optional probe CA bundle once; `null` means "use system trust". */
function loadCaBundle() {
  if (cachedCa !== undefined) return cachedCa;
  if (!CA_PEM) {
    cachedCa = null;
    return cachedCa;
  }
  try {
    cachedCa = readFileSync(CA_PEM);
  } catch {
    cachedCa = null;
  }
  return cachedCa;
}

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

/** Probe replays must never be captured (defensive; raw http bypasses hooks). */
function isProbeRequest(req) {
  try {
    return req?.headers?.get?.("X-Perf-Probe") === "1";
  } catch {
    return false;
  }
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

/** Concatenate only model-generated text from a `tool_calls` array. */
function toolCallText(toolCalls) {
  if (!Array.isArray(toolCalls)) return "";
  let out = "";
  for (const call of toolCalls) {
    const fn = call?.function;
    if (typeof fn?.name === "string") out += fn.name;
    if (typeof fn?.arguments === "string") out += fn.arguments;
  }
  return out;
}

/**
 * Concatenate generated text from SSE `data:` frames only. Returns `null` when
 * the body is not SSE (no `data:` frame parsed), so non-streaming JSON falls
 * through to the JSON path in estimateTokens().
 */
function generatedTextFromSse(text) {
  let out = "";
  let sawFrame = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    sawFrame = true;
    const choices = Array.isArray(obj?.choices) ? obj.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta ?? choice?.message ?? {};
      if (typeof delta.content === "string") out += delta.content;
      if (typeof delta.reasoning_content === "string") out += delta.reasoning_content;
      out += toolCallText(delta.tool_calls);
    }
  }
  return sawFrame ? out : null;
}

/**
 * Rough fallback when the upstream does not surface usage: chars/4 over the
 * generated text only. Falls back to the raw body only if nothing parses
 * (e.g. an error body), so a plain byte count never masquerades as tokens.
 */
function estimateTokens(text) {
  const streamed = generatedTextFromSse(text);
  if (streamed !== null) return Math.max(0, Math.round(streamed.length / 4));
  try {
    const obj = JSON.parse(text);
    const choices = Array.isArray(obj?.choices) ? obj.choices : [];
    let out = "";
    for (const choice of choices) {
      const message = choice?.message ?? choice?.delta ?? {};
      if (typeof message.content === "string") out += message.content;
      if (typeof message.reasoning_content === "string") out += message.reasoning_content;
      out += toolCallText(message.tool_calls);
    }
    return Math.max(0, Math.round(out.length / 4));
  } catch {
    return Math.max(0, Math.round(text.length / 4));
  }
}

/**
 * Build the header object for a probe replay: copy the translated request's
 * headers, drop length/host/encoding (recomputed or forced), and mark the
 * replay so it is never captured even if a hook sees it.
 */
function buildProbeHeaders(headers, body) {
  const out = {};
  try {
    for (const [name, value] of headers.entries()) {
      const lower = name.toLowerCase();
      if (lower === "content-length" || lower === "host" || lower === "accept-encoding") continue;
      out[name] = value;
    }
  } catch {
    // ignore header iteration failures; the probe is best-effort
  }
  out["Content-Type"] = "application/json";
  out.Accept = "application/json";
  out["Accept-Encoding"] = "identity";
  out.RqUID = randomUUID();
  out["X-Perf-Probe"] = "1";
  out["Content-Length"] = Buffer.byteLength(body);
  return out;
}

/**
 * Option 1: replay an already-translated GigaChat chat request with
 * `stream: false` over a raw node:http(s) connection and read the raw upstream
 * usage. Resolves to `{status, usage}` or `null`; never throws, never logs
 * request or response content.
 */
function probeUsage(probe, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(probe.url);
    } catch {
      resolve(null);
      return;
    }
    const secure = parsed.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const options = {
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: probe.headers,
    };
    if (secure) {
      const ca = loadCaBundle();
      if (ca) options.ca = ca;
    }
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = send(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", () => settle(null));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const encoding = String(res.headers?.["content-encoding"] ?? "");
        if (encoding.includes("gzip")) {
          try {
            buf = gunzipSync(buf);
          } catch {
            // leave the raw bytes; extractUsage will simply find nothing
          }
        }
        settle({ status: res.statusCode ?? 0, usage: extractUsage(buf.toString("utf8")) });
      });
    });
    req.on("error", () => settle(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      settle(null);
    });
    req.end(probe.body);
  });
}

/**
 * Probe with a small backoff on 429/5xx so a rate-limited replay still yields
 * usage. The replay runs after the stream completed, so it never competes with
 * the request being measured.
 */
async function probeUsageWithRetry(probe, timeoutMs, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await probeUsage(probe, timeoutMs);
    if (!result) return null;
    if (result.status === 429 || result.status >= 500) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    return result;
  }
  return null;
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
        if (!looksLikeGiga(url) || isProbeRequest(req)) return;
        let body = "";
        try {
          body = await req.clone().text();
        } catch {
          body = "";
        }
        let bodyJson = null;
        try {
          bodyJson = JSON.parse(body);
        } catch {
          bodyJson = null;
        }
        const model = typeof bodyJson?.model === "string" && bodyJson.model ? bodyJson.model : "?";
        const key = corrKey(req, url);
        const entry = { t: performance.now(), model, url, probe: null };
        if (USAGE_PROBE && url.includes("/chat/completions") && bodyJson && bodyJson.stream !== false) {
          try {
            const probeBody = JSON.stringify({ ...bodyJson, stream: false });
            entry.probe = {
              url,
              headers: buildProbeHeaders(req.headers, probeBody),
              body: probeBody,
            };
          } catch {
            entry.probe = null;
          }
        }
        pendingPush(key, entry);
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
        if (!looksLikeGiga(url) || isProbeRequest(req)) return;
        const key = corrKey(req, url);
        const start = pendingShift(key);
        if (!start) return;

        const tHeaders = performance.now();
        const ctype = resp.headers?.get?.("Content-Type") ?? "";
        const isSse = ctype.includes("text/event-stream");
        const record = {
          mode: MODE,
          scenario: SCENARIO,
          run_id: RUN_ID,
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
          usage_source: "estimate",
          estimate_tokens: null,
          probe_usage: null,
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
          const upstreamUsage = extractUsage(text);
          const estimate = estimateTokens(text);
          let usage = upstreamUsage;
          let source = upstreamUsage ? "upstream" : "estimate";
          let probeUsageValue = null;
          // Replay only when the surface had no usage of its own and the main
          // request succeeded. The replay runs after the stream (so it never
          // competes with the measured request) and backs off on 429/5xx.
          if (!upstreamUsage && start.probe && record.status < 400) {
            const probed = await probeUsageWithRetry(start.probe, PROBE_TIMEOUT_MS);
            probeUsageValue = probed?.usage ?? null;
            if (
              probed &&
              probed.status >= 200 &&
              probed.status < 300 &&
              typeof probed.usage?.completion === "number"
            ) {
              usage = probed.usage;
              source = "probe";
            }
          }
          const tokens = usage?.completion ?? estimate;
          record.ttft_ms = (firstAt ?? tLast) - start.t;
          record.total_ms = tLast - start.t;
          record.out_bytes = bytes;
          record.out_tokens = tokens;
          record.usage = usage;
          record.usage_source = source;
          record.estimate_tokens = estimate;
          record.probe_usage = probeUsageValue;
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
