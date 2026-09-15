#!/usr/bin/env bun
/**
 * Live verification harness for the GigaChat V2 chat/completions contract.
 *
 * Probes the spec anomalies documented in docs/COMPATIBILITY.md:
 *  - text JSON: top-level `messages[]`, `created_at` type, `thread_id`, finish_reason;
 *  - text SSE: event names, done-frame `created_at` type (spec example says string),
 *    finish_reason, usage shape;
 *  - tools without tool_state_id/thread_id: accepted? `tools_state_id` returned?
 *  - tools second turn: passing `tool_state_id` back on an assistant message;
 *  - forced error: invalid function name → HTTP 4xx vs SSE finish_reason "error".
 *
 * Credentials are read from GIGACHAT_CREDENTIALS env, or from the local OpenCode
 * config (~/.config/opencode/opencode.json; overridable via GIGACHAT_OPENCODE_CONFIG).
 * Credentials and OAuth tokens are NEVER printed.
 *
 * Usage:
 *   bun run scripts/live-api-check.ts [--model GigaChat-2-Max] [--base-url ...] [--no-verify-ssl] [--ca-bundle path]
 */
import axios, { AxiosError } from "axios";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authManager } from "../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";

/* ------------------------------ CLI ------------------------------ */

interface CliArgs {
  model: string;
  baseUrl: string;
  verifySsl: boolean;
  caBundle: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    model: "GigaChat-2-Max",
    baseUrl: "https://api.giga.chat/v2/chat/completions",
    verifySsl: shouldVerifySsl(),
    caBundle: DEFAULT_CA_BUNDLE_FILE,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--model") args.model = argv[i + 1] ?? args.model;
    else if (a === "--base-url") args.baseUrl = argv[i + 1] ?? args.baseUrl;
    else if (a === "--ca-bundle") args.caBundle = argv[i + 1] ?? args.caBundle;
    else if (a === "--no-verify-ssl") args.verifySsl = false;
    else if (a === "--help") args.help = true;
  }
  return args;
}

/* --------------------------- credentials --------------------------- */

interface Credentials {
  credentials: string;
  scope: string;
}

function loadCredentials(): Credentials {
  if (process.env.GIGACHAT_CREDENTIALS) {
    return {
      credentials: process.env.GIGACHAT_CREDENTIALS,
      scope: process.env.GIGACHAT_SCOPE ?? "GIGACHAT_API_PERS",
    };
  }
  const cfgPath =
    process.env.GIGACHAT_OPENCODE_CONFIG ??
    path.join(os.homedir(), ".config", "opencode", "opencode.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error("no credentials: set GIGACHAT_CREDENTIALS or provide an OpenCode config");
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    plugins?: Array<{ options?: { credentials?: string; scope?: string } }>;
    provider?: Record<string, { options?: { credentials?: string; scope?: string } }>;
  };
  const providers = cfg.provider ?? {};
  const giga3 = Object.keys(providers).find(
    (name) => name.toLowerCase().includes("api.giga.chat") || name.toLowerCase().includes("gigachat 3"),
  );
  const candidates: Array<{ credentials?: string; scope?: string } | undefined> = [
    giga3 !== undefined ? providers[giga3].options : undefined,
    ...(cfg.plugins ?? []).map((p) => p.options),
    ...Object.values(providers).map((p) => p.options),
  ];
  for (const opt of candidates) {
    if (opt !== undefined && typeof opt.credentials === "string" && opt.credentials !== "") {
      return {
        credentials: opt.credentials,
        scope: typeof opt.scope === "string" && opt.scope !== "" ? opt.scope : "GIGACHAT_API_PERS",
      };
    }
  }
  throw new Error("no credentials: GIGACHAT_CREDENTIALS unset and no credentials in OpenCode config");
}

/* ----------------------------- SSE ----------------------------- */

interface SseFrame {
  event: string;
  data: unknown;
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let event = "";
  const dataLines: string[] = [];
  const flush = (): void => {
    if (dataLines.length > 0) {
      let parsed: unknown = dataLines.join("\n");
      try {
        parsed = JSON.parse(parsed as string);
      } catch {
        // keep raw text for malformed frames
      }
      frames.push({ event: event === "" ? "message" : event, data: parsed });
    }
    event = "";
    dataLines.length = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
    } else if (!line.startsWith(":")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
  }
  flush(); // discharge a truncated tail
  return frames;
}

/* --------------------------- probes --------------------------- */

interface ProbeResult {
  name: string;
  ok: boolean;
  notes: string[];
  findings: Record<string, unknown>;
}

