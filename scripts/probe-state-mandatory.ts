#!/usr/bin/env bun
/**
 * Clarifying probe (2026-09-15): is `functions_state_id` REQUIRED on the
 * second turn when function_call.arguments is an object?
 *
 * Variants tested after a real turn-1 function_call:
 *   A. with functions_state_id + object args        (baseline -> expect 200)
 *   B. WITHOUT functions_state_id, object args      (the open question)
 *   C. WITHOUT functions_state_id, no fc id         (minimal)
 *   D. with tool_state_id (alias check) + object    (does the API accept the
 *      response-side field name on the request?)
 *
 * Credentials are read from GIGACHAT_CREDENTIALS env or the local OpenCode
 * config; never printed. Run from the repo root:
 *   bun run scripts/probe-state-mandatory.ts
 */
import axios, { AxiosError } from "axios";
import * as os from "node:os";
import * as path from "node:path";
import { authManager } from "../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";

const BASE = "https://api.giga.chat/v2/chat/completions";
const MODEL = "GigaChat-2-Max";
const TOOLS = [
  {
    functions: {
      specifications: [
        {
          name: "get_weather",
          description: "Погода в городе",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
    },
  },
];

async function loadCredentials(): Promise<string> {
  if (process.env.GIGACHAT_CREDENTIALS) return process.env.GIGACHAT_CREDENTIALS;
  const fs = await import("node:fs");
  const cfgPath = process.env.GIGACHAT_OPENCODE_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    plugins?: Array<{ options?: { credentials?: string } }>;
    provider?: Record<string, { options?: { credentials?: string } }>;
  };
  const provider = Object.values(cfg.provider ?? {}).find((p) => p.options?.credentials);
  return provider?.options?.credentials ?? cfg.plugins?.[0]?.options?.credentials ?? "";
}

async function main() {
  const credentialsValue = await loadCredentials();
  if (!credentialsValue) throw new Error("no credentials");
  authManager.setCredentials(credentialsValue, "GIGACHAT_API_PERS", shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);
  const { token } = await authManager.getAccessToken();
  const agent = getHttpsAgent(shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);
  const http = axios.create({
    baseURL: BASE,
    httpsAgent: agent,
    timeout: 120_000,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
  });
  const post = async (body: unknown): Promise<{ status: number; data: unknown }> => {
    try {
      const res = await http.post("", body);
      return { status: res.status, data: res.data };
    } catch (err) {
      if (err instanceof AxiosError) return { status: err.response?.status ?? 0, data: err.response?.data };
      throw err;
    }
  };

  const userQ = "Погода в Москве через get_weather. Ответь кратко.";
  const r1 = await post({
    model: MODEL,
    messages: [{ role: "user", content: [{ text: userQ }] }],
    tools: TOOLS,
    stream: false,
  });
  const d1 = r1.data as Record<string, unknown>;
  const msgs1 = (Array.isArray(d1.messages) ? d1.messages : []) as Array<Record<string, unknown>>;
  const asst1 = msgs1.find((m) => m.role === "assistant") ?? {};
  const content1 = (Array.isArray(asst1.content) ? asst1.content : []) as Array<Record<string, unknown>>;
  const fc = content1.find((c) => c.function_call !== undefined)?.function_call as
    | { id?: string; name?: string; arguments?: string | Record<string, unknown> }
    | undefined;
  const stateId = (asst1.tool_state_id ?? asst1.tools_state_id) as string | undefined;
  console.log("turn1:", r1.status, "| state:", stateId ?? "(none)", "| fc:", fc?.name ?? "(none)");

  if (!fc?.name) {
    console.log("no function_call in turn1; abort");
    return;
  }
  const objectArgs =
    typeof fc.arguments === "object" ? (fc.arguments as Record<string, unknown>) : JSON.parse(String(fc.arguments ?? "{}"));

  interface Variant {
    label: string;
    stateField?: { functions_state_id: string } | { tool_state_id: string };
    fc: { id?: string; name: string; arguments: unknown };
  }
  const variants: Variant[] = [
    { label: "with functions_state_id + object (baseline)", stateField: stateId ? { functions_state_id: stateId } : undefined, fc: { name: fc.name, arguments: objectArgs } },
    { label: "NO state + object", fc: { name: fc.name, arguments: objectArgs } },
    { label: "NO state + object + no fc id", fc: { name: fc.name, arguments: objectArgs } },
    { label: "tool_state_id alias + object", stateField: stateId ? { tool_state_id: stateId } : undefined, fc: { name: fc.name, arguments: objectArgs } },
  ];

  for (const v of variants) {
    const r = await post({
      model: MODEL,
      messages: [
        { role: "user", content: [{ text: userQ }] },
        { role: "assistant", content: [{ function_call: { ...v.fc } }], ...v.stateField },
        { role: "function", content: [{ function_result: { name: fc.name, result: '{"city":"Moscow","temperature":20}' } }] },
        { role: "user", content: [{ text: "Спасибо. Ответь одним предложением по-русски." }] },
      ],
      tools: TOOLS,
      stream: false,
    });
    const ok = r.status >= 200 && r.status < 300;
    console.log(
      `turn2 [${v.label}]: ${r.status} ${ok ? `finish=${(r.data as Record<string, unknown>).finish_reason}` : JSON.stringify(r.data).slice(0, 240)}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});