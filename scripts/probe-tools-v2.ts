#!/usr/bin/env bun
import axios, { AxiosError } from "axios";
import { randomUUID } from "node:crypto";
import { authManager } from "../src/v2/auth";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";

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

async function main() {
  // credentials from env or config (never printed)
  let credentialsValue: string | undefined = process.env.GIGACHAT_CREDENTIALS;
  if (!credentialsValue) {
    const fs = await import("node:fs");
    const cfgPath = "/home/zkons/.config/opencode/opencode.json";
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins?: Array<{ options?: { credentials?: string; scope?: string } }>;
      provider?: Record<string, { options?: { credentials?: string; scope?: string } }>;
    };
    const provider = Object.values(cfg.provider ?? {}).find((p) => p.options?.credentials);
    credentialsValue = provider?.options?.credentials ?? cfg.plugins?.[0]?.options?.credentials;
  }
  if (!credentialsValue) throw new Error("no credentials");
  const scopeValue = process.env.GIGACHAT_SCOPE ?? "GIGACHAT_API_PERS";

  authManager.setCredentials(credentialsValue, scopeValue, shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);
  const { token } = await authManager.getAccessToken();
  const agent = getHttpsAgent(shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);
  const http = axios.create({
    baseURL: BASE,
    httpsAgent: agent,
    timeout: 120_000,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
  });

  const post = async (body: unknown, extra: Record<string, unknown> = {}): Promise<{ status: number; data: unknown }> => {
    try {
      const res = await http.post("", body, extra);
      return { status: res.status, data: res.data };
    } catch (err) {
      if (err instanceof AxiosError) return { status: err.response?.status ?? 0, data: err.response?.data };
      throw err;
    }
  };

  // 1) JSON tools call — dump FULL response
  const r1 = await post({
    model: MODEL,
    messages: [{ role: "user", content: [{ text: "Погода в Москве через get_weather. Ответь кратко." }] }],
    tools: TOOLS,
    stream: false,
  });
  console.log("=== 1) JSON tools: status", r1.status);
  console.log(JSON.stringify(r1.data, null, 1).slice(0, 3000));
  const d1 = r1.data as Record<string, unknown>;
  const msgs = (Array.isArray(d1.messages) ? d1.messages : []) as Array<Record<string, unknown>>;
  const asstMsg = msgs.find((m) => m.role === "assistant");
  const fcItem = (Array.isArray(asstMsg?.content) ? asstMsg?.content : []).find((c) => (c as Record<string, unknown>).function_call) as
    | { function_call?: unknown }
    | undefined;

  // 2) SSE tools call — dump done + delta payloads fully
  const r2 = await post(
    {
      model: MODEL,
      messages: [{ role: "user", content: [{ text: "Погода в Санкт-Петербурге через get_weather. Ответь кратко." }] }],
      tools: TOOLS,
      stream: true,
    },
    { responseType: "text" },
  );
  console.log("\n=== 2) SSE tools: status", r2.status);
  if (typeof r2.data === "string") {
    const frames = r2.data.split(/\r?\n\r?\n/);
    for (const f of frames) {
      const ev = /^event: (\S+)/m.exec(f)?.[1] ?? "(message)";
      const data = /^data: (.*)$/m.exec(f)?.[1];
      console.log(`--- event: ${ev}`);
      if (data !== undefined) {
        try {
          console.log(JSON.stringify(JSON.parse(data), null, 1).slice(0, 1200));
        } catch {
          console.log(data.slice(0, 400));
        }
      }
    }
  } else {
    console.log(JSON.stringify(r2.data, null, 1).slice(0, 1200));
  }

  // 3) second turn attempts
  const states: Array<{ label: string; id: string | undefined }> = [];
  const topState = (d1.functions_state_id ?? d1.tools_state_id) as string | undefined;
  const msgState = (asstMsg?.functions_state_id ?? asstMsg?.tools_state_id) as string | undefined;
  states.push({ label: "from-json-response", id: topState ?? msgState });
  states.push({ label: "synthetic-uuid", id: randomUUID() });

  const toolResult = { function_result: { name: "get_weather", result: '{"city":"Moscow","temperature":20}' } };
  for (const st of states) {
    if (st.id === undefined && st.label === "from-json-response") {
      console.log("\n=== 3a) no state returned by API; skipping real-state turn ===");
      continue;
    }
    const body = {
      model: MODEL,
      messages: [
        { role: "user", content: [{ text: "Погода в Москве через get_weather. Ответь кратко." }] },
        {
          role: "assistant",
          content: fcItem !== undefined ? [fcItem] : [{ function_call: { name: "get_weather", arguments: '{"city":"Moscow"}' } }],
          ...(st.id !== undefined ? { functions_state_id: st.id } : {}),
        },
        { role: "function", content: [toolResult] },
        { role: "user", content: [{ text: "Спасибо. Ответь одним предложением по-русски." }] },
      ],
      tools: TOOLS,
      stream: false,
    };
    const r3 = await post(body);
    console.log(`\n=== 3b) second turn [${st.label}] status ${r3.status}`);
    console.log(JSON.stringify(r3.data, null, 1).slice(0, 1200));
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});