type HttpPost = (body: unknown, extra?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;

async function probeTextJson(post: HttpPost, model: string): Promise<ProbeResult> {
  const { status, data } = await post({
    model,
    messages: [{ role: "user", content: [{ text: "Проверка V2. Ответь одним коротким предложением по-русски." }] }],
    stream: false,
  });
  const raw = data as Record<string, unknown>;
  const messages = Array.isArray(raw.messages) ? (raw.messages as Array<Record<string, unknown>>) : [];
  const last = messages.at(-1);
  const content = last?.content;
  return {
    name: "text JSON (no tools)",
    ok: status >= 200 && status < 300 && messages.length > 0,
    notes: [],
    findings: {
      status,
      topLevelKeys: Object.keys(raw),
      model: raw.model,
      created_at: raw.created_at,
      created_at_type: typeof raw.created_at,
      thread_id: raw.thread_id,
      finish_reason: raw.finish_reason,
      messageCount: messages.length,
      lastMessageKeys: last !== undefined ? Object.keys(last) : [],
      lastRole: last?.role,
      contentItems: Array.isArray(content) ? content.map((it) => Object.keys(it as object)) : content,
    },
  };
}

async function probeTextSse(post: HttpPost, model: string): Promise<ProbeResult> {
  const { status, data } = await post(
    {
      model,
      messages: [{ role: "user", content: [{ text: "Проверка SSE. Ответь одним коротким предложением по-русски." }] }],
      stream: true,
    },
    { responseType: "text" },
  );
  const frames = parseSse(String(data));
  const done = frames.find((f) => f.event === "response.message.done");
  const doneData = (done?.data ?? {}) as Record<string, unknown>;
  const deltas = frames.filter((f) => f.event === "response.message.delta");
  const firstDeltaData = (deltas[0]?.data ?? {}) as Record<string, unknown>;
  return {
    name: "text SSE (streaming)",
    ok: status >= 200 && status < 300 && done !== undefined,
    notes:
      status >= 200 && status < 300 && done === undefined ? ["no response.message.done frame"] : [],
    findings: {
      status,
      eventNames: [...new Set(frames.map((f) => f.event))],
      doneKeys: Object.keys(doneData),
      finish_reason: doneData.finish_reason,
      created_at: doneData.created_at,
      created_at_type: typeof doneData.created_at,
      tools_state_id: doneData.tools_state_id,
      thread_id: doneData.thread_id,
      usage: doneData.usage,
      firstDeltaKeys: Object.keys(firstDeltaData),
      deltaCount: deltas.length,
    },
  };
}

function weatherTools(): unknown[] {
  return [
    {
      functions: {
        specifications: [
          {
            name: "get_weather",
            description: "Текущая погода в городе",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    },
  ];
}

async function probeToolsNoState(post: HttpPost, model: string): Promise<ProbeResult> {
  const { status, data } = await post({
    model,
    messages: [{ role: "user", content: [{ text: "Узнай погоду в Москве через get_weather, затем ответь." }] }],
    tools: weatherTools(),
    stream: false,
  });
  const raw = data as Record<string, unknown>;
  const messages = Array.isArray(raw.messages) ? (raw.messages as Array<Record<string, unknown>>) : [];
  const last = messages.at(-1);
  return {
    name: "tools without tool_state_id (mandatory?)",
    ok: status >= 200 && status < 300,
    notes:
      status >= 200 && status < 300
        ? []
        : [`non-2xx without state; error: ${JSON.stringify(raw).slice(0, 300)}`],
    findings: {
      status,
      finish_reason: raw.finish_reason,
      tools_state_id: last?.tools_state_id,
      functions_state_id: last?.functions_state_id,
      lastRole: last?.role,
      lastContentKeys: Array.isArray(last?.content)
        ? (last?.content as Array<Record<string, unknown>>).map((it) => Object.keys(it))
        : typeof last?.content,
      thread_id: raw.thread_id,
    },
  };
}

async function probeToolsSecondTurn(
  post: HttpPost,
  model: string,
  state: { functionsStateId: string | undefined; toolsStateId: string | undefined },
): Promise<ProbeResult> {
  const stateId = state.functionsStateId ?? state.toolsStateId;
  const baseMessages: Array<Record<string, unknown>> = [
    { role: "user", content: [{ text: "Узнай погоду в Москве через get_weather, затем ответь." }] },
    {
      role: "assistant",
      content: [{ text: "Вызываю get_weather" }],
      function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' },
      ...(stateId !== undefined ? { functions_state_id: stateId } : {}),
    },
    { role: "function", content: JSON.stringify({ city: "Moscow", temperature: 20 }) },
    { role: "user", content: [{ text: "Спасибо. Теперь ответь кратко." }] },
  ];
  const run = async (variant: "spec" | "array" | "roundtrip"): Promise<{ status: number; data: unknown }> => {
    if (variant === "roundtrip") {
      return post({
        model,
        messages: [
          { role: "user", content: [{ text: "Узнай погоду в Москве через get_weather, затем ответь." }] },
          {
            role: "assistant",
            content: [{ function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' } }],
            ...(stateId !== undefined ? { functions_state_id: stateId } : {}),
          },
          {
            role: "function",
            content: [
              { function_result: { name: "get_weather", result: JSON.stringify({ city: "Moscow", temperature: 20 }) } },
            ],
          },
          { role: "user", content: [{ text: "Спасибо. Теперь ответь кратко." }] },
        ],
        tools: weatherTools(),
        stream: false,
      });
    }
    const messages =
      variant === "array"
        ? baseMessages.map((m) =>
            m.role === "function"
              ? {
                  role: "function",
                  content: [
                    {
                      function_result: {
                        name: "get_weather",
                        result: JSON.stringify({ city: "Moscow", temperature: 20 }),
                      },
                    },
                  ],
                }
              : m,
          )
        : baseMessages;
    return post({ model, messages, tools: weatherTools(), stream: false });
  };
  const spec = await run("spec");
  const arr = await run("array");
  const roundtrip = await run("roundtrip");
  const specsOk = spec.status >= 200 && spec.status < 300;
  const arrOk = arr.status >= 200 && arr.status < 300;
  const rtOk = roundtrip.status >= 200 && roundtrip.status < 300;
  return {
    name: `tools second turn (state ${stateId !== undefined ? "injected" : "absent"})`,
    ok: specsOk || arrOk || rtOk,
    notes: [
      `spec-strict (role=function, content=string): ${spec.status} ${JSON.stringify(spec.data).slice(0, 160)}`,
      `array-content (role=function, [{function_result}]): ${arr.status} ${JSON.stringify(arr.data).slice(0, 160)}`,
      `roundtrip (content:[{function_call}]+[{function_result}]): ${roundtrip.status} ${JSON.stringify(roundtrip.data).slice(0, 160)}`,
    ],
    findings: {
      specStrict: { status: spec.status },
      arrayContent: { status: arr.status },
      roundtrip: { status: roundtrip.status, finish_reason: (roundtrip.data as Record<string, unknown>)?.finish_reason },
    },
  };
}

async function probeForcedError(post: HttpPost, model: string): Promise<ProbeResult> {
  const { status, data } = await post({
    model,
    messages: [{ role: "user", content: [{ text: "Вызови функцию с недопустимым именем." }] }],
    tools: [
      {
        functions: {
          specifications: [
            {
              name: "Плохое_Имя", // violates /^[A-Za-z][A-Za-z0-9_]*$/ — spec CustomFunction.name
              description: "test",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      },
    ],
    stream: false,
  });
  const raw = data as Record<string, unknown>;
  return {
    name: "forced error (invalid function name)",
    ok: true, // we only record behaviour; FAIL means nothing here
    notes: [],
    findings: {
      status,
      bodySample: JSON.stringify(raw).slice(0, 400),
      finish_reason: raw.finish_reason,
      isErrorFinish: raw.finish_reason === "error",
    },
  };
}

/* ----------------------------- main ----------------------------- */

function printReport(results: ProbeResult[]): void {
  for (const r of results) {
    console.log(`\n=== ${r.name} === [${r.ok ? "OK" : "FAIL"}]`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    console.log(JSON.stringify(r.findings, null, 2));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} probes OK`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: bun run scripts/live-api-check.ts [--model M] [--base-url U] [--no-verify-ssl] [--ca-bundle P]",
    );
    return;
  }
  const cred = loadCredentials();
  authManager.setCredentials(cred.credentials, cred.scope, args.verifySsl, args.caBundle);
  const { token } = await authManager.getAccessToken();
  const agent = getHttpsAgent(args.verifySsl, args.caBundle);
  const http = axios.create({
    baseURL: args.baseUrl,
    httpsAgent: agent,
    timeout: 120_000,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const post: HttpPost = async (body, extra = {}) => {
    try {
      const res = await http.post("", body, extra);
      return { status: res.status, data: res.data };
    } catch (err) {
      if (err instanceof AxiosError) {
        return { status: err.response?.status ?? 0, data: err.response?.data };
      }
      throw err;
    }
  };
  console.log(`live-api-check: model=${args.model} baseUrl=${args.baseUrl} verifySsl=${args.verifySsl}`);
  const results: ProbeResult[] = [];
  results.push(await probeTextJson(post, args.model));
  results.push(await probeTextSse(post, args.model));
  results.push(await probeToolsNoState(post, args.model));
  const toolsJson = results[2].findings;
  const state = {
    functionsStateId:
      typeof toolsJson.functions_state_id === "string" && toolsJson.functions_state_id !== ""
        ? (toolsJson.functions_state_id as string)
        : undefined,
    toolsStateId:
      typeof toolsJson.tools_state_id === "string" && toolsJson.tools_state_id !== ""
        ? (toolsJson.tools_state_id as string)
        : undefined,
  };
  results.push(await probeToolsSecondTurn(post, args.model, state));
  results.push(await probeForcedError(post, args.model));
  printReport(results);
}

main().catch((err: unknown) => {
  console.error(`live-api-check aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});