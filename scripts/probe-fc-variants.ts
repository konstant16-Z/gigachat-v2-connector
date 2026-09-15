#!/usr/bin/env bun
import axios, { AxiosError } from "axios";
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
  let credentialsValue: string | undefined = process.env.GIGACHAT_CREDENTIALS;
  if (!credentialsValue) {
    const fs = await import("node:fs");
    const cfg = JSON.parse(fs.readFileSync("/home/zkons/.config/opencode/opencode.json", "utf8")) as {
      plugins?: Array<{ options?: { credentials?: string } }>;
      provider?: Record<string, { options?: { credentials?: string } }>;
    };
    const provider = Object.values(cfg.provider ?? {}).find((p) => p.options?.credentials);
    credentialsValue = provider?.options?.credentials ?? cfg.plugins?.[0]?.options?.credentials;
  }
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

  const r1 = await post({
    model: MODEL,
    messages: [{ role: "user", content: [{ text: "Погода в Москве через get_weather. Ответь кратко." }] }],
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
  console.log("turn1:", r1.status, "state:", stateId ?? "NONE", "fc:", JSON.stringify(fc ?? null));

  if (!fc?.name) {
    console.log("no fc; abort");
    return;
  }
  const objectArgs = typeof fc.arguments === "object" ? (fc.arguments as Record<string, unknown>) : JSON.parse(String(fc.arguments ?? "{}"));
  const stringArgs = JSON.stringify(objectArgs);

  type FcVariant =
    | { id?: string; name: string; arguments: unknown };
  const variants: Array<{ label: string; fc: FcVariant }> = [
    { label: "id+object (echo)", fc: { id: fc.id, name: fc.name, arguments: objectArgs } },
    { label: "id+string", fc: { id: fc.id, name: fc.name, arguments: stringArgs } },
    { label: "no-id+object", fc: { name: fc.name, arguments: objectArgs } },
    { label: "no-id+string (mapper)", fc: { name: fc.name, arguments: stringArgs } },
  ];

  for (const v of variants) {
    const r = await post({
      model: MODEL,
      messages: [
        { role: "user", content: [{ text: "Погода в Москве через get_weather. Ответь кратко." }] },
        {
          role: "assistant",
          content: [{ function_call: v.fc }],
          ...(stateId !== undefined ? { functions_state_id: stateId } : {}),
        },
        {
          role: "function",
          content: [{ function_result: { name: fc.name, result: "{\"city\":\"Moscow\",\"temperature\":20}" } }],
        },
        { role: "user", content: [{ text: "Спасибо. Ответь одним предложением по-русски." }] },
      ],
      tools: TOOLS,
      stream: false,
    });
    console.log(
      `turn2 [${v.label}]: ${r.status} ${r.status >= 200 && r.status < 300 ? `finish=${(r.data as Record<string, unknown>).finish_reason}` : JSON.stringify(r.data).slice(0, 220)}`,
    );
  }
}
main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});